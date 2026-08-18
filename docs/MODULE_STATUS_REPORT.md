# Module Status Report

**Date:** 2026-08-14
**Branch:** `homingo-backend-m1`
**Scope:** every module in [`Modules_and_Features 1.md`](Modules_and_Features%201.md), with modules 1, 2, 3, 4 and 6 audited feature-by-feature, gaps closed where they didn't depend on an unbuilt module, and verified by unit tests, e2e tests, a live boot and a full cURL pass.

**Companion documents:**

- [`CONFLICTS_AND_DECISIONS.md`](CONFLICTS_AND_DECISIONS.md) — every contradiction between the source documents and how it was settled. Read it before disputing anything below.
- [`ERD_DATA_MODEL_V10.md`](ERD_DATA_MODEL_V10.md) — reference copy of the authoritative Eraser diagram.
- [`reports/FULL_API_CURL_REPORT_2026-08-10.md`](reports/FULL_API_CURL_REPORT_2026-08-10.md) — **116/116** across all six built modules, and the one defect it found.

**Supersedes** the 2026-08-07 edition. The 2026-08-08 verification pass and the 2026-08-10 module 3 and 4 builds are folded in.

---

## Status at a glance

| #   | Module                    | Owns                                                      | Status                                                                                                                      |
| --- | ------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Identity & Access         | Role, AdminUser                                           | ✅ **Built** — 10/10 features                                                                                               |
| 2   | Customer Profile          | Customer, CustomerAddress                                 | ✅ **Built** — 8/9 features; 1 out of scope per ERD                                                                         |
| 3   | Service Catalog           | ServiceCategory, Service, City                            | ✅ **Built** — 8/8; per-area availability now exists via module 13 (#42)                                                    |
| 4   | Booking & Job Lifecycle   | Booking, RecurringPlan, BookingStatusEvent, …             | ✅ **Built** — 19/22 features; 3 blocked on modules 5/10/13                                                                 |
| 5   | Dispatch Engine           | AssignmentCandidate                                       | ✅ **Built** — 14/16 features (this row was stale; §5 below already said so)                                                |
| 6   | Pro Management            | Pro, ProApplication, ProService, ProBankAccount           | ✅ **Built** — 19/19 features                                                                                               |
| 7   | Payments                  | Order, CashHandover                                       | ✅ **Built** — 17/18 features; handover cadence unresolved by design                                                        |
| 8   | Commission & Payouts      | BookingCommission, CommissionPayout, Incentive, …         | ✅ **Built** — 13/13 features; 2 of 4 incentive types have evaluators (#3.6)                                                |
| 9   | Ledger & Reconciliation   | LedgerEntry, ReconciliationRun, …                         | ✅ **Built** — 9/9 features; variance _trend_ deferred for want of history                                                  |
| 10  | Training & Reviews        | TrainingModule, ProTrainingProgress, Review, …            | ✅ **Built** — 15/15 features; the activation gate ships **off** (#61)                                                      |
| 11  | Safety & Support          | SosAlert, SupportTicket, TicketMessage                    | ✅ **MVP built** 2026-08-18 — 14/14 features; 4 stretch items cut, see §11                                                  |
| 12  | Notifications             | NotificationTemplate, NotificationOutbox, NotificationLog | ✅ **Built** — durable routing, fallbacks, provider status and booking history; partial-PATCH defect fixed 2026-08-18 (§12) |
| 13  | Geo & Routing             | Area, AreaService, ProArea                                | 🟡 **Mostly built** — areas, geocoding, ETA and WebSockets all live                                                         |
| 14  | Config & Server-Driven UI | PlatformSetting, PlatformSettingRevision, UiConfig        | ✅ **Built** — setting history, contextual SDUI, versioning, publish and rollback                                           |
| 15  | Admin Console & Reporting | AdminJob _(audit storage deferred)_                       | 🟡 **Backend core built** — audit and admin WebSockets deferred by #63                                                      |

"Stubbed" means the model exists in `prisma/schema.prisma` because a built module needed it as a foreign key or counter source — not that the module is partly built.

---

## 15 · Admin Console & Reporting — backend core built 2026-08-13

Module 15 reuses the existing admin routes and adds only the missing
cross-module layer: admin context, polling dispatch snapshot, Customer/Pro 360,
validated reassignment, platform-setting management, durable async bulk jobs,
CSV/XLSX/PDF exports, and marketing analytics. `AdminJob` is now a real Prisma
model and private report/error artifacts are downloaded through expiring S3
links.

The current delivery intentionally does **not** add `AdminAuditLog` or an admin
WebSocket namespace (conflict #63). Modules 11 and 12 are still prerequisites
for actual ticket/SOS/notification data; 360 responses label those sections
unavailable rather than presenting misleading emptiness.

---

## 11 · Safety & Support — MVP built 2026-08-18

Two-sided SOS, tickets with internal notes, no-start detection and the dispute
evidence bundle. Plan and post-build notes:
[`MODULE_11_SAFETY_SUPPORT_PLAN.md`](MODULE_11_SAFETY_SUPPORT_PLAN.md).

**This module was mostly sockets, not greenfield.** Four modules had already
written their half against a stub — module 7's `SUPPORT_PORT` logged a warning
and returned; `no_start.graceWindowMinutes` had been defined and validated in
module 15's settings and read by **no code at all**; module 15's 360s returned
`support: { available: false }`; and module 4's `reconstruct()` was built for
US-4.24 with no dispute screen to serve. All four are now filled in.

| #     | Feature                                        | Status                                                                                                                                                                                              |
| ----- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–2   | One-tap SOS from customer **and** Pro          | ✅ Symmetric, six routes each. Coordinates and `bookingId` both optional — a phone with no fix must still be able to raise one                                                                      |
| 3     | Live location + full booking-context snapshot  | ✅ Frozen at raise time, never re-derived; carries both parties' phone numbers behind `safety.sos.respond`                                                                                          |
| 4     | Ops ack with response timestamp, then closure  | ✅ Idempotent ack; `responseSeconds` computed from the two timestamps; two CHECK constraints refuse a response nobody made                                                                          |
| 5     | SOS bypasses ticket queuing                    | 🟡 Two of three mechanisms — it is not a ticket at all, and fan-out goes direct to permission holders in the alert's own transaction. The outbox `priority` column was cut (module 12 coordination) |
| 6     | Tickets from customer, Pro **or** the system   | ✅ Four entry points, including module 7's now-live billing ticket                                                                                                                                  |
| 7     | Five categories                                | ✅ `no_start` refused on both self-service routes — at the DTO and by CHECK                                                                                                                         |
| 8     | Threading with internal-only notes             | ✅ Both invisibility rules live in the `where` clause, never a post-load filter. Serialise-and-search test, as module 10 used for quiz keys                                                         |
| 9     | Priority and escalation                        | 🟡 Manual escalation writes its reason into the thread. **SLA auto-escalation cut**                                                                                                                 |
| 10    | Assignment + resolution notes on close         | ✅ Assignment refuses an admin lacking `support.ticket.manage`; notes and `actionTaken` required by service **and** CHECK                                                                           |
| 11–12 | No-start detection carrying the applied window | ✅ Two-minute sweep; window read **per city**; `graceSource` records whether the number was the city's, the global default, or the fallback                                                         |
| 13    | Never surfaced to the Pro                      | ✅ The detector has **no notification dependency at all**, and no Pro-facing template exists. A test asserts both                                                                                   |
| 14    | Dispute evidence from booking records          | ✅ Wraps `BookingsService.reconstruct()` and adds customer review photos. `routeTrail` reports `available: false` — module 13 owns it                                                               |

### The rule this module is built around

`SupportTicket.isInternal` and `TicketMessage.isInternalNote` are the only
things between ops's private handling of an incident and the person it
concerns. Both are query predicates rather than filters over loaded rows,
because a filter keeps working until somebody adds an `include` and then
quietly stops. A ticket the caller may not see returns **404, not 403** —
`403` confirms it exists, which for a quietly-handled no-start incident is
exactly the fact feature 13 says the Pro must not have.

### Verification

1084/1084 unit, 181/181 e2e, clean boot with all 25 routes mapped. The
migration's ten CHECK constraints were exercised against the **live** RDS
schema inside `BEGIN … ROLLBACK` rather than applied — `migrate status` shows
the shared database still holds the teammate's uncommitted
`20260815100000_start_otp_minted_in_house`, so **applying the migration is a
coordination event, not done here**.

`test/module-graph.e2e-spec.ts` earned its place again: `SupportModule` was
missing `RedisModule`, every unit test passed, and only the real `AppModule`
compile caught it.

### Live cURL verification against AWS RDS — 2026-08-18

Migration applied to the shared RDS with `prisma migrate deploy` (additive
only; the teammate's uncommitted `20260815100000_start_otp_minted_in_house`
was untouched and that drift is still open). Server run against the cloud
database with the mock OTP provider so no real SMS was sent.

**84 of 85 assertions passed** — [`test/manual/run-support-curl.sh`](../test/manual/run-support-curl.sh),
seeded by [`test/manual/seed-support-cloud.js`](../test/manual/seed-support-cloud.js).
Both are idempotent and re-runnable.

The proofs worth naming:

| Proved over live HTTP                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An SOS with a completely empty body is accepted — a phone with no GPS fix can still raise one                                                                     |
| The frozen snapshot carries both parties' phone numbers to ops, and is **absent** from the raiser's own view                                                      |
| Acknowledgement is idempotent — the second call returned the first timestamp unchanged                                                                            |
| Resolving before acknowledging is a `409`                                                                                                                         |
| An internal note with a sentinel string was invisible in the customer's serialised thread and visible to ops                                                      |
| The Pro got `404`, not `403`, for another actor's ticket and for the no-start incident about their own job                                                        |
| The sweep honoured Indore's **120 min** override and stayed silent on a 90-minute-old arrival; dropping it to 15 raised exactly one, tagged `graceSource: "city"` |
| A second sweep raised nothing — `systemKey` holds at the database                                                                                                 |
| Marking the job started made the sweep **close its own incident** as `resolved` / `actionTaken: none`                                                             |
| No `no_start` notification was addressed to anyone, on any channel                                                                                                |

**The one failure was a real pre-existing defect in module 12**, not a bad
test — see below. It is now fixed.

### Two claims from the pre-live write-up that the cloud DB disproved

Recorded because both were asserted with more confidence than the evidence
supported:

1. _"No notification template was ever seeded, by any module."_ Wrong — twelve
   already existed on the shared database, seeded outside `prisma/seed.ts`.
   One was already `safety.sos_created`, so module 11 now **reuses that key**
   instead of shipping a near-duplicate `safety.sos_raised`.
2. _"`booking.start_otp` is enqueuing into failure."_ Wrong — it and `auth.otp`
   go through `recordOtpDelivery()`, which writes a `NotificationLog` directly
   and never resolves a template. An audit of all 16 enqueueable keys against
   the live table found **no missing, no inactive, and no orphan rows**.

### Known gaps

- The teammate's RDS migration drift is still unreconciled.
- Cut for the MVP: outbox priority, SLA auto-escalation, the SOS re-notify
  sweep, and the attachment presign endpoint.

---

## 12 · Notifications — partial template PATCH fixed 2026-08-18

Found by cURL testing against the cloud database, not by the unit suite.

`PATCH /admin/notifications/templates/:key` could not update one field. Sending
`{"channels":["push"]}` against a template that plainly had a title and a body
came back `400 Push templates require title and body`.

The cause is a TypeScript-emit detail rather than a logic error.
`tsconfig.json` targets **ES2023**, which turns on `useDefineForClassFields`,
so a `class` property that is declared but never assigned still exists on the
instance as an **own** enumerable key holding `undefined`. The validation
merge was:

```ts
const candidate = { ...current, ...dto };
```

Every field the caller omitted therefore overwrote the stored value with
`undefined` before `validateTemplate` ran. The database was never corrupted —
Prisma drops `undefined` from an `update` — so it presented purely as a
spurious `400`, which is why it survived to production-shaped data.

The fix drops undefined keys before merging, and the write now uses the same
filtered patch:

```ts
const patch = Object.fromEntries(
  Object.entries(dto).filter(([, value]) => value !== undefined),
);
this.validateTemplate({ ...current, ...patch });
```

**Why the existing tests missed it, and what changed.** Every case in
`notifications.service.spec.ts` passed a plain object literal as the DTO —
`{ isActive: true }` — and an object literal has no undefined own keys, so the
bug was unreachable from the suite. The regression test now constructs a real
`UpdateNotificationTemplateDto` instance, the way the validation pipe does,
and asserts `'pushTitle' in dto` before exercising the update. Reverting the
one-line fix makes it fail.

---

## 1 · Identity & Access — 10/10 built

| #   | Feature                                                       | Status                                                                                                                                  |
| --- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Phone + OTP login/signup, all three actor types               | ✅ No admin self-registration — admins are pre-provisioned                                                                              |
| 2   | OTP dispatch/verify delegated to third party                  | ✅ **Real Synquic Slide provider implemented** (`slide-otp-provider.service.ts`); falls back to the mock until an API key is configured |
| 3   | Guest customer session from device id                         | ✅                                                                                                                                      |
| 4   | Guest → verified upgrade, same customer id preserved          | ✅ Including merge into an existing verified customer, preserving the guest address                                                     |
| 5   | Session issue/refresh/revoke, multi-device                    | ✅ Redis-backed; refresh rotation, replay rejection, logout-all                                                                         |
| 6   | Admin role assignment; permission codes as json array on Role | ✅ Four fixed system roles                                                                                                              |
| 7   | Permission-check middleware on every admin mutation           | ✅ `PermissionsGuard`; revocation takes effect immediately                                                                              |
| 8   | City-scoped admin access                                      | ✅ `CityScopeGuard` — now genuinely exercised (scoped lists, writes, atomic bulk-op denial)                                             |
| 9   | Account block/unblock (customer), suspend/reinstate (Pro)     | ✅ Enforced on existing **and** newly issued sessions                                                                                   |
| 10  | Rate limiting on OTP requests per phone                       | ✅ Plus wrong-code lockout and distinct wrong-reference/wrong-code errors                                                               |

**Closed since 2026-08-07:** Indian national mobile canonicalisation to E.164 before OTP/Redis/persistence (`dto/phone.transform.ts`); rejected-Pro reapplication access; logout-all now provably covered.

---

## 2 · Customer Profile — 8/9 built, 1 out of scope

| #   | Feature                                               | Status                                                                                                                                                                        |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Profile view/edit — name, optional email              | ✅ Email is not an authentication credential                                                                                                                                  |
| 2   | Multiple saved addresses, labelled home/office/other  | ✅ Create/list/edit/delete with ownership non-disclosure                                                                                                                      |
| 3   | Exact coordinate pinning, stored separately from text | ✅ Authoritative coordinates + GeoJSON generation                                                                                                                             |
| 4   | Landmark and free-text delivery notes per address     | ⛔ **Out of scope, not a gap** — the ERD's `CustomerAddress` has `landmark` only. See ERD cross-check                                                                         |
| 5   | Default address selection                             | ✅ Exactly one default, transactional replacement, promotion after deletion                                                                                                   |
| 6   | City resolution from the pinned coordinate            | ✅ **Built this pass** — `address-geocoder.service.ts` + `address-location.service.ts`, with cache, provider rate slot and resolution at save time. Was deferred on module 13 |
| 7   | Serviceability check before booking                   | ✅ `GET /customers/serviceability`; city-level, per the "Geography: city-level only" ground rule                                                                              |
| 8   | Razorpay customer object creation on first payment    | ⏸ Deferred — needs Payments (module 7)                                                                                                                                        |
| 9   | Address edit-history guard (in-flight booking)        | ✅ **Built this pass** — live-booking pin-move/delete guard returns `409`; harmless text corrections still allowed                                                            |

---

## 3 · Service Catalog — 7/8 built, 1 half-cancelled by a ground rule

Built 2026-08-10. `ServiceCategory` and `Service` now exist, field-for-field per ERD v10, and the module owns `City` alongside them.

| #   | Feature                                                  | Status                                                                                                                                                            |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Category tree with nesting, display order, icons         | ✅ `ServiceCategory` with `parentCategoryId`, `sortOrder`, `iconUrl`. **Two levels, enforced** — see [conflict #10](CONFLICTS_AND_DECISIONS.md)                   |
| 2   | Service definitions: name, description, duration, price  | ✅ `durationMinutes` + `flatPrice` `Decimal(12,2)`, one flat national price                                                                                       |
| 3   | Booking-type flags — instant, scheduled, recurring       | ✅ `supportsInstant` / `supportsScheduled` / `supportsRecurring`; an active service must keep at least one on                                                     |
| 4   | Active/inactive at category and service level            | ✅ Both. Services are created as **drafts** and activation is gated (US-3.11)                                                                                     |
| 5   | City registry with timezone; per-city activation         | ✅ Admin CRUD added — `POST/PATCH /admin/catalog/cities` + an activation route. Cities are created dark                                                           |
| 6   | Browse and search endpoints                              | ✅ Tree, category drill-down, filter/search, and by-id resolution                                                                                                 |
| 7   | Duration → Dispatch slot sizing **and Commission tiers** | ✅ / ⛔ — `getDurationMinutes()` is ready for module 5. The commission half is **cancelled** by the ground-rules table, [conflict #7](CONFLICTS_AND_DECISIONS.md) |
| 8   | Catalog feeds the Server-Driven UI home config           | ✅ UI-tree validation resolves active category slugs and service UUIDs before publication                                                                         |

**The two dangling foreign keys are closed.** `ProService.serviceId` and `Booking.serviceId` were bare `String` columns with no FK and no `@db.Uuid`, and nothing validated them — `ProServiceAssignmentsService.assign()` accepted any string, producing Pros competent at services that did not exist. Both are now `@db.Uuid` with `ON DELETE RESTRICT` foreign keys, and the assignment path resolves the id through the catalog first. This was the largest correctness gap in the shipped code.

### API surface

| Public (no auth — the catalogue is what a first-time user sees) |                                             |
| --------------------------------------------------------------- | ------------------------------------------- |
| `GET /cities`                                                   | Unchanged, still live                       |
| `GET /catalog/categories`                                       | Active tree, two levels, with services      |
| `GET /catalog/categories/:id/services`                          | Category drill-down                         |
| `GET /catalog/services`                                         | Filter by `categoryId`, `q`, `bookingType`  |
| `GET /catalog/services/:id`                                     | **Resolves inactive services too** — US-3.1 |

| Admin                                                                                   | Permission               |
| --------------------------------------------------------------------------------------- | ------------------------ |
| `GET/POST /admin/catalog/categories`, `PATCH :id`, `PATCH :id/activation`, `DELETE :id` | `catalog.manage`         |
| `GET/POST /admin/catalog/services`, `PATCH :id`, `PATCH :id/activation`                 | `catalog.manage`         |
| `PATCH /admin/catalog/services/:id/commission`                                          | `catalog.commission.set` |
| `GET/POST /admin/catalog/cities`, `PATCH :id`, `PATCH :id/activation`                   | `catalog.city.manage`    |

Commission is a separate route behind a separate permission so repricing and changing what a Pro earns stay distinct operations (US-3.10, US-8.4). Seeded: `ops` gets `catalog.manage` + `catalog.city.manage`; `finance` gets `catalog.commission.set`.

**Not city-scoped, deliberately.** The catalogue is national by ground rule, so `CityScopeGuard` has nothing to scope on — an Indore ops user editing a price does affect Mumbai. That follows from the pricing model ([conflict #8](CONFLICTS_AND_DECISIONS.md)), and is a product risk worth knowing rather than a bug.

### Rules enforced, each with a test

| Rule                                                                   | Story          |
| ---------------------------------------------------------------------- | -------------- |
| Cannot activate a service with no commission rate → `409`              | US-3.11        |
| `percent` rate capped at 100; `flat` may exceed it (rupees)            | US-3.10        |
| Cannot activate a service under an inactive category → `409`           | US-3.8         |
| Deactivation is unconditional and never cancels sold work              | US-3.7         |
| Cannot delete a category holding children or services → `409`          | US-3.8         |
| Category depth bounded at two levels; no self-parent, no cycles        | —              |
| An active service must keep ≥1 booking type                            | F#3            |
| Price/duration edits touch nothing else — no commission, no `isActive` | US-3.5, US-3.6 |
| Category `slug` unique and immutable after creation                    | —              |

The database carries the same guarantees independently: `CHECK` constraints for the commission range, the active-requires-commission rule and the active-requires-booking-type rule, plus `ON DELETE RESTRICT` behind the orphaning rules.

### User-story audit

Every US-3.x story in [`user-stories-by-persona/`](user-stories-by-persona/), checked against the shipped code rather than against the feature list.

| Story                                                  | Persona | Status                                                                                                                                                                                                                |
| ------------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **US-3.1** Browse categories and services              | C       | ✅ Tree, drill-down and search. Edge — inactive services vanish from browse but stay resolvable by id — implemented and tested                                                                                        |
| **US-3.2** See one flat price                          | C       | ✅ for the catalog's part: `flatPrice` on browse, and the platform/Pro split is absent from `ServiceDto` (asserted in the Swagger test). The "same number on booking summary, invoice and history" half is module 4's |
| **US-3.3** Home screen without an app update           | C/A     | ✅ Module 14 publishes versioned, contextual JSON trees through CloudFront; category references are validated before publication                                                                                      |
| **US-3.4** Create a service                            | A       | ✅ **with a deviation** — commission is a second call, see [conflict #17](CONFLICTS_AND_DECISIONS.md). Edge (one flat national price) holds                                                                           |
| **US-3.5** Change a service price                      | A       | 🟡 Price edit works and provably touches nothing else. **"Audited" is not satisfied** — no attribution exists ([#9](CONFLICTS_AND_DECISIONS.md), [#14](CONFLICTS_AND_DECISIONS.md))                                   |
| **US-3.6** Change a service duration                   | A       | ✅ Edit works; nothing cascades. "Does not resize bookings already placed" is guaranteed by module 4 snapshotting, which is not built                                                                                 |
| **US-3.7** Deactivate a service with live bookings     | A       | ✅ Deactivation is unconditional and cascades nowhere, tested. Fully demonstrable only once bookings exist                                                                                                            |
| **US-3.8** Restructure the category tree               | A       | ✅ Reparent, activate, delete. Orphaning blocked twice over — a `409` with a readable message, and `ON DELETE RESTRICT` beneath it                                                                                    |
| **US-3.9** Activate a new city                         | A       | ✅ **Gap found in this audit and closed** — see below                                                                                                                                                                 |
| **US-3.10** Set a commission rate                      | A/P     | ✅ Own endpoint, own permission, range-validated. "Future completions only" is inherent: nothing rewrites history                                                                                                     |
| **US-3.11** Activate a service with no commission rate | A/S     | ✅ Blocked in the service layer **and** by a `CHECK` constraint                                                                                                                                                       |
| **US-8.4** Reprice without touching commission         | A/P     | ✅ Separate routes; a test asserts a price update never writes the commission columns. The "ops must see which mode" half is a UI requirement                                                                         |
| **US-8.8** Discover a service with no commission rate  | S/A     | ✅ Made unreachable by US-3.11's two layers, which is what the story asks for                                                                                                                                         |

**US-3.9's edge case was missing.** The story reads: _"Activating a city with no approved Pros in it produces bookings nobody can serve. **Gate on supply.**"_ Nothing checked. Launching a city now returns `409 CITY_HAS_NO_SUPPLY` when no approved Pro is based there, overridable with `acknowledgeNoSupply: true` — a gate, not a prohibition, since opening a city ahead of the first approved cohort is legitimate. Pausing a city is never gated.

That check needs Pro counts inside a Catalog operation, while Pro Management needs the catalogue to validate service assignments — a genuinely bidirectional dependency, wired with `forwardRef` on both sides. [`test/module-graph.e2e-spec.ts`](../test/module-graph.e2e-spec.ts) compiles the real `AppModule` and asserts both injections resolve, because a `forwardRef` mistake is invisible to unit tests and surfaces only at boot.

### Known gaps in this module

- **No audit of catalog edits at all.** Not even "who last touched this row" — ERD v10 gives the catalog tables no editor column, and `AdminAuditLog` is deferred. See [conflicts #9 and #14](CONFLICTS_AND_DECISIONS.md). This is the sharpest open gap here.
- **No per-service cash flag.** The Cash ground rule names `Service.allowsCash`; the ERD has no such column, so it was not added ([conflict #13](CONFLICTS_AND_DECISIONS.md)).
- **Search is a sequential scan**, deliberately — a few hundred national rows do not justify `pg_trgm`, which needs a `CREATE EXTENSION` privilege the RDS app role may not have.

📋 [`MODULE_3_SERVICE_CATALOG_PLAN.md`](MODULE_3_SERVICE_CATALOG_PLAN.md) is the plan this was built from. **Its §3 schema is superseded** by the ERD reconciliation — see [conflict #15](CONFLICTS_AND_DECISIONS.md) for the seven field names that changed.

---

## 4 · Booking & Job Lifecycle — 19/22 built

Built 2026-08-10. The largest module in the system: 5 tables, 29 endpoints, and the state machine every other module reads from.

**A cash job runs end to end today** — create → assign → en route → arrived → start OTP → completed → invoice. Online bookings stop at `awaiting_payment` behind a port, because Payments (module 7) does not exist. That line comes from the Cash ground rule, not from cutting scope: a cash booking has no `Order` row and skips `awaiting_payment` by design.

_Creation (6/7)_

| #   | Feature                                   | Status                                                                                                                         |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Instant booking, dispatch immediately     | ✅ Created and handed to the dispatch port. **Assignment itself is manual** until module 5 — `POST /admin/bookings/:id/assign` |
| 2   | Scheduled booking from real availability  | 🟡 Slots are accepted, validated as future-dated and stored; they are **not** checked against real Pro availability            |
| 3   | Recurring plans, auto-generating bookings | ✅ daily/weekly/biweekly/monthly, with a generator that is deliberately tolerant of one plan failing                           |
| 4   | Slot availability query                   | ⏸ Module 5 — `DispatchPort.getAvailableSlots()` returns `[]` rather than inventing slots nobody can work                       |
| 5   | Flat price quoted and frozen              | ✅ Read from the catalogue at creation, never recomputed. Closes [conflict #11](CONFLICTS_AND_DECISIONS.md)                    |
| 6   | One-tap rebook                            | ✅ Copies service and address, records lineage, **never pins the Pro** — rotation wins                                         |
| 7   | Human-readable booking number             | ✅ `HB-2026-000123` from a Postgres sequence, mirroring `employeeCode`                                                         |
| —   | _(US-4.6)_ Abandoned checkouts expire     | ✅ `POST /admin/bookings/expire-unpaid` sweeps `awaiting_payment` past the hold window. Window A, so nothing is refunded       |

_Lifecycle (3/3)_

| #   | Feature                         | Status                                                                                                                         |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 8   | State machine with cancellation | ✅ As a transition table, not an ordered list — payment mode forks it ([#20](CONFLICTS_AND_DECISIONS.md)). All 81 pairs tested |
| 9   | Append-only status event log    | ✅ Actor, timestamp **and coordinates**, written in the same transaction as the status change                                  |
| 10  | Repeat transitions preserved    | ✅ `en_route ⇄ arrived` repeats freely; `arrivedAt` holds the authoritative first arrival                                      |

_Service-start OTP (4/4)_

| #   | Feature                              | Status                                                                                                          |
| --- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| 11  | OTP issued on arrival                | ✅ Sent to the **customer's** phone, reusing module 1's `SlideOtpProvider` — no new integration                 |
| 12  | Pro enters it; third-party verify    | ✅ Verification is the provider's answer, never the app's claim                                                 |
| 13  | Only a verified OTP sets `startedAt` | ✅ Enforced in code **and** by a `CHECK` constraint. The one documented exception is an audited ops force-start |
| 14  | Attempt counting + provider ref      | ✅ A wrong code counts an attempt and deliberately does **not** pause the grace clock                           |

_Execution (3/5)_

| #   | Feature                             | Status                                                                                                                                    |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 15  | Live tracking (position + ETA)      | 🟡 `GET /bookings/:id/tracking` reads the Pro GEO index, falls back to the cold flush, and reports `isStale`. **ETA is null** — module 13 |
| 16  | In-app chat scoped to the booking   | ✅ No contact detail in any chat DTO, asserted in the Swagger test. Writes close 24h after completion; reads never                        |
| 17  | Mandatory geo-stamped photo proof   | ✅ Completion is **refused** without at least one completion photo. Keys namespaced per booking                                           |
| 18  | Actual duration from verified start | ✅ Computed and stored — **reporting only**. The "commission is calculated from" clause is [cancelled](CONFLICTS_AND_DECISIONS.md)        |
| 19  | Route trail at completion           | ⏸ Module 13 — nothing accumulates a GPS trail today. Column exists, deliberately left null                                                |

_Close-out (2/3)_

| #   | Feature                        | Status                                                                                              |
| --- | ------------------------------ | --------------------------------------------------------------------------------------------------- |
| 20  | Cancellation with reason/actor | ✅ All six windows. Fee and refund resolved from the window; window E routes to a human             |
| 21  | Invoice on the booking         | 🟡 Number, tax and `invoicedAt` generated at completion. **PDF deferred** — nothing renders one yet |
| 22  | Booking history and live views | ✅ Customer history + live orders, Pro job list, and the one-call admin reconstruction              |

### The state machine

```
                 ┌─ cash ──────────────────────────┐
created ─────────┤                                 ├──> assigning ──> assigned
                 └─ online ──> awaiting_payment ───┘                     │
                                                                         v
completed <── started <── arrived <──> en_route <────────────────────────┘
```

`cancelled` is reachable from every live state and from none of the terminal ones. `completed` is terminal — a finished job is disputed, never cancelled.

### Rules enforced, each with a test

| Rule                                                                        | Source           |
| --------------------------------------------------------------------------- | ---------------- |
| Price frozen at creation; never recomputed                                  | US-3.2, US-3.5   |
| `paymentMode` frozen; cash and online take different paths out of `created` | Cash ground rule |
| Only a provider-verified OTP or an audited ops force-start sets `startedAt` | US-4.12          |
| A failed OTP counts an attempt and does not pause the grace clock           | US-4.13          |
| Completion refused without a verified start                                 | F#13             |
| Completion refused without ≥1 completion photo                              | US-4.16          |
| A Pro has no cancellation route at any depth                                | Principle 2      |
| Cancelling after `started` is ops-only                                      | US-4.21          |
| No fee when the platform is the party that failed                           | US-4.22          |
| Photo keys namespaced per booking; foreign keys rejected                    | —                |
| Booking creation idempotent per `Idempotency-Key`                           | Cross-cutting    |
| Chat writes close after completion; reads never                             | US-4.8           |

The database carries its own guarantees independently: `CHECK` constraints bound every enum-ish column, and refuse a `started` booking with no `startedAt`, a `completed` one with no `completedAt`, or a `cancelled` one with no `cancelledAt`. `cancelledByType` is constrained to `customer | ops | system` — a Pro cannot be recorded as a canceller even by a future code path.

### The two ports

Module 4 owns interfaces for the two modules it needs that do not exist, so every code path around them is written and tested now:

| Port           | For      | No-op behaviour                                                                        |
| -------------- | -------- | -------------------------------------------------------------------------------------- |
| `DispatchPort` | Module 5 | Leaves the booking in `assigning`; returns **no** slots rather than inventing them     |
| `PaymentsPort` | Module 7 | `createOrder` fails loudly with `501`; a fake order id would strand a booking silently |

Swapping in the real modules is two `provide` lines in `bookings.module.ts` and nothing else.

### User-story audit

All 24 US-4.x stories across the three personas, checked against the shipped code rather than the feature list.

| Story                                           | Persona | Status                                                                                                                                                                               |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **US-4.1** Book an instant service              | C       | ✅ Edge honoured in reverse — a cash booking dispatches before money moves, so "charging then failing to assign" cannot happen. For online, nothing is charged until Payments exists |
| **US-4.2** Pick a scheduled slot                | C       | 🟡 Slot accepted, future-dated and stored; **not validated against real availability**. Over-selling is unguarded — module 5                                                         |
| **US-4.3** Recurring cleaning                   | C       | ✅ Including the edge that matters most: a failed occurrence **never deactivates the plan**, only the plan's own end date does                                                       |
| **US-4.5** Rebook a past service                | C       | ✅ Lineage recorded, Pro never pinned ([#22](CONFLICTS_AND_DECISIONS.md))                                                                                                            |
| **US-4.6** Abandon checkout                     | C/S     | ✅ **Gap found in this audit and closed** — the hold-window sweep had no caller. Pay-after-expiry is module 7's webhook                                                              |
| **US-4.7** Watch the Pro approach               | C       | ✅ **Gap found in this audit and closed** — the endpoint was planned but never built. `isStale` implemented; ETA is module 13                                                        |
| **US-4.8** Message the Pro                      | C/P     | ✅ No contact detail in the schema, asserted in the Swagger test. Chat closes ([#23](CONFLICTS_AND_DECISIONS.md))                                                                    |
| **US-4.9** Mark en route                        | P       | ✅ Repeatable; every leg survives in the log                                                                                                                                         |
| **US-4.10** Mark arrival                        | P       | ✅ `arrivedAt` is the authoritative first arrival; coordinates recorded wherever the Pro actually is                                                                                 |
| **US-4.11** Receive the start OTP               | C       | ✅ Sent to the customer's phone, plus a self-service resend. The override is [#25](CONFLICTS_AND_DECISIONS.md)                                                                       |
| **US-4.12** Enter the customer's OTP            | P       | ✅ The provider's answer, never the app's claim                                                                                                                                      |
| **US-4.13** Mistype the OTP                     | P       | ✅ Attempt counted, `startedAt` stays null, **grace clock keeps running**, resend offered past the max                                                                               |
| **US-4.14** Arrive but be unable to start       | P/A/S   | 🟡 Every input is recorded and the grace window is configured. **Nothing watches it** — the `no_start` ticket needs module 11                                                        |
| **US-4.15** Not be home when they arrive        | C/P/A   | ✅ for module 4's part — arrival and failed start recorded, ops decides. Charging stays a policy call ([#24](CONFLICTS_AND_DECISIONS.md))                                            |
| **US-4.16** Complete with photo proof           | P       | ✅ Completion refused without one                                                                                                                                                    |
| **US-4.17** Work as long as the job takes       | P       | ✅ Duration recorded; commission unchanged ([#18](CONFLICTS_AND_DECISIONS.md))                                                                                                       |
| **US-4.18** Rate the job                        | C       | ✅ **Built in module 10** — `POST /bookings/:bookingId/review`, within 14 days, immutable once written                                                                               |
| **US-4.19** Cancel before anyone is assigned    | C       | ✅ Windows A/B, full refund                                                                                                                                                          |
| **US-4.20** Cancel while the Pro is on the way  | C       | ✅ Window D closes the assignment and the notification outbox alerts both customer and assigned Pro                                                                                  |
| **US-4.21** Stop work that's going wrong        | C/A     | ✅ Ops-only, discretionary refund, never a formula                                                                                                                                   |
| **US-4.22** Cancelled because nobody could come | A/C/S   | ✅ Full refund, no fee — enforced in code, not configurable                                                                                                                          |
| **US-4.23** Two services for the same morning   | C       | ✅ Two independent bookings, no interaction. Rotation across them is module 5's                                                                                                      |
| **US-4.24** Reconstruct a disputed job          | A       | ✅ Timeline, photos and chat in **one** call, as the story demands                                                                                                                   |

**Two gaps were found by this audit and closed.** `GET /bookings/:id/tracking` was in the plan's §4.1 and never built, and `cancelAsSystem` existed with no caller — the payment-hold setting was seeded but nothing read it. Both now ship with Swagger coverage.

### Known gaps in this module

- **No automatic assignment.** Ops assigns by hand. This is module 5's job and the route survives as the US-5.14 override once it exists.
- **Scheduled slots are unvalidated.** A customer can pick a time nobody is free for; dispatch resolves supply afterwards, which is what US-4.2 describes, but there is no over-selling guard.
- **No push notifications on any transition** (module 12), so a Pro is not yet told a job was cancelled under them — US-4.20's edge, and the one gap with a real-world cost today.
- **No `no_start` ticket** (module 11). The grace window is configured but nothing watches it.
- **No invoice PDF.**

📋 Built from [`MODULE_4_BOOKING_LIFECYCLE_PLAN.md`](MODULE_4_BOOKING_LIFECYCLE_PLAN.md). Nine of its §2 items became [conflicts #18–#28](CONFLICTS_AND_DECISIONS.md).

---

## 5 · Dispatch Engine — 14/16 built

Built 2026-08-10. **Bookings now assign themselves.** Module 4's `DispatchPort` was already defined and stubbed, so the integration was registering one adapter — module 4 is unchanged.

| #   | Feature                                      | Status                                                                                                                                |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Redis-queued intake, one job per booking     | ✅ A real Redis list. Drained by an admin route — there is still no job runner ([#30](CONFLICTS_AND_DECISIONS.md))                    |
| 2   | Distributed lock per booking (`SET NX PX`)   | ✅ Released in a `finally`, so a thrown attempt cannot wedge a booking                                                                |
| 3   | Rule 1 — availability                        | ✅ Active `ProService` + `approved` + `isAvailable` + a free window. All three gates admin-set                                        |
| 4   | Free windows from committed bookings alone   | ✅ No roster involved; cached in Redis per Pro per day                                                                                |
| 5   | Travel origin resolution                     | ✅ Next job's address → live GPS → home base, and **which one was used is recorded** so US-5.7 stays answerable                       |
| 6   | Rule 2 — proximity                           | 🟡 Ranks correctly on straight-line time. Real road time is module 13 ([#29](CONFLICTS_AND_DECISIONS.md))                             |
| 7   | Rule 3 — rotation                            | ✅ Indexed over `Booking(addressId, proId, completedAt)`, cooldown from `PlatformSetting`. A **penalty, not an exclusion**            |
| 8   | Rule 4 — tie-break                           | ✅ Duration fit → smoothed rating → fewest offers today → lowest `Pro.id`. Deterministic to the last step                             |
| 9   | Smoothed rating / cold start                 | ✅ `(ratingSum + priorMean × priorWeight) / (ratingCount + priorWeight)`. **`acceptanceRate` is not an input**, and a test asserts it |
| 10  | Every candidate persisted with score inputs  | ✅ 11 new columns. Excluded Pros get a row with a null `rank`, so "never a candidate" ≠ "ranked and lost"                             |
| 11  | Assignment written to booking; counters move | ✅ `assignmentsOffered` increments — **it never did before**, see below                                                               |
| 12  | Acknowledgement window                       | ✅ Receipt, not agreement. Idempotent                                                                                                 |
| 13  | No-ack retry with `already_tried` exclusion  | ✅ Their acceptance rate moves; their ranking does not                                                                                |
| 14  | Ops manual override                          | ✅ Built in module 4 (`POST /admin/bookings/:id/assign`), reason mandatory                                                            |
| 15  | ETA computation, published continuously      | ⏸ Modules 12 + 13. Straight-line time is good enough to rank, **not to quote**                                                        |
| 16  | Unassignable bookings surfaced to ops        | ✅ `no_supply` and `exhausted` kept distinct ([#31](CONFLICTS_AND_DECISIONS.md))                                                      |

### A fourth counter bug, and the pattern behind all of them

Wiring a real caller to `ProCountersService` exposed a **third and fourth** instance of one pattern: three of its four methods were written before modules 4 and 5 existed, so each owned the _transition_ as well as the counter. Each broke silently as its real caller arrived — see [conflict #33](CONFLICTS_AND_DECISIONS.md) for the table.

`recordOffer` used the winner's candidate row as its idempotency guard; the engine writes that row first (it holds the score inputs), so the counter always returned early and `assignmentsOffered` stayed at zero while `assignmentsAcknowledged` climbed. Live verification caught it: `offered=0 acked=1` is not a state that can occur. After the fix, `offered=1 acked=1 acceptanceRate=1.00`.

**`recordReview` is the one method that has still never run** — and now never will. Module 10 owns review writing in `src/modules/reviews`, because the rule it encodes had grown a second direction, a submission window, a photo cap and a customer counter. It is marked `@deprecated` and is module 6's to delete; a dead duplicate of a live rule is exactly the shape of [#56](CONFLICTS_AND_DECISIONS.md).

The risk it carried landed anyway, one layer down. `rebuildAll` summed **every** row in `reviews` grouped by `proId`, which was right until a Pro could author one — see [#61](CONFLICTS_AND_DECISIONS.md).

### Live verification

`test/manual/run-dispatch-curl.sh` — **19/19 against the local database**: booking queued, drained, assigned automatically, ack window opened, candidate scores persisted with the travel origin (`home_base`) and smoothed rating, acknowledged idempotently, and **no accept or decline route at any depth**.

Rule 1 was also confirmed working the hard way: a run reported `exhausted` because the test Pro genuinely had two overlapping committed bookings, and another reported `no_supply` because the Pro held a different service than the one booked. Both were the engine being right about bad test data.

---

## 6 · Pro Management — 19/19 built

_Onboarding (8/8)_

| #   | Feature                                                      | Status                                                                         |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 1   | In-app self-application, referral attribution                | ✅                                                                             |
| 2   | Aadhaar/PAN manual document capture                          | ✅ Manual S3 presigned upload + human review; DigiLocker deliberately excluded |
| 3   | Independent verification per document                        | ✅ With per-document correction messages                                       |
| 4   | Admin queue: pending → docs review → call pending → decision | ✅ `queueStatus`                                                               |
| 5   | Verification call logging                                    | ✅                                                                             |
| 6   | Approve/reject with reason                                   | ✅                                                                             |
| 7   | Re-application supported, history preserved                  | ✅ Rejected applicants authenticate but stay non-dispatchable                  |
| 8   | Activation gate: only approved Pros visible to dispatch      | ✅ as far as this module goes — dispatch (M5) doesn't exist to consume it      |

_Profile & capability (5/5)_

| #   | Feature                                 | Status                                                                                                                                         |
| --- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | Employee code + recorded monthly salary | ✅ `employeeCode` auto-generates on approval via a Postgres sequence; `PATCH /admin/pros/:id/profile` sets salary                              |
| 10  | Home base coordinate                    | ✅                                                                                                                                             |
| 11  | Service assignment with proficiency     | ✅ — `serviceId` now validated against the catalogue, and a real FK. A **draft** service is accepted, since Pros are trained ahead of a launch |
| 12  | Per-service suspension                  | ✅                                                                                                                                             |
| 13  | Bank account details                    | ✅ Masked storage, one-primary behaviour, self-verification rejected                                                                           |

_Operations (6/6)_

| #   | Feature                                                         | Status                                                                                                     |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 14  | Availability toggle, admin-only                                 | ✅                                                                                                         |
| 15  | Admin roster screen (filterable, bulk on/off)                   | ✅                                                                                                         |
| 16  | Live location ingest into Redis GEO + cold flush                | ✅ `POST /pros/me/location`                                                                                |
| 17  | Status lifecycle: applied → under_review → approved → suspended | ✅ Plus `rejected`; three-gate reinstatement and non-dispatchability enforced                              |
| 18  | Acceptance rate, counters rebuilt nightly                       | 🟡 `ProCountersService` is built and exact; nothing calls it yet because Dispatch (M5) is the caller       |
| 19  | Pro-facing profile/rating/acceptance/history views              | ✅ `ProStandingService`; earnings/commission/payout views read correctly and stay readable while suspended |

**Closed since 2026-08-07:** KYC `pg_advisory_xact_lock` 500 (Prisma non-result execution); controlled per-Pro private-S3 profile-photo upload + attach flow; server-side masked-format enforcement for bank and Aadhaar values; legal name/DOB/gender copied from verified KYC on approval and locked against self-service mutation; public/private profile separation with a Pro-owned-field allow-list.

---

## 7 · Payments — 17/18 built

Owns `Order` and `CashHandover`, plus the cash columns on `Booking` and
`Pro.cashInHand`. Registers itself into module 4's `PAYMENTS_PORT` delegate at
boot, and **only when Razorpay credentials are present** — with none set the app
boots, cash runs end to end, and online bookings return module 4's honest 501.

### Online

| #   | Feature                                                          | Status                                                                                                                              |
| --- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Order created server-side before checkout, booking refs in notes | ✅ Amount read from `Booking.flatPrice`, never from the request. Notes carry booking, service, city                                 |
| 2   | Checkout handoff with the order id                               | ✅ Publishable key id only; the key secret never leaves the server                                                                  |
| 3   | Server-side signature verification before any success            | ✅ **And the signature alone is not trusted** — the payment is then fetched and its status, order and amount asserted. Conflict #41 |
| 4   | Webhook for authorized / captured / failed / refunded            | ✅ Six events; anything else is acknowledged and ignored so an ops dashboard change cannot break us                                 |
| 5   | Idempotent webhook processing                                    | ✅ Convergent writes + forward-only status; Redis is a fast path correctness does not use. Conflict #40                             |
| 6   | On capture: status, capturedPaymentId, paymentMethod, paidAt     | ✅ Written once. A different payment id on a paid order is refused and logged, never overwritten                                    |
| 7   | `attempts` / `failureCode` mirrored; full list from Razorpay     | ✅ `GET /admin/orders/:id/attempts` fetches live and stores nothing                                                                 |
| 8   | Full and partial refunds, both states, gateway ref captured      | ✅ `initiated` on the call, `settled` on `refund.processed`. `refundAmount` cumulative; `failed` leaves it standing                 |
| 9   | Saved instruments via the gateway customer object                | ✅ Only `razorpayCustomerId` is stored. Degrades rather than failing checkout if creation fails                                     |
| 10  | Reconciliation against Razorpay by order id                      | ✅ Computed, not persisted — `ReconciliationRun` is module 9's. Nothing is auto-corrected                                           |

### Cash

| #   | Feature                                                        | Status                                                                                                            |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 11  | Mode gated on `Service.allowsCash` + city setting              | ✅ Both server-side, asked at creation because `paymentMode` is frozen there. **Reverses conflict #13** — see #37 |
| 12  | Cash skips `awaiting_payment` and dispatches immediately       | ✅ Already module 4's fork; unchanged                                                                             |
| 13  | Collection at the door; amount not editable                    | ✅ **No amount parameter exists**, and a CHECK constraint enforces `= flatPrice`                                  |
| 14  | `Pro.cashInHand` accumulates; ledger to `cash_in_hand:<proId>` | 🟡 Balance built and moved transactionally. Ledger rows wait on module 9 via `LedgerPort`                         |
| 15  | Recovery by handover, never by netting                         | ✅ Declare → confirm, two actors. The balance moves by what was **counted**, not what was declared                |
| 16  | Cash ceiling stops cash assignment                             | ✅ Module 5 excludes over-ceiling Pros from **cash bookings only** — online work is unaffected                    |
| 17  | Unpaid completion still completes and still pays commission    | ✅ Booking columns are the durable record; ticket delivery waits on module 11 via `SupportPort`                   |
| 18  | Cash reconciliation: completed vs collected, balance vs ledger | ✅ Both checks. The balance check is what proves the `cashInHand` cache still agrees with its source              |

**The one genuinely open item is not a feature.** Conflict #36(4): the ceiling
caps each Pro's exposure but nothing **recovers** it. No mechanism chases a Pro
who simply never declares a handover, and the cadence that would define one is
undefined in the source documents too. Recorded rather than papered over.

**Coordination events in this module** — each its own commit, per the ownership
rule: `rawBody: true` in `main.ts` (#38); `register()` + `assertCashAllowed` on
module 4's payments port; `Service.allowsCash` and its own migration (#37);
`allowsCash` added to `toPublicService`; one optional parameter on module 5's
`findEligiblePros`; three permission codes in module 1's constants.

---

## 8 · Commission & Payouts — 13/13 built

**Date built:** 2026-08-12. Plan: [`MODULE_8_COMMISSION_PAYOUTS_PLAN.md`](MODULE_8_COMMISSION_PAYOUTS_PLAN.md).
Conflicts settled: **#45** (salary), **#51** (masked bank account), **#52**
(who "commission" names), **#53** (incentive contributions), **#54**
(recurring bonuses).

| #   | Feature                                       | Status                                                                                                                    |
| --- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Commission rate on the service, finance-only  | ✅ Already in module 3 — `catalog.commission.set`, and activation is gated on it                                          |
| 2   | Percent or flat                               | ✅ Integer-paise arithmetic; the two shares provably sum to the price (CHECK constraint)                                  |
| 3   | Computed the moment the job completes         | ✅ `COMMISSION_PORT` on module 4, beside `recordCompletion`, non-fatal                                                    |
| 4   | Rate snapshotting                             | ✅ Type and value copied onto the row; the live `Service` is never re-read                                                |
| 5   | Platform and Pro share both recorded          | ✅ `platformAmount` is always the remainder, never computed independently                                                 |
| 6   | Deductions applied per job                    | ✅ `POST /admin/commissions/:id/deduction`, mirrored onto the row for display                                             |
| 7   | Incentive schemes with criteria and reward    | 🟡 All four types configurable; **`jobs_count` and `rating` have evaluators**, the other two report `hasEvaluator: false` |
| 8   | Progress tracked, credited against the job    | ✅ `ProIncentiveContribution` — one row per job, progress is their sum (#53)                                              |
| 9   | Live earnings in the Pro app                  | ✅ Direct reads of rows the completion hook writes synchronously; no roll-up to fall behind                               |
| 10  | Payout batches per period                     | ✅ Inclusion is "approved and unpaid as of `periodEnd`", so a late approval is never orphaned                             |
| 11  | Admin approval before disbursement            | ✅ `payout.approve`, conditional update, recorded approver                                                                |
| 12  | RazorpayX disbursement with reference capture | 🟡 Built; **UPI only until module 2 registers a bank fund account** (#51)                                                 |
| 13  | Reversal → deduction, never a clawback        | ✅ Unique `dedupeKey` makes "cannot deduct twice" a database guarantee                                                    |

### The three rules with teeth

- **Nothing is marked paid on submission.** `disburse` moves the batch to
  `processing`; only the RazorpayX webhook moves it to `paid`, and the
  commissions inside are marked paid at that same moment (US-8.11).
- **No bank debit exists anywhere in the module.** A reversal after payment
  leaves the row `paid` — it was — and raises a `PayoutDeduction` consumed by a
  later batch. A deduction bigger than a period is taken partially, so a payout
  is never negative and the debt is never written off.
- **Approve and disburse are different grants**, neither on `ops`, and both
  actors are stored.

### The safety net

The completion hook is non-fatal, like the counter beside it — a Pro must never
see "finish job" fail. But a missing counter is derived data and a missing
commission row is money, so `CommissionWorkerService` sweeps completed jobs with
no pay row every 15 minutes, approves rows past the hold window, and re-evaluates
rating incentives for anyone who has worked recently (a review arrives days after
the job, so the completion hook cannot have seen it). Every pass is also an admin
endpoint — a background job nobody can trigger is a background job nobody can
test.

No new dependency: it is the self-rescheduling `setTimeout` + Redis lock pattern
`ProCountersService` already uses.

### Known gaps in this module

| Gap                                | Why                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------ |
| `streak` / `surge_slot` evaluators | **Undefined business rules.** Configurable, visibly inert, excluded from the Pro app |
| Bank-transfer payouts              | #51 — needs `razorpayxFundAccountId` from module 2's verification step               |
| Payout-failure notification        | Built; failure and settlement enqueue durable Pro notification events                |
| Ledger entries                     | Module 9. `COMMISSION_LEDGER_PORT` logs and returns                                  |
| Salary                             | **Out of scope by decision** (#45). Every earnings response carries `salaryNote`     |

---

## 9 · Ledger & Reconciliation — 9/9 built

**Date built:** 2026-08-12. Plan: [`MODULE_9_LEDGER_PLAN.md`](MODULE_9_LEDGER_PLAN.md).
Conflicts settled: **#55** (a reversal after payment books nothing).

The smallest money module by a distance — ~2,000 lines against module 8's 4,500
— because more than half the feature list was already built elsewhere and this
module calls it rather than reimplementing it.

| #   | Feature                                    | Status                                                                                                               |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1   | Append-only double-entry with a hash chain | ✅ One row, two legs. `UPDATE`/`DELETE` raise at the database — verified against a real Postgres                     |
| 2   | Six entry types                            | ✅ `platform_revenue` is in the vocabulary and nothing writes it — it is computed                                    |
| 3   | Typed references on every entry            | ✅ booking, order, payout, Pro, customer, plus the gateway payment id                                                |
| 4   | Nightly reconciliation across the system   | ✅ 02:30 IST. Wraps module 7's engine and adds four ledger-scope checks                                              |
| 5   | Discrepancy detection                      | ✅ Module 7's six kinds plus `missing_ledger_entry`, `ledger_amount_mismatch`, `orphan_ledger_entry`, `chain_broken` |
| 6   | Discrepancy resolution with attribution    | 🟡 Notes and attribution on one endpoint. **No workflow** — that is a ticket system (module 11)                      |
| 7   | Nightly counter rebuild, drift self-heals  | ✅ Calls `ProCountersService.rebuildAll` — module 6's job, not a second implementation                               |
| 8   | Collections, payouts due, outstanding dues | ✅ Queries over the entries, no cached totals                                                                        |
| 9   | Finance dashboard                          | 🟡 In today, owed out, cash on the street. **Variance trend deferred** — needs run history first                     |

### This module writes no business logic

Every event that should produce an entry already existed as a typed call into a
no-op port. `LedgerAdapterService` fills in all eight and does nothing else; the
only decision it makes is which two accounts a movement is between. Modules 7
and 8 did not change to accommodate it beyond gaining a `register()` on their
delegates — the fourth time this codebase has used that pattern.

### The accounts, and the invariant they produce

`payable:pro:<proId>` is credited as work accrues and debited at settlement by
the net plus every deduction recovered. **It returns to exactly zero** for a Pro
with nothing in flight, whatever mixture of reversals, bonuses and deductions
they have been through — which is the strongest reconciliation check in the
module, and the reason #55 was worth getting right.

`cash_in_hand:<proId>` is the account `Pro.cashInHand` is a cache of, so "do the
cached balance and the books agree" is a real check rather than a tautology.

### What is enforced where

| Guarantee                    | Enforced by                                                          |
| ---------------------------- | -------------------------------------------------------------------- |
| No entry is ever edited      | A Postgres trigger that **raises** — not a rule that silently no-ops |
| One event books one entry    | `sourceRef` unique index                                             |
| The chain cannot fork        | A single advisory lock every write serialises on                     |
| Sequences are gap-free       | `MAX + 1` under that lock, never a Postgres sequence                 |
| Both shares sum to the price | Module 8's CHECK constraint, upstream of here                        |

### Known gaps in this module

| Gap                  | Why                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| Variance trend       | Needs a history of runs that does not exist yet. `GET /admin/reconciliation/runs` is where it accumulates |
| Discrepancy workflow | States, assignment, threads — deferred to module 11 rather than half-built here                           |
| Serial ledger writes | One global chain lock. Fine at this volume; per-account chains is the fix at 100×                         |

---

## 10 · Training & Reviews — 15/15 built

Built 2026-08-12. Two folders, `src/modules/reviews` and `src/modules/training`,
5,538 lines, 29 endpoints, four new tables and two altered. Full detail in
[`MODULE_10_TRAINING_REVIEWS_PLAN.md`](MODULE_10_TRAINING_REVIEWS_PLAN.md).

### What this module actually unblocked

The customer→Pro rating pipeline was already complete **except its first step**.
`Pro.ratingSum` existed, module 6 rebuilt it nightly, module 5's
`smoothedRating()` fed it into the dispatch tie-break at weight 0.15, and
`GET /pros/me/ratings` displayed it. Nothing anywhere created a row. Feature 15
was ninety percent built and idle for want of one `POST`.

### Features

| #     | Feature                                                          | State                                                                                                     |
| ----- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 1–3   | Trade-level modules, trade-specific delivery, resumable progress | ✅ Curriculum is a **query** — `ProService → Service → category → ancestors`. No enrolment table to drift |
| 4     | Quiz attempts with a capped retry                                | ✅ Graded **server-side**; the answer key is in no Pro-facing DTO, asserted by serialise-and-search       |
| 5     | Mandatory-module gate on activation                              | ✅ Port into module 6, **ships off** behind `training.gateActivation`                                     |
| 6     | In-job reference material                                        | ✅ `GET /pros/me/training?serviceId=`                                                                     |
| 7–8   | Offline cache, download-on-wifi                                  | ✅ Manifest with size, `version` and 6-hour URLs. Caching is the app's; the backend supplies the inputs   |
| 9     | Offline sessions, enrolment, attendance                          | ✅ Admin-driven throughout; capacity enforced, walk-ins refused until enrolled                            |
| 10–11 | Reviews in both directions                                       | ✅ One table, `reviewerType`, controlled vocabularies both ways                                           |
| 12    | `Customer.ratingSum` / `ratingCount`                             | ✅ Mirrored, and rebuilt by the same nightly job                                                          |
| 13    | Pro ratings to ops and the next Pro                              | ✅ `GET /pros/me/bookings/:id/customer-advisory` — aggregated, tag-only, nobody named                     |
| 14    | Moderation                                                       | ✅ Reason and admin id required by a CHECK. **Hides content, keeps the score**                            |
| 15    | Exact rating counters                                            | ✅ Moved in the insert's transaction; the nightly rebuild proves they agree                               |

### The hazard this module found

[**#61**](CONFLICTS_AND_DECISIONS.md). Adding a second reviewer direction to the
same table would have made the 02:00 rebuild fold a Pro's opinion of a customer
into that Pro's own public rating — silently, hours after deploy, from the job
that is supposed to _correct_ drift, and only for Pros diligent enough to flag
difficult households.

Measured against the real database: a five-star Pro would have read 3.5.

Three call sites needed the direction filter, not two. The third —
`incentive-evaluation.service.ts`, where a Pro could have reached a five-star
bonus by rating their own customers — surfaced only because the schema change
broke the compile.

### Known gaps

| Gap                           | Why                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| No request-level privacy test | No DB-backed HTTP suite exists to hang one on. Covered by per-query assertions and controller guards instead — see §16.4 of the plan |
| The gate has never run on     | Correct by design: it stays off until a trade's mandatory modules are loaded                                                         |
| No training content exists    | Every curriculum is empty, which is right, and means the Pro screens are untested against real data                                  |
| `recordReview` still present  | Dead, deprecated, and module 6's to delete                                                                                           |

---

## 13 · Geo & Routing — instalment 1 of 2: service areas

Owns `Area`, `AreaService` and `ProArea`, plus the one function that turns a pin
into an area. Full detail in
[`MODULE_13_SERVICE_AREAS_PLAN.md`](MODULE_13_SERVICE_AREAS_PLAN.md).

| Capability                                    | Status                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| City divided into areas                       | ✅ **Rectangles**, laid as a generated grid — gapless and non-overlapping by construction (#42)           |
| Per-area service availability                 | ✅ `AreaService`. **This is what #8 left impossible** — availability only, price stays national           |
| Pin → area, server-side                       | ✅ One indexed range query on half-open bounds. No trigonometry on the request path                       |
| Never trust a client-supplied area            | ✅ No endpoint anywhere accepts an `areaId`. Pin in, area out                                             |
| Two distinct unavailable answers              | ✅ `LOCATION_NOT_SERVICEABLE` vs `SERVICE_NOT_AVAILABLE_IN_AREA` — different problems, different messages |
| Re-validated at booking, not just at checkout | ✅ Booking re-resolves from the pin and freezes `Booking.areaId`                                          |
| Pros posted to areas                          | ✅ `ProArea`, admin-set. A **filter** on dispatch; distance still ranks                                   |
| Google Maps / Places / Routes / ETA           | ⬜ Instalment 2. Reverse geocoding is still module 2's Nominatim adapter                                  |
| WebSocket live tracking                       | ⬜ Instalment 2. Tracking is a polled GET that reports staleness                                          |
| Pro schedules / working hours                 | ⬜ Genuinely new scope — dispatch still has no roster                                                     |

**The thing to know before enabling it.**
`geo.enforceAreaServiceAvailability` ships **false**, per city. This is the
first rule in the codebase whose only possible effect is to refuse a booking
that would previously have succeeded, and with no areas drawn, enabling it would
reject every booking in the product. The area is resolved and recorded
regardless, and every would-be rejection is logged — so the evidence needed to
flip a city on accumulates before anyone flips it. Conflict #43.

**Coordination events:** `haversineKm` moved from `dispatch.types.ts` to
`geo/geo.types.ts` (re-exported, so no import changed); one optional parameter
on `findEligiblePros`; a third port on module 4 (`SERVICEABILITY_PORT`) and its
call in booking creation.

---

## 13b · Routing & ETA — built 2026-08-12

`src/routing/`, infrastructure beside `src/geocoding/` for the same reason
spelled out in #49: dispatch (5), bookings (4) and geo (13) all need road travel
time and none of them can own it without closing an import cycle.

| Concern            | Answer                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Which API          | Google **Routes** `computeRouteMatrix`. Not Distance Matrix — Google marked that legacy in 2025 and new projects cannot enable it |
| Provider selection | By key presence, like the geocoder. `ROUTING_PROVIDER` overrides                                                                  |
| Without a key      | Dispatch still ranks correctly from straight lines. **No customer ETA is published**                                              |
| Batch              | One call for N candidates, not N calls. Dispatch's question is a matrix                                                           |
| Ordering           | Results placed by `originIndex` — Google returns them out of order, verified live                                                 |
| Failure            | Every path degrades to straight lines. A routing outage never takes the live map down                                             |
| Cost control       | Cache keyed on origin rounded to ~110 m, 60s TTL. A GPS ping every few seconds costs ~1 call a minute                             |

### The rule that shapes the customer-facing half

**A straight-line guess is never published as an arrival time.**

`TravelEstimate.source` says whether an answer came from a road graph, and
`BookingEtaService` returns `null` for anything that did not. Ranking only needs
the ordering to be right and crow-flight preserves it; a customer reads "8
minutes" as a promise. `etaMinutes: null` is a real answer meaning "no number
worth showing" — the app renders "on the way".

Null also covers a **stale** position: an ETA computed from where a Pro was five
minutes ago, presented as where they are now, is the same lie `isStale` exists
to prevent, only harder to spot because a number looks authoritative.

### Verified live

Against the real key, Vijay Nagar → Rajwada: **28 minutes, 7,917 m, traffic-aware**,
538 ms fresh and **1 ms cached**. The matrix ranked the nearer origin first, and
Google's raw reply came back with `originIndex: 1` before `0` — the exact
out-of-order case the positional mapping exists for.

### Still not built

`Directions` for a drawn route polyline. Nothing renders one, and the field mask
that would fetch it multiplies the per-element cost.

---

## ERD cross-check

Every table these modules own was compared field-by-field against the
authoritative v10 ER diagram (Eraser, team TheUnknownGMR). The ERD — not the
narrative doc — is the source of truth for column names and types; the narrative
doc governs the business-rule _why_.

> ⚠️ **The Eraser MCP connector is not authorised in this workspace**, so the
> diagram cannot be pulled live. A verbatim copy was captured on 2026-08-10 at
> [`ERD_DATA_MODEL_V10.md`](ERD_DATA_MODEL_V10.md) and modules 1, 2, 3 and 6
> were reconciled against it. Re-paste it there if the diagram changes.

**Module 3 was reconciled against the ERD before its migration was written**, and seven proposed field names lost to it — `durationMinutes` not `expectedDurationMinutes`, `flatPrice` not `price`, `supports*` not `allows*`, `parentCategoryId` not `parentId`, `sortOrder` not `displayOrder`. Two proposed columns were dropped outright: `Service.allowsCash` (named by a ground rule but absent from the ERD) and `updatedByAdminId` on both catalog tables. See [conflicts #13, #14 and #15](CONFLICTS_AND_DECISIONS.md).

**Deviation found and corrected:** `CustomerAddress.deliveryNotes` was added,
then removed (`20260807122120_remove_customer_address_delivery_notes`), because
the ERD's `CustomerAddress` carries `landmark` only. Net schema effect: none.
That is why module 2 is 8/9 rather than 9/9.

**Confirmed while cross-checking:**

- `Pro.cityId` and `Pro.monthlySalary` were already ERD-sanctioned columns; the 08-07 pass added only the missing endpoint.
- Location ingest uses the ERD's exact Redis key (`pros:live`), not an invented one.
- Admin-id columns on `ProApplication` are plain strings, not Prisma `@relation`s — matching the ERD's own drawing. Pre-existing, not changed.
- `pushToken` / `pushPlatform` exist on all three user tables and are written by nothing yet. Correct — they belong to module 12.
- `AdminAuditLog` was removed pending product decisions (`20260808230000_defer_admin_audit_log`).

---

## Out of scope — dependencies on unbuilt modules, not gaps

| Deferred item                                | Needs                    | Where the seam is                                                                          |
| -------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| Automatic assignment; slot availability      | Module 5 (Dispatch)      | **`DispatchPort`** — swap one `provide` line in `bookings.module.ts`                       |
| Online payment; refund execution             | Module 7 (Payments)      | **`PaymentsPort`** — same                                                                  |
| Commission on completion                     | Module 8                 | `ServiceCatalogService.getCommissionConfig()` built; completion emits the event            |
| Live ETA and `routeTrail` sampling           | Module 13                | Redis holds current position; nothing accumulates a trail                                  |
| Push on customer-visible booking transitions | Module 12                | Built transactionally for assignment, travel, arrival, start, completion and cancellation  |
| `no_start` ticket on grace-window expiry     | Module 11                | `no_start.graceWindowMinutes` configured; nothing watches it                               |
| Review after completion                      | Module 10                | `Review` stubbed; module 10 owns it                                                        |
| Invoice PDF                                  | No PDF tooling           | Number, tax and `invoicedAt` are generated                                                 |
| Rating counters being _written_              | Module 10                | `ProCountersService.recordReview` built, uncalled. **`recordCompletion` now has a caller** |
| Admin audit of any mutation                  | Module 15                | `AdminAuditLog` deferred by decision; catalog edits carry no attribution                   |
| Catalog → SDUI home config                   | Module 14                | Built; active category slugs and service IDs are validated before publication              |
| Per-service cash eligibility                 | ERD change + module 7    | No `Service.allowsCash` column exists                                                      |
| Live SMS OTP                                 | Synquic Slide API key    | Provider implemented; key absent                                                           |
| S3 upload of real bytes                      | AWS creds / EC2 IAM role | Presigned URL generation works                                                             |

---

## Verification

**Run 2026-08-12, after the module 10 build:**

| Check                   | Result                                                         |
| ----------------------- | -------------------------------------------------------------- |
| `npx jest` (unit)       | **67 suites / 918 tests passed** — was 62/831 before module 10 |
| `npm run test:e2e`      | **8 suites / 181 tests passed** — was 8/179                    |
| `npm run typecheck`     | **Pass**                                                       |
| `npm run build`         | **Pass**                                                       |
| `eslint`                | **Pass**, zero warnings                                        |
| `prisma validate`       | **Pass**                                                       |
| `prisma migrate deploy` | **21/21 applied** against the local cluster                    |
| Live boot               | **224 routes mapped** (was 194); training gate registered      |

Two things module 10 could not prove with mocks were run against Postgres
directly, each inside a rolled-back transaction:

- **[#61](CONFLICTS_AND_DECISIONS.md), the reviewer direction.** One booking,
  two reviews, the real rebuild statements. Filtered: Pro 5/1, customer 2/1.
  Unfiltered, which is what would have shipped: Pro 7/2 — a five-star Pro
  reading 3.5.
- **All eight new CHECK constraints**, each in its own PL/pgSQL block so a
  failed statement cannot poison the next trial and turn a failure into a false
  pass. 8/8 refused what they should refuse.

---

**Run 2026-08-10, after the module 4 build:**

| Check                     | Result                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npx jest` (unit)         | **24 suites / 212 tests passed** — was 16/85 before modules 3 and 4                                        |
| `npm run test:e2e`        | **6 suites / 125 tests passed** — was 3/13                                                                 |
| `npm run typecheck`       | **Pass** (`tsc --noEmit`, whole project incl. tests)                                                       |
| `npm run build`           | **Pass** (`nest build`)                                                                                    |
| `eslint --max-warnings=0` | **Pass** across `src`, `prisma` and `test`                                                                 |
| `prisma validate`         | **Pass**                                                                                                   |
| Migration ↔ schema parity | Hand-written SQL diffed against `prisma migrate diff` output — columns, index names and FK names all match |

Module 4 added 76 unit tests and 72 e2e assertions. The unit tests cover every rule in §4's table and **all 81 (from, to) pairs of the state machine**, legal and illegal. The e2e assertions are the Swagger contract: every booking route published as the envelope, bearer auth everywhere, the `409` documented on every route a state-machine rule can refuse, the `501` an online booking gets while Payments is unbuilt, `flatPrice` typed `string`, no contact detail anywhere in the chat schema, and **no route under `/pros/` matching `/cancel/i`** — principle 2 asserted as a test rather than a convention.

Module 3 contributed 51 unit tests and 40 e2e assertions before it, including 3 that compile the real `AppModule` to prove the Catalog ↔ Pros `forwardRef` resolves. That test now also covers module 4's wiring.

### Live verification against a real database — 2026-08-10

All 12 migrations were applied to a throwaway PostgreSQL 18 cluster (`initdb`, trust auth, port 55433), seeded, and driven end to end. **Neither the shared RDS instance nor the developer's own local cluster was touched** — the RDS credentials in `.env.local` no longer authenticate, and `DATABASE_URL` there is still blank.

| Check                           | Result                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| `prisma migrate deploy`         | **12/12 applied**, including the three new ones                                          |
| `migrate diff` live DB ↔ schema | **"No difference detected"** — the hand-written SQL produces exactly what Prisma expects |
| `prisma db seed`                | 4 roles, admin, 2 cities, 14 categories, 25 services                                     |
| Schema shape                    | 22 tables; `bookings` at **42 columns**, matching the ERD; both `serviceId`s now `uuid`  |
| **Database guards**             | **18/18 rejected** — see below                                                           |
| **Cash lifecycle cURL suite**   | **24/24 passed** — `test/manual/run-booking-lifecycle-curl.sh`                           |

Every `CHECK` constraint was tested by trying to violate it. All 18 were refused: an active service with no commission rate, a percent rate above 100, an active service no flow can book, a self-parenting category, a service in a missing category, an invalid booking status, `paymentMode = 'crypto'`, **a cancellation attributed to a Pro**, a `started` booking with no `startedAt`, a `completed` one with no `completedAt`, a `cancelled` one with no `cancelledAt`, an invalid `bookingType`, a negative price, `frequency = 'hourly'`, `timeOfDay = '25:00'`, an end date before its start date, a chat message from ops, and a photo typed `selfie`.

Both migration guards were tested too. Against a table holding one booking, the `flatPrice` guard raised its exact message and refused. Against a pre-migration database holding `serviceId = 'plumbing-legacy-code'`, the FK guard raised and **left the column as `text`** — nothing half-migrated.

The lifecycle run produced this timeline, coordinates and all:

```
created → assigning → assigned → en_route → arrived → start_otp_failed → started → photo_proof_added → completed
```

with `flatPrice` frozen at `699.00`, `taxAmount` `106.63` (the component _within_ the price — [conflict #28](CONFLICTS_AND_DECISIONS.md)), invoice `INV-2026-000006`, booking number `HB-2026-000004`, and 8 geo-stamped events.

### Two defects the live run exposed — both fixed

Neither was reachable by unit tests, because both hide behind mocks.

1. **All four advisory locks in `ProCountersService` used `$queryRaw` on a `void`-returning function**, which crashes Prisma. The identical bug was found and fixed in `pro-applications.service.ts` during the 08-08 pass — with an explanatory comment — but the counters service was never corrected, because **none of its four methods had a caller**. `recordCompletion` acquired one in this module and crashed on the first real call. `recordOffer`, `recordAcknowledgement` and `recordReview` would have done the same for modules 5 and 10.
2. **`recordCompletion` had become a silent no-op.** It still performed the completion itself — setting `status`/`completedAt` and writing the status event — from when module 4 did not exist. Its first line was `if (booking.status === 'completed') return;`, which is exactly the state its only caller now hands it, so **`completedJobs` never incremented**. It has been reduced to the counter it should be, made idempotent by a marker event, and the completion call site treats a counter failure as non-fatal — derived data is rebuilt nightly and source wins, so a finished job must not report failure because a statistic did not move.

Unit tests could not have caught either: they mock `$queryRaw` as a `jest.fn()` and assert on calls, not on Postgres's response.

**From the 2026-08-08 pass** (see [`reports/FINAL_VERIFICATION_REPORT_2026-08-08.md`](reports/FINAL_VERIFICATION_REPORT_2026-08-08.md)) — not re-run today:

| Check                                 | Result                                                            |
| ------------------------------------- | ----------------------------------------------------------------- |
| Full HTTP/cURL suite                  | 182/185 first run → **185/185** after a geocoder-dependency rerun |
| Prisma migrations on fresh PostgreSQL | 9/9 applied                                                       |
| Bootstrap seed                        | 4 system roles + super admin                                      |

That run deliberately used a mock OTP provider, a local Redis-compatible
process, deterministic local Nominatim responses, presigned-URL generation
without real uploads, and a local PostgreSQL 18 — not the managed production
equivalents. The 100% figure covers implemented routes in the local integration
scope; it is not a claim that unconfigured external systems are certified.

Reproduction: `test/manual/run-all-curl-tests.ps1` (honours `CURL_TEST_APP_LOG`).

---

## Migrations (21 — all applied and verified 2026-08-12)

```
20260807112307_init
20260807112404_add_employee_code_sequence
20260807120244_add_customer_address_delivery_notes
20260807122120_remove_customer_address_delivery_notes
20260808120000_add_guest_retention_index
20260808180000_enforce_one_default_customer_address
20260808220000_add_pro_profile_and_kyc_identity
20260808230000_defer_admin_audit_log
20260809000000_add_pro_standing_sources
20260810120000_add_service_catalog          ← new
20260810120100_link_service_foreign_keys    ← new, HIGH BLAST RADIUS, guard verified
20260810140000_add_booking_lifecycle        ← guard verified
20260810160000_add_dispatch_scoring
20260811120000_add_payments_orders_and_cash
20260811120100_add_service_allows_cash
20260811140000_add_service_areas
20260811160000_relative_dispatch_reach
20260811180000_area_naming
20260812120000_add_commission_and_payouts
20260812160000_add_ledger_and_reconciliation
20260812180000_add_training_and_reviews     ← new, DROPS a unique index
```

`add_training_and_reviews` is the only migration so far that **removes** a
constraint: `reviews.bookingId UNIQUE` becomes
`UNIQUE (bookingId, reviewerType)`. Safe only because no review row has ever
been written — nothing called the writer. It also caught
[#62](CONFLICTS_AND_DECISIONS.md): a first draft re-declared
`reviews_rating_check`, which already existed, and the four `ADD COLUMN`
statements ahead of it **stayed applied** after the failure. Prisma does not
wrap a migration file in a transaction, and `migrate resolve --rolled-back`
clears the bookkeeping row without touching the schema.

`link_service_foreign_keys` is separate from the catalogue tables on purpose: it rewrites `pro_services.serviceId` and `bookings.serviceId` from `TEXT` to `UUID` and adds foreign keys, so it fails on any row whose `serviceId` is not a real `services.id`. **Seed the catalogue and remap any existing rows before running it.**

`add_booking_lifecycle` adds `bookings.flatPrice` as `NOT NULL`, because every booking has a price from the instant it exists and making the column nullable would permanently weaken the guarantee US-3.2 depends on. It therefore **refuses to run if any booking row already exists**, rather than inventing a price for rows that predate the column.

Both open with a `DO` block that counts the offending rows and raises a readable exception naming them, instead of letting a raw cast or constraint error surface.

---

## Recommendation

Phase 1 of the documented build order and Module 14 Config are complete. Identity, Customer Profile, Catalog, Pro Management, Booking, platform settings and customer-home delivery now have implemented backend surfaces.

**Modules 3 and 4 are verified against a real database.** All 12 migrations apply cleanly, the live schema matches Prisma exactly, all 18 database guards refuse what they should, and a cash job runs from creation to invoice — 24/24 in `test/manual/run-booking-lifecycle-curl.sh`. Two latent defects in module 6's counters were found and fixed in the process.

**Two environment problems are worth fixing before anyone else picks this up.** `.env.local`'s `DATABASE_URL` is blank, and because the config layering takes the _first_ file that defines a key, that blank value **shadows any fallback** rather than falling through — it is why nothing could connect. Separately, the RDS credentials in the `DB_*` vars no longer authenticate. Note the `DB_*` vars are TypeORM-era leftovers that nothing reads any more; only `DATABASE_URL` matters.

**Then module 5 (Dispatch).** It is now the single highest-value thing left: `DispatchPort` is defined and stubbed, so the work is implementing one interface rather than threading a new concern through the booking lifecycle. Until it lands, ops assigns every job by hand, and that is the difference between a working demo and a product.

**Module 7 (Payments) unblocks the other half of the funnel.** Online bookings currently fail at creation with a documented `501`; cash works end to end. `PaymentsPort` is the same shape of job.

Three decisions worth taking to product before they calcify:

1. **Catalog edits have no audit trail at all** — not even last-editor. That is a real ops risk on a table that holds prices and pay rates.
2. **Per-service cash eligibility does not exist**, despite a ground rule naming `Service.allowsCash`. If cash is meant to be restrictable per service, the ERD needs the column. Right now every service can be booked as cash, which is also the only mode that works.
3. **The flat price is treated as tax-inclusive** ([conflict #28](CONFLICTS_AND_DECISIONS.md)) — a ₹599 service invoices at ₹599 with ₹91.37 recorded as the GST component within it. Finance should confirm the catalogue prices were set on that basis; if they were meant to be pre-tax, every seeded price is wrong rather than the code.
