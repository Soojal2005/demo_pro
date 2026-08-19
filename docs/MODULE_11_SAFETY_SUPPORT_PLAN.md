# Module 11 — Safety & Support · Implementation Plan

**Owns:** `SosAlert`, `SupportTicket`, `TicketMessage`
**Folder:** `src/modules/support`
**Depends on:** Booking (evidence), Config (grace window), Notifications
**Status before this plan:** ⬜ not started — the last unbuilt module in
[`MODULE_STATUS_REPORT.md`](MODULE_STATUS_REPORT.md)
**Status now:** ✅ **MVP built, 2026-08-18** — see [§14](#14--what-shipped-in-the-mvp)
for what shipped, what was cut, and where the build departed from this plan.

---

## 0 · Where the code already stands

This module is unusual: **four other modules have already written their half of
it** and are sitting against a stub. Nothing here is greenfield integration
work — it is filling in sockets that exist.

| What exists today                                                                        | Where                                                                                                                                    | What module 11 does to it                                       |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `SUPPORT_PORT` + `NoOpSupportService.raiseBillingTicket()`, logs a warning and returns   | [support.port.ts](../src/modules/payments/ports/support.port.ts)                                                                         | Registers the real implementation — unpaid cash raises a ticket |
| `no_start.graceWindowMinutes`, defined, validated (1–240), and read by **nothing**       | [platform-settings-admin.service.ts:19](../src/modules/admin/platform-settings-admin.service.ts#L19)                                     | The no-start sweep becomes its first consumer                   |
| `PlatformSettingsService` — read-only, city-override-aware, already exported             | [platform-settings.service.ts](../src/modules/bookings/platform-settings.service.ts)                                                     | Reused as-is; no second settings reader                         |
| `BookingsService.reconstruct()` — timeline + photos + chat in one call, already exported | [bookings.service.ts:293](../src/modules/bookings/bookings.service.ts#L293)                                                              | The dispute evidence bundle wraps it; does not reimplement it   |
| `NotificationsService.enqueue(intent, tx)` — global module, transaction-aware            | [notifications.service.ts:62](../src/modules/notifications/notifications.service.ts#L62)                                                 | SOS and ticket events enqueue through it                        |
| Customer/Pro 360 returning `support: { available: false }`                               | [admin-views.service.ts:162](../src/modules/admin/admin-views.service.ts#L162), [:231](../src/modules/admin/admin-views.service.ts#L231) | Replaced with real counts                                       |
| Ledger discrepancy resolution with notes but **no workflow** — deferred here explicitly  | [reconciliation-runner.service.ts:441](../src/modules/ledger/reconciliation-runner.service.ts#L441)                                      | **Stays deferred** — see §12                                    |

`prisma/schema.prisma` has none of the three tables. Nothing is stubbed into
the schema for this module, so the migration is purely additive.

**The one feature this unblocks that has a real-world cost today:** US-4.14 —
_"Arrive but be unable to start"_ — is marked 🟡 with the note _"Every input is
recorded and the grace window is configured. **Nothing watches it**."_ That is
this module's §5.

---

## 1 · Scope

### In

1. Two-sided one-tap SOS (customer + Pro), with live coordinates and a frozen
   booking-context snapshot
2. Ops acknowledgement with a response timestamp, then resolution or
   false-alarm closure
3. SOS out-of-band delivery — it does not queue behind routine traffic (§3.3)
4. Tickets raised by customer, Pro, or the system
5. Five categories: `billing`, `quality`, `dispute`, `app_issue`, `no_start`
6. Threaded conversation with internal-only notes invisible to the raiser
7. Whole-ticket internal mode — `isInternal`, never surfaced to either party
8. Priority, escalation, assignment to a support admin, resolution notes and
   `actionTaken` on close
9. No-start detection: a sweep over `arrived` bookings past the configured
   grace window, raising an internal ticket carrying the window that was applied
10. Dispute evidence bundle: status timeline with coordinates, photo proof,
    route trail, chat log, and the customer's own review photos
11. Registering into module 7's `SUPPORT_PORT`

### Out — and why

| Not building                      | Why                                                                                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin WebSocket namespace for SOS | Deferred by **#63**. Module 15's live dispatch screen polls; SOS uses the same shape plus a push to on-duty admins. Opening a namespace here reverses that decision |
| Ledger discrepancy workflow       | Module 9 §6 defers it "to module 11", but `ReconciliationDiscrepancy` has no ticket FK in the ERD and finance is not the support queue. Recorded, not built         |
| Emergency-services dial-out       | No feature asks for it, and a backend that claims to have called the police and has not is worse than one that does not claim to                                    |
| Ticket CSAT / satisfaction survey | Not in the feature list                                                                                                                                             |
| Auto-refund on an upheld dispute  | The refund is module 7's and the reversal is module 8's. Ops calls the existing endpoints; module 11 records the decision in `resolutionNotes` and `actionTaken`    |
| Acting on `actionTaken` itself    | `service_suspended` / `suspended` are module 6's existing endpoints. Writing the string here **and** suspending from here would be two sources of truth             |

---

## 2 · Data model

Three new tables in `prisma/schema.prisma`, one hand-written migration —
`prisma/migrations/<ts>_add_safety_and_support/migration.sql`, with the `CHECK`
constraints Prisma cannot express, per house style.

### 2.1 `SosAlert`

ERD field-for-field, plus the two deviations in §2.4.

```prisma
model SosAlert {
  id        String   @id @default(uuid()) @db.Uuid
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  /// customer | pro — who pressed the button, not who is at risk
  raisedByType String
  customerId   String?   @db.Uuid
  proId        String?   @db.Uuid
  bookingId    String?   @db.Uuid

  /// Float, matching every other coordinate in this schema (#19)
  lat Float?
  lng Float?

  raisedAt        DateTime @default(now())
  /// Frozen at raise time. Never re-derived — see §3.2
  contextSnapshot Json

  status                String    @default("open")
  acknowledgedByAdminId String?   @db.Uuid
  acknowledgedAt        DateTime?
  resolvedByAdminId     String?   @db.Uuid
  resolvedAt            DateTime?
  resolutionNotes       String?

  @@index([status, raisedAt])
  @@index([bookingId])
  @@map("sos_alerts")
}
```

`CHECK` constraints in the migration:

- `raisedByType IN ('customer','pro')`
- `status IN ('open','acknowledged','resolved','false_alarm')`
- `(raisedByType = 'customer' AND customerId IS NOT NULL) OR (raisedByType = 'pro' AND proId IS NOT NULL)`
- `status <> 'open'` implies `acknowledgedAt IS NOT NULL AND acknowledgedByAdminId IS NOT NULL`
- `status IN ('resolved','false_alarm')` implies `resolvedAt IS NOT NULL AND resolvedByAdminId IS NOT NULL`

The last two are the point of the table. An alert whose status says someone
responded but which carries no name and no timestamp is the exact record that
fails an incident review.

### 2.2 `SupportTicket`

```prisma
model SupportTicket {
  id        String   @id @default(uuid()) @db.Uuid
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  /// customer | pro | system
  raisedByType String
  customerId   String? @db.Uuid
  proId        String? @db.Uuid
  bookingId    String? @db.Uuid

  /// billing | quality | dispute | app_issue | no_start
  category String
  subject  String
  /// low | normal | high | urgent
  priority String @default("normal")
  /// open | in_progress | escalated | resolved | closed
  status   String @default("open")

  /// true = ops-only. Invisible on every non-admin route, at any depth
  isInternal  Boolean @default(false)
  /// System-raised detail — e.g. the grace window that was applied
  contextJson Json?
  /// Idempotency for system-raised tickets. Null for human ones — see §2.4
  systemKey   String? @unique

  assignedAdminId String?   @db.Uuid
  resolutionNotes String?
  /// none | warning | retraining | service_suspended | suspended
  actionTaken     String?
  escalatedAt     DateTime?
  resolvedAt      DateTime?

  messages TicketMessage[]

  @@index([status, priority, createdAt])
  @@index([assignedAdminId, status])
  @@index([bookingId])
  @@index([customerId, createdAt])
  @@index([proId, createdAt])
  @@map("support_tickets")
}
```

`CHECK` constraints:

- Vocabulary bounds on `raisedByType`, `category`, `priority`, `status`, `actionTaken`
- `raisedByType = 'system'` implies `isInternal = true` — the system never
  raises a ticket a customer can answer
- `raisedByType = 'customer'` implies `customerId IS NOT NULL`; same for `pro`
- `status IN ('resolved','closed')` implies `resolvedAt IS NOT NULL AND resolutionNotes IS NOT NULL`
- `category = 'no_start'` implies `bookingId IS NOT NULL`

The resolution constraint mirrors module 10's moderation rule ("reason and
admin id required by a `CHECK`"): closing without saying why is refused by the
database, not only by the service.

### 2.3 `TicketMessage`

```prisma
model TicketMessage {
  id        String   @id @default(uuid()) @db.Uuid
  createdAt DateTime @default(now())

  ticketId String        @db.Uuid
  ticket   SupportTicket @relation(fields: [ticketId], references: [id], onDelete: Cascade)

  /// customer | pro | admin | system
  senderType String
  senderId   String
  body       String
  /// S3 object key, presigned on read — never a public URL. See §2.4
  attachmentUrl String?

  isInternalNote Boolean  @default(false)
  sentAt         DateTime @default(now())

  @@index([ticketId, sentAt])
  @@map("ticket_messages")
}
```

`CHECK`: `senderType IN ('customer','pro','admin','system')`, and
`isInternalNote = true` implies `senderType IN ('admin','system')` — a customer
cannot author a note hidden from themselves, and nothing should ever be able to
construct one.

### 2.4 Deviations from ERD v10 — for `CONFLICTS_AND_DECISIONS.md`

Five, each small and each with a reason. Numbered on merge.

| #   | Deviation                                   | Why                                                                                                                                                                                              |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| a   | `SosAlert.resolvedAt` + `resolvedByAdminId` | The ERD records who **acknowledged** but not who **closed**. Feature 4 makes them two distinct acts and the response-time metric needs both timestamps                                           |
| b   | `SupportTicket.systemKey` unique            | The ERD has no idempotency key. A sweep that runs every few minutes and raises tickets needs one, or the first no-start becomes forty. Same pattern as `PayoutDeduction.dedupeKey`               |
| c   | `SupportTicket.escalatedAt`                 | `status = 'escalated'` with no timestamp cannot answer "how long was it escalated before anyone looked"                                                                                          |
| d   | `TicketMessage.senderType` gains `'system'` | The ERD lists three actors. The auto-close note in §5.4 has no human author, and attributing it to an admin who did nothing is a false record                                                    |
| e   | `attachmentUrl` holds an **S3 key**         | Named as a URL in the ERD; stored and presigned exactly like `JobPhotoProof.photoUrl`, which is also named `...Url` and is also a key. Consistency with the shipped pattern beats the field name |

---

## 3 · SOS — the path, and what "bypasses queuing" means

### 3.1 One tap, one endpoint per actor

`POST /customers/me/sos` and `POST /pros/me/sos`, both taking at most
`{ bookingId?, lat?, lng? }`. Coordinates are optional **by design**: a phone
that cannot get a fix must still be able to raise an alert. A missing pin
degrades the alert; refusing the alert defeats it.

There is no `raisedByType` in either DTO. It comes from the authenticated
actor, the same way `bookingId` ownership does — the alternative is a customer
able to file an alert as a Pro.

`bookingId` is optional and **ownership-checked when present**. A customer
uncomfortable at home may not have a live job at all.

### 3.2 The snapshot is frozen, and that is the whole point

`contextSnapshot` is written once, at raise time, holding: booking number,
status, service, scheduled and arrival times, address text and pin, the
assigned Pro's name, phone and employee code, the customer's name and phone,
and the last known Pro coordinate from the Redis GEO index.

It is **not** re-derived on read. By the time ops opens the alert the booking
may be cancelled, reassigned, or completed, and the state that mattered is the
state at the moment someone pressed the button. This is the same reasoning as
module 8's rate snapshotting: a live join answers a different question than the
one being asked.

Phone numbers are in the snapshot on purpose — an ops admin responding to a
safety alert needs to call someone, and making them open two more screens to
find the number is the failure mode this field exists to prevent. Access is
gated on `safety.sos.respond`, which is not on the default `ops` role's
read-only path.

### 3.3 "Bypasses normal ticket queuing" — three concrete things

Feature 5 is a sentence in the spec; it decomposes into three mechanisms, none
of which is "set a priority field on a ticket".

1. **An SOS is not a ticket at all.** Separate table, separate route, separate
   permission, separate ops screen. It never enters ticket assignment, never
   gets a category, never waits behind a billing query. The queue is not
   jumped; it is not entered.
2. **The notification jumps the outbox.** `NotificationOutbox` is drained
   `orderBy: { createdAt: 'asc' }` with no priority column
   ([notification-worker.service.ts:52](../src/modules/notifications/notification-worker.service.ts#L52)),
   so a backlog of routine pushes would sit in front of an SOS. Fixed by adding
   `priority Int @default(0)` to the outbox and one line —
   `orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }]`. SOS enqueues at
   `100`. **This is a coordination event into module 12** (§10).
   The alternative — calling FCM directly from module 11 — was rejected: it
   trades a one-line ordering change for the loss of retries, fallback channels
   and `NotificationLog`, on the one message in the system that most needs all
   three.
3. **Fan-out is to people, not to a screen.** Every `AdminUser` whose role
   holds `safety.sos.respond` and whose `cityScopeJson` covers the booking's
   city gets a push. If none matches — an alert with no booking, or a city with
   no on-duty responder — it falls back to **all** holders of the permission.
   An unrouted safety alert is worse than an over-broad one.

The alert row and every notification row are written in **one transaction**,
using `enqueue(intent, tx)`, which already accepts one. A committed alert
nobody was told about is the failure this prevents.

### 3.4 Acknowledge, then close

`POST /admin/sos/:id/acknowledge` sets `acknowledgedAt` and the admin id.
Idempotent — a second acknowledgement by anyone returns the first, so two
responders racing produce one record and one response time, not a rewrite.

`POST /admin/sos/:id/resolve` takes `{ outcome: 'resolved' | 'false_alarm', resolutionNotes }`.
Resolution requires a prior acknowledgement — closing something nobody admits
to having seen is refused with `409`.

**Unacknowledged alerts re-notify.** The worker (§5) re-pushes any `open` alert
older than `sos.reNotifyAfterSeconds`, escalating the fan-out to every
permission holder regardless of city scope. Response time —
`acknowledgedAt − raisedAt` — is exposed on the list endpoint, because an
acknowledgement SLA nobody can measure is an acknowledgement SLA nobody meets.

---

## 4 · Tickets

### 4.1 Raising

| Route                                | Actor    | Notes                                                                        |
| ------------------------------------ | -------- | ---------------------------------------------------------------------------- |
| `POST /customers/me/support/tickets` | customer | Categories `billing`, `quality`, `dispute`, `app_issue` — **not** `no_start` |
| `POST /pros/me/support/tickets`      | pro      | Same four                                                                    |
| `POST /admin/support/tickets`        | admin    | On behalf of either party; may set `isInternal`                              |
| `SupportPort.raiseBillingTicket()`   | system   | Module 7's unpaid cash job                                                   |
| No-start sweep                       | system   | §5                                                                           |

`no_start` is refused on both self-service routes with `400`. It is a
system-detected exception by definition, and a customer able to file one would
produce a ticket that looks system-raised and is not.

`bookingId` is ownership-checked when supplied. A `dispute` ticket **requires**
one — a dispute with no job to dispute is a category error, and the evidence
bundle has nothing to assemble.

### 4.2 The two invisibility rules, and where they are enforced

These are the rules most likely to be got wrong, so both are enforced in the
`where` clause rather than by filtering after the fact.

| Rule                                                    | Enforcement                                                                                                                                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An **internal ticket** is invisible to customer and Pro | One private resolver, `findForRaiser(id, actor)`, adds `isInternal: false` **and** the actor's own id to every non-admin query. Every customer/Pro route goes through it — none touches `prisma.supportTicket` directly |
| An **internal note** is invisible to the raiser         | The raiser-facing message include carries `where: { isInternalNote: false }`. The rows are never loaded, so they cannot be leaked by a DTO change later                                                                 |

A not-found internal ticket returns `404`, not `403`. `403` confirms the ticket
exists, which for a quietly-handled no-start incident is exactly the
information feature 13 says the Pro must not have. This matches the ownership
non-disclosure already used on customer addresses.

**Tested by serialise-and-search**, the technique module 10 used for quiz
answer keys: raise a ticket, add an internal note with a known sentinel string,
fetch as the raiser, `JSON.stringify` the whole response and assert the
sentinel does not appear. A test that checks specific fields passes forever
after someone adds an `include`.

### 4.3 Threading

`POST /support/tickets/:id/messages` on all three sides.
`isInternalNote: true` is accepted **only** from an admin — a customer sending
it gets `400`, not a silently downgraded note.

Writes close when a ticket reaches `closed`; reads never do — the same
asymmetry booking chat already uses ([#23](CONFLICTS_AND_DECISIONS.md)). A
`resolved` ticket still accepts replies, and a reply from the raiser reopens it
to `in_progress`. Resolution is ops's opinion that the problem is over; only
the raiser's silence confirms it.

Attachments upload through the existing presigned-S3 flow in `src/storage`,
keys namespaced per ticket, foreign keys rejected — the rule module 4 already
applies to photo proof.

### 4.4 Priority, assignment, escalation

- `priority` is admin-set. Self-service raisers do not choose it — every ticket
  would be `urgent`. System tickets carry a priority set by the raising rule
  (`no_start` → `high`, unpaid cash → `normal`).
- `POST /admin/support/tickets/:id/assign` sets `assignedAdminId` and moves
  `open → in_progress`. Assignment to an admin who lacks
  `support.ticket.manage` is refused — an assignee who cannot act on it is a
  ticket parked forever.
- `POST /admin/support/tickets/:id/escalate` sets `status = 'escalated'`,
  `escalatedAt`, optionally bumps priority and reassigns, and writes a `system`
  `TicketMessage` recording the reason. Escalation that leaves no trace in the
  thread is a status change, not an escalation.
- **SLA escalation is automatic too.** The worker escalates any ticket past
  `support.slaMinutes.<priority>` that is still `open` or `in_progress`. Once
  escalated it is not re-escalated — the sweep is idempotent on `escalatedAt`.

### 4.5 Closing

`POST /admin/support/tickets/:id/resolve` takes `{ resolutionNotes, actionTaken }`.
Both required by the service and by a `CHECK`. `actionTaken` is a **record of a
decision, not an instruction** — module 11 writes the string; suspending a Pro
is module 6's existing endpoint, called separately by the same admin. Two
writers of `Pro.status` is the shape of [#33](CONFLICTS_AND_DECISIONS.md), and
once was enough.

The raiser is notified on resolve. An internal ticket notifies nobody outside
ops — checked in the notification path, not just in the read path.

---

## 5 · No-start detection

Features 11–13, and the module's only background work.

### 5.1 The sweep

`SupportWorkerService`, following the shape
`CommissionWorkerService` already uses: a self-rescheduling `setTimeout`,
`unref`'d, behind a Redis lock so multiple app instances do not all run it.
Interval: 2 minutes — the grace window's floor is 1 minute, and a detector that
runs every 15 would make a 1-minute window mean 16.

Every pass is also an admin endpoint (`POST /admin/support/sweep`), per the
house rule that a background job nobody can trigger is a background job nobody
can test.

### 5.2 The query

```
Booking WHERE status = 'arrived'
  AND startedAt IS NULL
  AND cancelledAt IS NULL
  AND arrivedAt <= now() - (grace window for that booking's city)
```

`arrivedAt` is the **authoritative first arrival** and does not move on an
`en_route → arrived` repeat — module 4 guarantees this, deliberately, so that
"the grace window could be extended indefinitely by a Pro stepping away and
returning" cannot happen
([booking-lifecycle.service.ts:82](../src/modules/bookings/booking-lifecycle.service.ts#L82)).
The sweep inherits that guarantee for free. It also means the dedupe key can be
`no_start:<bookingId>` — one incident per booking, no timestamp component.

The window is read per-city through the existing
`PlatformSettingsService.getNumber('no_start.graceWindowMinutes', 30, cityId)`.
Because the window varies by city, the sweep groups candidates by city rather
than applying one cutoff — a single `now() - 30min` cutoff would silently apply
the wrong window everywhere the default is overridden.

### 5.3 The ticket

```
raisedByType : 'system'
category     : 'no_start'
isInternal   : true          // enforced by CHECK, not only by this code path
priority     : 'high'
subject      : 'No start — HB-2026-000123'
systemKey    : 'no_start:<bookingId>'
contextJson  : { graceWindowMinutes, graceSource: 'city' | 'global' | 'fallback',
                 arrivedAt, cityId, otpAttempts, lastKnownProLat, lastKnownProLng }
```

`graceSource` is there because feature 12 says the ticket carries "the grace
window that was applied", and ops reading `30` cannot tell whether that was
their city's setting or the code's fallback — which is the first thing they ask
when the number looks wrong.

Insert is `INSERT ... ON CONFLICT (systemKey) DO NOTHING` in effect: the unique
index makes "cannot raise twice" a database guarantee rather than a race
between two sweeps.

### 5.4 Never surfaced to the Pro — and it auto-closes

Feature 13 is a **negative** requirement, so it gets a negative test: after the
sweep runs, assert there is **no** `NotificationOutbox` row with
`recipientType = 'pro'` for the `support.no_start.raised` event key, and assert
`GET /pros/me/support/tickets` for that Pro returns an empty list. Both, not
one — the second catches a future read path, the first catches a future
notification template.

**The sweep also closes what fixed itself.** Any open `no_start` ticket whose
booking has since `started`, `completed` or `cancelled` is resolved
automatically with `actionTaken: 'none'`, a `resolutionNotes` line naming what
happened, and a `system` `TicketMessage`. Without this, every OTP delay of more
than the grace window leaves ops a ticket about a job that was already running
by the time they opened it — and a queue of self-resolved tickets is how ops
learns to stop reading the queue.

---

## 6 · Dispute evidence

`GET /admin/support/tickets/:id/evidence`, permission `support.ticket.read`,
available on any ticket carrying a `bookingId`.

It calls `BookingsService.reconstruct(bookingId)` — already built, already
exported, already the answer to US-4.24 — and adds the two things that
reconstruction does not carry:

| Source               | Field                | State today                                                            |
| -------------------- | -------------------- | ---------------------------------------------------------------------- |
| `BookingStatusEvent` | timeline + `lat/lng` | ✅ from `reconstruct()`                                                |
| `JobPhotoProof`      | geo-stamped photos   | ✅ from `reconstruct()`                                                |
| `ChatMessage`        | the thread           | ✅ from `reconstruct()`                                                |
| `Booking.routeTrail` | sampled polyline     | ⏸ **column exists, always null** — module 13 instalment 2 populates it |
| `Review.photoUrls`   | customer's photos    | ✅ added here, `reviewerType = 'customer'` only                        |

`routeTrail` is returned as `{ available: false, reason: '...' }` rather than
`null`, for the same reason module 15's 360 labels its missing sections: an
empty array reads as "the Pro went nowhere", which is a claim, and a wrong one.

Photo and attachment keys are presigned on read with a short expiry. Nothing in
this response is a durable public URL.

**No reimplementation.** `SupportModule` imports `BookingsModule` and calls the
service. A second evidence assembler that drifts from the first is how two
tabs of a dispute screen end up disagreeing.

---

## 7 · Endpoints — 25

### Customer (6) · `JwtAuthGuard` + `ActorTypeGuard`, `@RequireActorType('customer')`

| Method | Path                                         |
| ------ | -------------------------------------------- |
| POST   | `/customers/me/sos`                          |
| GET    | `/customers/me/sos`                          |
| POST   | `/customers/me/support/tickets`              |
| GET    | `/customers/me/support/tickets`              |
| GET    | `/customers/me/support/tickets/:id`          |
| POST   | `/customers/me/support/tickets/:id/messages` |

### Pro (6) — same six, `/pros/me/...`

Identical surface. A Pro's SOS is not a lesser feature than a customer's, and
the symmetry is what feature 2 asks for.

### Admin · SOS (4) — `safety.sos.read` / `safety.sos.respond`

| Method | Path                         | Permission           |
| ------ | ---------------------------- | -------------------- |
| GET    | `/admin/sos`                 | `safety.sos.read`    |
| GET    | `/admin/sos/:id`             | `safety.sos.read`    |
| POST   | `/admin/sos/:id/acknowledge` | `safety.sos.respond` |
| POST   | `/admin/sos/:id/resolve`     | `safety.sos.respond` |

### Admin · tickets (9) — `support.ticket.read` / `support.ticket.manage`

| Method | Path                                  | Permission              |
| ------ | ------------------------------------- | ----------------------- |
| GET    | `/admin/support/tickets`              | `support.ticket.read`   |
| GET    | `/admin/support/tickets/:id`          | `support.ticket.read`   |
| GET    | `/admin/support/tickets/:id/evidence` | `support.ticket.read`   |
| POST   | `/admin/support/tickets`              | `support.ticket.manage` |
| POST   | `/admin/support/tickets/:id/messages` | `support.ticket.manage` |
| POST   | `/admin/support/tickets/:id/assign`   | `support.ticket.manage` |
| POST   | `/admin/support/tickets/:id/escalate` | `support.ticket.manage` |
| POST   | `/admin/support/tickets/:id/resolve`  | `support.ticket.manage` |
| POST   | `/admin/support/sweep`                | `support.ticket.manage` |

All admin routes carry `CityScopeGuard`, scoped through
`booking → address → city`, falling back to the customer's or Pro's own
`cityId` when there is no booking.

**The scope edge, stated rather than papered over:** a ticket with no booking
from a customer with no city — a guest with an app issue — has nothing to scope
on. It is visible to unscoped admins only. Surfacing it to every city admin and
hiding it from all of them are both wrong; this is the smaller wrong, and it is
worth a line in the ops runbook.

---

## 8 · Permissions and settings

### New permission codes — `src/modules/identity/constants/permission-code.ts`

```ts
// --- Module 11 · Safety & Support ------------------------------------
SOS_READ:            'safety.sos.read',
SOS_RESPOND:         'safety.sos.respond',
SUPPORT_TICKET_READ: 'support.ticket.read',
SUPPORT_TICKET_MANAGE: 'support.ticket.manage',
```

Four rather than two. `safety.sos.respond` is separate from
`support.ticket.manage` because the SOS screen carries live phone numbers and
addresses for a person who has said they feel unsafe; that should be a
deliberate grant, not something that rides along with the ability to answer a
billing question. `safety.sos.read` is separate from `respond` for the same
reason `payout.approve` is separate from `payout.disburse`.

Seeding: the `support` role gets all four. `ops` gets both read codes plus
`safety.sos.respond` — ops is who is actually on shift at 9pm. `finance` gets
`support.ticket.read` only.

### New settings — added to module 15's `DEFINITIONS`

| Key                         | Kind    | Range   | Default | Meaning                                    |
| --------------------------- | ------- | ------- | ------- | ------------------------------------------ |
| `sos.reNotifyAfterSeconds`  | integer | 30–3600 | 300     | Re-push an unacknowledged alert after this |
| `support.slaMinutes.urgent` | integer | 5–1440  | 30      | Auto-escalate past this                    |
| `support.slaMinutes.high`   | integer | 5–1440  | 120     |                                            |
| `support.slaMinutes.normal` | integer | 5–10080 | 480     |                                            |
| `support.slaMinutes.low`    | integer | 5–10080 | 2880    |                                            |

`no_start.graceWindowMinutes` already exists and is already validated. Nothing
to add — only a first reader.

### Notification templates (7)

`sos.raised.admin`, `sos.acknowledged.raiser`, `sos.unacknowledged.admin`,
`support.ticket.raised.admin`, `support.ticket.replied.raiser`,
`support.ticket.escalated.admin`, `support.ticket.resolved.raiser`.

Note what is absent: there is no `support.no_start.*` template addressed to a
Pro. That absence is feature 13, and §5.4 asserts it.

---

## 9 · Module wiring

```
src/modules/support/
  support.module.ts
  support.types.ts                       ← vocabularies + SUPPORT_SETTINGS
  sos.service.ts                         ← raise, acknowledge, resolve, fan-out
  sos.controller.ts / admin-sos.controller.ts
  support-tickets.service.ts             ← raise, thread, assign, escalate, resolve
  support-tickets.controller.ts / admin-support-tickets.controller.ts
  no-start-detector.service.ts           ← the sweep, §5
  support-worker.service.ts              ← timer + Redis lock; drives detector, SLA, SOS re-notify
  dispute-evidence.service.ts            ← wraps BookingsService.reconstruct()
  support-port.adapter.ts                ← registers into module 7's SUPPORT_PORT
  dto/  sos.dto.ts  ticket.dto.ts  evidence.dto.ts
```

Imports `IdentityModule`, `BookingsModule`, `PaymentsModule`, `StorageModule`.
`NotificationsModule` is `@Global()` — nothing to import. Registered in
`app.module.ts` after `AdminModule`.

---

## 10 · Coordination events — each its own commit

Per the ownership rule: anything outside `src/modules/support/` is called out
and kept in its own small commit, never folded into a feature change.

| #   | File                                                       | Change                                                                             |
| --- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | `prisma/schema.prisma` + one migration                     | Three new tables, plus back-relations on `Customer`, `Pro`, `Booking`, `AdminUser` |
| 2   | `src/modules/notifications/` + migration                   | `NotificationOutbox.priority`, and the worker's `orderBy` (§3.3)                   |
| 3   | `src/modules/payments/ports/support.port.ts`               | Add `register()` to `NoOpSupportService` — it is the only stub without one         |
| 4   | `src/modules/identity/constants/permission-code.ts` + seed | Four codes, three role grants                                                      |
| 5   | `src/modules/admin/platform-settings-admin.service.ts`     | Five setting definitions                                                           |
| 6   | `src/modules/admin/admin-views.service.ts`                 | Replace the two `available: false` support stubs with real counts                  |
| 7   | `src/app.module.ts`                                        | One import                                                                         |
| 8   | `prisma/seed.ts`                                           | Seven notification templates                                                       |

Event 3 is the one worth flagging to the teammate: `NoOpSupportService` was
written with `useClass` and no delegate, so re-binding `SUPPORT_PORT` inside
`SupportModule` would never reach `CashCollectionService` — Nest resolves
providers per module. This is the same trap documented on
`NoOpCommissionService`, and the fix is the same four lines.

---

## 11 · Order of work

1. Schema + migration + `prisma generate` — everything else compiles against it
2. `support.types.ts` and the DTOs — vocabularies first, so the `CHECK`
   constraints and the validators are written from one list
3. SOS: raise → acknowledge → resolve, with fan-out stubbed to a log
4. Outbox priority (coordination event 2), then wire the real fan-out
5. Tickets: raise, thread, the two invisibility rules and their tests
6. Assign, escalate, resolve
7. No-start detector, run manually through the admin route
8. `SupportWorkerService` — timer, lock, three passes
9. `SUPPORT_PORT` registration; verify the unpaid-cash path end to end
10. Evidence bundle
11. Un-stub the 360s; update `MODULE_STATUS_REPORT.md` and
    `CONFLICTS_AND_DECISIONS.md`

Steps 3–6 are demonstrable without the worker, and steps 7–8 are demonstrable
without the evidence bundle, so the module is reviewable at three points rather
than only at the end.

---

## 12 · Known gaps, before they are built

Recorded now so they are not discovered as surprises later.

| Gap                                                | Why                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routeTrail` is always null in the evidence bundle | Module 13 instalment 2 populates it. The strongest piece of "where did the Pro actually go" evidence is absent, and disputes will be settled without it |
| No real-time SOS delivery to an open ops screen    | #63 defers admin WebSockets. Push + poll is the fallback, and it is slower than a safety alert deserves. Revisit when #63 is                            |
| Ledger discrepancy workflow still unbuilt          | §1. Module 9's gap stays module 9's gap                                                                                                                 |
| No admin audit of ticket actions                   | `AdminAuditLog` is deferred (#63). `assignedAdminId` and the resolver are stored on the row; who **edited** a priority is not recorded                  |
| Nothing chases a stale `acknowledged` alert        | The re-notify sweep covers `open` only. An alert acknowledged and then abandoned sits forever                                                           |
| SOS has no attachment or voice note                | Not in the feature list, and a one-tap button that waits on an upload is not one-tap                                                                    |

---

## 13 · The question I am not answering

**Should a Pro's SOS be visible to the customer, or the customer's to the Pro?**

Neither feature says. The plan builds it as **invisible in both directions** —
an alert is between the raiser and ops — because the alternative has a clear
failure mode: a customer who sees "your Pro has raised a safety alert" now has
a live confrontation, in their own home, that ops has not yet reached. The
reverse is worse.

But it is a product call with a legal edge, not an engineering one, and it is
cheap to change later in one read path. Flagging it rather than deciding it
quietly.

---

## 14 · What shipped in the MVP

**Built 2026-08-18.** ~2,400 lines across `src/modules/support/`, 3 tables, 25
endpoints, 66 unit tests. Full unit suite **1084/1084**, e2e **181/181**.

### 14.1 · Verified against the real database, not only mocked

The migration was **not** applied with `prisma migrate deploy`. `migrate status`
against the shared RDS reported the drift the setup notes warn about — the
teammate's `20260815100000_start_otp_minted_in_house` is applied there and
exists in no branch — so deploying would have been a coordination event nobody
asked for.

Instead the SQL was run inside `BEGIN … ROLLBACK` against the live schema.
Postgres has transactional DDL, so the net effect was nil and every constraint
was exercised for real:

| Verified                                                    | Constraint                                   |
| ----------------------------------------------------------- | -------------------------------------------- |
| The whole migration applies to the deployed schema          | —                                            |
| A system ticket + internal note inserts                     | —                                            |
| The same `systemKey` twice is refused                       | `support_tickets_systemKey_key`              |
| An SOS past `open` must name who acknowledged it            | `sos_alerts_acknowledged_complete_check`     |
| An SOS from a customer must identify the customer           | `sos_alerts_raiser_present_check`            |
| A system-raised ticket cannot be visible to its subject     | `support_tickets_system_is_internal_check`   |
| A `no_start` ticket must name the job                       | `support_tickets_no_start_has_booking_check` |
| A ticket cannot be resolved without notes **and** an action | `support_tickets_resolution_complete_check`  |
| A customer cannot author a note hidden from themselves      | `ticket_messages_internal_note_author_check` |
| The category vocabulary is closed                           | `support_tickets_category_check`             |

**The migration still needs applying**, and that is a coordination event: the
drift has to be reconciled with the teammate first.

### 14.2 · The bug the e2e suite caught that no unit test could

`SupportWorkerService` injects `RedisService`, and `SupportModule` did not
import `RedisModule`. Every unit test passed — they construct the service
directly. `test/module-graph.e2e-spec.ts` compiles the real `AppModule` and
failed at boot, which is exactly the class of mistake it was added for after
the module 3 ↔ 6 `forwardRef` episode. One import line.

### 14.3 · Departures from the plan

| Planned                            | Shipped                                       | Why                                                                                                                                                                                                                             |
| ---------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NotificationOutbox.priority`      | **Cut**                                       | It touches module 12's table and worker — a coordination event on another module for an MVP. Mechanisms 1 and 3 of §3.3 (an SOS is not a ticket; fan-out is direct to responders) still hold, and they are the load-bearing two |
| SLA auto-escalation + its settings | **Cut**; `POST .../escalate` is manual        | Four settings and a sweep to automate a judgement ops makes by hand today                                                                                                                                                       |
| SOS re-notify sweep                | **Cut**                                       | Needs `sos.reNotifyAfterSeconds`; the alert list already sorts open-and-oldest first                                                                                                                                            |
| Attachment upload flow             | Column accepts an S3 key; no presign endpoint | The storage flow exists in `src/storage` and can be wired without a schema change                                                                                                                                               |
| `systemDedupeKey`                  | Named `systemKey`                             | Shorter, and `dedupeKey` already means something narrower on the outbox                                                                                                                                                         |
| 21 endpoints                       | 25                                            | The count in §7 was wrong before this build; the routes themselves are unchanged                                                                                                                                                |

### 14.4 · What is enforced, and by what

| Guarantee                                           | Enforced by                                                                                                                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An internal ticket never reaches its subject        | `raiserScope()` in the `where`, **and** a CHECK making every system ticket internal                                                                                    |
| An internal note is never loaded on a raiser read   | `RAISER_MESSAGE_INCLUDE`'s `where`, **and** a CHECK on who may author one                                                                                              |
| A no-start incident is raised at most once          | `support_tickets_systemKey_key`                                                                                                                                        |
| The Pro is never told about a no-start              | The detector has **no notification dependency at all** — asserted by a test that inspects the injected services, plus the absence of any `support.no_start.*` template |
| An acknowledged alert names a real responder        | Two CHECK constraints                                                                                                                                                  |
| A closed ticket says why                            | The service **and** `support_tickets_resolution_complete_check`                                                                                                        |
| Two responders cannot race the response-time metric | A conditional `updateMany` guarded on `status: 'open'`                                                                                                                 |
| An unpaid cash job cannot fail a completion         | The adapter swallows its own errors, like the stub it replaced                                                                                                         |

### 14.5 · Coordination events, each its own commit

Six files outside `src/modules/support/` were touched. Per the ownership rule
they are called out rather than folded into the feature work:

1. `prisma/schema.prisma` + `20260817120000_add_safety_and_support` — three tables, four sets of back-relations
2. `src/modules/payments/ports/support.port.ts` — `register()` on `NoOpSupportService`, the one stub that lacked the delegate; plus `SUPPORT_PORT` added to the module's exports
3. `src/modules/identity/constants/permission-code.ts` — four codes
4. `prisma/seed.ts` — role grants and five notification templates
5. `src/modules/admin/admin-views.service.ts` and its spec — the two `available: false` support stubs replaced with real counts
6. `src/app.module.ts` — one import, placed after `PaymentsModule` so the port delegate exists to register into

### 14.6 · Still open

- ~~The migration is unapplied.~~ **Applied to the shared RDS on 2026-08-18**
  via `prisma migrate deploy`. Purely additive, so the teammate's uncommitted
  `20260815100000_start_otp_minted_in_house` was untouched — that drift is
  still open and still theirs to push.
- ~~No notification template seeding existed before this module, and
  `booking.start_otp` is enqueuing into failure.~~ **Both claims were wrong.**
  Twelve templates already existed on the shared database, seeded outside
  `prisma/seed.ts`. And `booking.start_otp` / `auth.otp` go through
  `NotificationsService.recordOtpDelivery()`, which writes a `NotificationLog`
  directly and never looks a template up — so they correctly have no template
  row. A full audit of all 16 enqueueable keys against the live table
  ([`audit-notification-templates.js`](../test/manual/audit-notification-templates.js))
  found **no missing and no inactive templates, and no orphan rows.**
  One of the pre-existing rows was already `safety.sos_created`, so this
  module's SOS event **reuses that key** rather than adding
  `safety.sos_raised` beside it.
- `routeTrail` still reports `available: false`; module 13 instalment 2 owns it.
- No admin audit of who changed a ticket's priority — `AdminAuditLog` is still deferred by #63.
- No request-level e2e over the support routes. Coverage is per-query
  assertions plus serialise-and-search, the same position module 10 documented
  in its §16.4.
