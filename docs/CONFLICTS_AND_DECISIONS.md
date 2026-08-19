# Conflicts & Decisions

Every place the source documents contradict each other, what we decided, and why.

**Why this file exists.** Homingo has four sources of truth that disagree:

| Source                                               | Authority                                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Detailed_Scope_Home_Services_App_Suite.pdf` (5 Aug) | Original scope. Lowest authority — superseded wherever anything else differs |
| `Modules_and_Features 1.md` **ground-rules table**   | **Highest authority on behaviour.** Says so itself                           |
| `Modules_and_Features 1.md` **module feature lists** | Below the ground rules; some entries predate them and are stale              |
| **Eraser ERD v10** (team TheUnknownGMR)              | **Highest authority on schema shape** — column names, types, presence        |
| `user-stories-by-persona/*.md` (US-x.y)              | Authoritative on edge-case behaviour; same vintage as the ground rules       |

**The precedence rule this project runs on:** the **ERD wins on schema shape**;
the **ground-rules table wins on business rules**; the narrative feature lists
win only where nothing above them speaks.

Decisions here are binding. If one turns out wrong, change it here first.

---

## Index

| #   | Conflict                                                                        | Module   | Resolution                                                                                     |
| --- | ------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| 1   | `CustomerAddress.deliveryNotes`                                                 | 2        | Removed — ERD has `landmark` only                                                              |
| 2   | Administrative audit trail                                                      | all      | Deferred; `AdminAuditLog` dropped                                                              |
| 3   | DigiLocker KYC                                                                  | 6        | Excluded — manual S3 + human review only                                                       |
| 4   | Pro status lifecycle missing `rejected`                                         | 6        | `rejected` added                                                                               |
| 5   | Suspended Pro — `401` or `403`?                                                 | 1/6      | `403`                                                                                          |
| 6   | "International format" phone accepted national numbers                          | 1        | Canonicalise Indian mobiles to E.164                                                           |
| 7   | Duration → commission tiers                                                     | 3        | **Cancelled** — duration feeds Dispatch only                                                   |
| 8   | "Per-city activation"                                                           | 3        | Means `City.isActive`, not per-city services                                                   |
| 9   | Catalog edits "audited"                                                         | 3        | No attribution at all — deferred with #2 and #14                                               |
| 10  | Category tree depth unspecified                                                 | 3        | Two levels, enforced                                                                           |
| 11  | Price snapshotting with no `Booking` price column                               | 3/4      | Deferred to module 4; catalog exposes price                                                    |
| 12  | `Decimal` money serialises as a string                                          | 3/6/8    | Accepted and documented, not coerced                                                           |
| 13  | `Service.allowsCash` named by a ground rule, absent from ERD                    | 3        | ~~Not added~~ — **reversed by #37**; the column now exists                                     |
| 14  | Editor attribution on catalog rows                                              | 3        | Dropped — ERD has no such column                                                               |
| 15  | Catalog field names: plan vs ERD                                                | 3        | ERD names used verbatim                                                                        |
| 16  | Timestamps absent from the ERD, present everywhere in the schema                | all      | House convention kept                                                                          |
| 17  | US-3.4 creates a service "with commission" in one step                          | 3        | Two calls — commission is a separate permission                                                |
| 18  | "Actual duration is the number commission is calculated from"                   | 4        | **Cancelled** — reporting only, like #7                                                        |
| 19  | Coordinates: ERD `decimal`, codebase `Float`                                    | 2/4/6    | `Float` kept; ERD deviation recorded, not fixed piecemeal                                      |
| 20  | Feature 8's linear state list vs the cash ground rule                           | 4        | Real state machine; payment mode forks it                                                      |
| 21  | Recurring pricing — at plan creation or at generation?                          | 4        | At generation                                                                                  |
| 22  | Rebook vs rotation                                                              | 4        | Rotation wins; lineage recorded, Pro never pinned                                              |
| 23  | When does chat close?                                                           | 4        | Writes close 24h after completion; reads never                                                 |
| 24  | Is the customer charged when not home?                                          | 4        | Not automated — ops decides                                                                    |
| 25  | The OTP-at-the-door override                                                    | 4        | Audited ops force-start, visibly distinct on the timeline                                      |
| 26  | Cancellation windows are a proposal, not policy                                 | 4        | Mechanics built; every number in `PlatformSetting`                                             |
| 27  | `Booking.expectedDurationMinutes` proposed but not in the ERD                   | 4        | Not added — derived from the slot window instead                                               |
| 28  | Invoice tax: added to the price, or contained within it?                        | 4        | Within — the customer sees one number only                                                     |
| 29  | Rule 2 needs travel time; Geo & Routing does not exist                          | 5        | `TravelTimePort` + haversine — ranks, but never quotes an ETA                                  |
| 30  | "Redis-queued intake" with no worker process                                    | 5        | Real Redis list; drained by an admin route. The lock, not the trigger, is what makes it safe   |
| 31  | US-5.5 supply gap vs US-5.10 exhaustion                                         | 5        | Two outcomes — `no_supply` and `exhausted`                                                     |
| 32  | Module 5 cannot re-bind module 4's `DISPATCH_PORT`                              | 4/5      | The port is a delegate module 5 registers into                                                 |
| 33  | `ProCountersService` methods duplicated work their callers now own              | 5/6      | Counters own only counters; the caller owns the transition                                     |
| 34  | A DTO documents the response; it does not filter it                             | 3        | Customer-facing reads go through an explicit mapper                                            |
| 35  | Cash has no store of record anywhere in the ERD                                 | 7        | Four columns and one table added; `Pro.cashInHand` is a cache, not the ledger                  |
| 36  | `paymentStatus = paid` means two different things                               | 7        | Kept, and every reader must read `paymentMode` beside it. Four consequences accepted           |
| 37  | `Service.allowsCash` — reopening #13                                            | 3/7      | **#13 reversed.** City gate as a setting, service gate as a column, both server-side           |
| 38  | Webhook HMAC needs bytes; Fastify had already parsed them                       | all      | `rawBody: true` in `main.ts` — a shared-file change for one module's benefit                   |
| 39  | The global ValidationPipe would 400 every webhook                               | 1/7      | The webhook takes no DTO. Third-party payloads are not ours to whitelist                       |
| 40  | Idempotency with no table to hold event ids                                     | 7        | Convergent writes + forward-only status. Redis is a fast path correctness ignores              |
| 41  | A valid signature is not a successful payment                                   | 7        | Verify, then fetch from the gateway and assert status, order and amount                        |
| 42  | Serviceability was city-wide; the business is area-wide                         | 3/13     | `Area` + `AreaService` added. **Rectangles**, half-open bounds, gapless generated grid         |
| 43  | A mandatory gate that can only reject, added to a live product                  | 13       | Ships **off** per city; the area is recorded anyway so the evidence to enable it accrues first |
| 44  | The proposed plan contradicted four shipped decisions                           | 4/5/6/13 | All four kept: nine states, Redis GEO, `Pro` naming, no accept/reject (already true)           |
| 45  | Pro is a salaried employee; §8 says commission is the only pay                  | 8        | Salary stays external — payroll's job. This system pays the variable part only                 |
| 46  | A service sellable in an area nobody is staffed for                             | 5/13     | Gate at config time, widen at run time. Two failures, two fixes                                |
| 47  | The 60-minute travel cap was a guess refusing real customers                    | 5        | Cap removed. Proximity decays instead; the city boundary is the only bound                     |
| 48  | A generated grid is 36 squares nobody can identify                              | 13       | Reverse-geocode each centre into a suggestion; `nameSource` stops it clobbering a human        |
| 49  | The geocoder had two owners and could have neither                              | 2/13     | Moved to `src/geocoding` as infrastructure; provider chosen by which key is present            |
| 50  | Socket auth in `handleConnection` loses a race it cannot win                    | 4        | Handshake middleware — identity attached before the socket is usable                           |
| 51  | The bank account is stored masked, so it cannot be paid to                      | 2/8      | Pay by UPI today; `razorpayxFundAccountId` is the seam for module 2 to register the bank rail  |
| 52  | "Commission" names the Pro's pay here, not the platform's cut                   | 3/8      | `commissionAmount` is what the Pro earns. Stated on the column, the DTO and the admin screen   |
| 53  | Progress with one `commissionId` cannot survive a reversal                      | 8        | `ProIncentiveContribution` — one row per job, progress is their sum                            |
| 54  | A recurring bonus locked by `@@unique([proId, incentiveId])`                    | 8        | `recurrence` + `periodKey` in the unique key, so a monthly scheme genuinely restarts           |
| 55  | A reversal after payment has no money movement to book                          | 8/9      | No entry at reversal. The claim lives in `PayoutDeduction`; the entry waits for the recovery   |
| 56  | Two modules served `pros/me/payouts`; the app could not boot                    | 6/8      | Module 8 owns it. Plus an e2e suite that actually starts the HTTP server                       |
| 57  | An ETA the platform cannot stand behind is worse than no ETA                    | 4/5/13   | `source` on every estimate; a straight-line answer is never shown as an arrival time           |
| 58  | A city map has no supported way to be pruned or reshaped                        | 13       | Bounds from the geocoder, bulk deactivate-outside, and a regenerate that retires booked cells  |
| 59  | Cell names came from the first line of the address — a building, on Google      | 13       | Structured `localityCandidates`, plus a preview that shows names before rows exist             |
| 60  | Opening a city was a one-way door                                               | 13       | `preview-grid` computes and names cells without writing any                                    |
| 61  | A Pro rating a customer would have rated themselves down                        | 10       | One table, `reviewerType` filtered in the rebuild, the drift check and the incentive read      |
| 62  | A migration that fails halfway leaves its DDL behind                            | —        | Undo the partial DDL by hand before `resolve --rolled-back`; grep for constraint names first   |
| 63  | Module 15 requires audit and realtime admin sockets; staged delivery omits both | 15       | Build polling REST, jobs and reports now; keep audit decision #2 and admin sockets deferred    |
| 64  | ERD/persona say Admin OTP; legacy implementation used Firebase                  | 1/15     | Use Slide phone OTP for Admin; retain Firebase exchange only for linked legacy rows            |
| 65  | Payment attempts are dashboard-only in prose but have a live read API           | 7/15     | Keep the Razorpay read-through API; still store no local attempt rows                          |
| 66  | NotificationLog requires a recipient FK, but signup OTP precedes the user row   | 1/12     | Permit zero recipient FKs for pre-auth OTP only; retain actor type and masked destination      |

---

## 1 · `CustomerAddress.deliveryNotes` — narrative doc vs ERD

**Module 2 · Resolved 2026-08-07**

Module 2 feature #4 says "Landmark **and** free-text delivery notes per address."
A `deliveryNotes` column was added on that basis. The ERD's `CustomerAddress`
carries `landmark` and nothing else.

**Decision:** ERD wins. The column was removed
(`20260807122120_remove_customer_address_delivery_notes`) and `landmark` serves
both purposes. Net schema effect across the two migrations: none.

**Consequence:** module 2 is 8/9 features, permanently, until the ERD adds the
column. This is the case that established the precedence rule at the top of this
file.

---

## 2 · Administrative audit trail — cross-cutting concern vs product decision

**All modules · Resolved 2026-08-08**

The cross-cutting concerns table promises audit on administrative mutation, and
US-3.5 / US-3.10 both say catalog edits are "audited". No audit table survived
into the active scope: `AdminAuditLog` was explicitly deferred pending schema,
retention and access decisions (`20260808230000_defer_admin_audit_log`).

**Decision:** do not invent the table — and do not invent a column either. Where
the ERD already gives a row an editor FK (`PlatformSetting.updatedByAdminId`),
use it; where it does not, record the gap rather than papering over it with a
column the diagram has never had.

**Consequence:** `BookingStatusEvent` remains the job-lifecycle trail, and
`PlatformSetting` records its last editor. Nothing else does — in particular the
catalog tables carry no attribution at all (conflicts #9 and #14). There is no
general admin-action audit, and the status report says so.

---

## 3 · DigiLocker KYC — scope PDF vs ground rules

**Module 6 · Resolved at build**

The original scope describes DigiLocker-backed identity verification. The
ground-rules table restricts the active scope to "**manual S3 upload and human
review only**. DigiLocker is deferred and is **not accepted by the API**."

**Decision:** ground rule wins. No DigiLocker fields, no DigiLocker upload path,
and the API rejects any attempt to claim a non-manual source.

---

## 4 · Pro status lifecycle is missing a state

**Module 6 · Resolved at build**

Feature #17 lists the lifecycle as `applied → under_review → approved →
suspended`. Feature #7 requires re-application: "a rejected applicant reapplies
as a new attempt; the earlier rejection and its documents are preserved." There
is no `rejected` state in the list to reapply _from_.

**Decision:** the feature list is incomplete, not restrictive. `rejected` was
added. A rejected applicant can authenticate but remains non-dispatchable, and
the prior attempt is preserved intact.

---

## 5 · Suspended Pro — `401` or `403`?

**Modules 1 + 6 · Resolved 2026-08-08**

The cURL suite initially asserted `401` for a suspended Pro presenting a valid
token. That conflates two different failures: the token _is_ valid and the
identity _is_ established.

**Decision:** `403`. Authenticated but forbidden. `401` is reserved for a
missing, malformed or revoked token. The test expectation was the thing that was
wrong, not the code.

**Consequence:** a suspended Pro retains read-only access to standing, jobs,
ratings, commissions, earnings and payouts — history they earned stays readable.

---

## 6 · Phone "international format" accepted national numbers

**Module 1 · Resolved 2026-08-08**

The documented contract said international format; the validator accepted a bare
10-digit Indian mobile, so the same human could exist under two identities
(`9876543210` and `+919876543210`) depending on which screen they used.

**Decision:** canonicalise at the DTO boundary (`dto/phone.transform.ts`). A
valid Indian national mobile is normalised to `+91…` before OTP dispatch, Redis
keys and persistence. Anything else must already be E.164.

---

## 7 · Duration → "tier selection in Commission"

**Module 3 · Resolved 2026-08-10**

Module 3 feature #7:

> Duration feeds two downstream systems: slot sizing in Dispatch and **tier
> selection in Commission**

Ground-rules table:

> **Commission rate.** One rate per Service (`commissionType`, `commissionValue`).
> No tiers, no duration bands, no per-city config. **Duration no longer changes
> what a Pro earns.**

Module 8's own preamble and US-3.10 both agree with the ground rule. Feature #7
is a leftover from when `CommissionTier` was a table in an earlier ERD revision.

**Decision:** ground rule wins. `Service.expectedDurationMinutes` feeds
**Dispatch slot sizing and ETA only**. No tier table, no duration band, no
`getCommissionTier()`. Feature #7 ships at half scope and the status report
records it as such.

**Consequence:** a long job and a short job of the same service pay identically.
If overrun compensation is ever wanted it must come from an incentive scheme
(module 8) or from splitting the service into two catalogue entries — which is
exactly the trade-off module 8's own note already calls out.

---

## 8 · "Per-city activation" — cities, or services per city?

**Module 3 · Resolved 2026-08-10**

Module 3 feature #5 reads "City registry with timezone; **per-city activation**",
which at a glance suggests activating individual services per city.

It does not, on four independent counts:

- the module map assigns module 3 exactly three tables — `ServiceCategory`,
  `Service`, `City`. There is no `ServiceCity` join table;
- **Pricing** ground rule: "One flat price per service, nationally";
- **Geography** ground rule: "City-level only. No micromarkets or zones";
- US-3.4: "**One flat national price.** No city pricing exists in the model."

**Decision:** "per-city activation" is `City.isActive`. Every active service is
bookable in every active city. Serviceability is answered by the city alone —
which is how module 2 already implements `GET /customers/me/serviceability`.

**Consequence:** launching a city is one boolean, and there is no way to withhold
a single service from a single city short of a schema change. Flagged as a
product risk rather than engineered around.

---

## 9 · Catalog edits are "audited", but there is no audit table

**Module 3 · Resolved 2026-08-10**

US-3.5 ("`Service.price` updated; audited") and US-3.10 both require audit.
See conflict #2 — there is no audit table.

**Decision:** do not invent a table, and — per conflict #14 — do not invent a
column either. ERD v10 gives the catalog tables no editor FK, so catalog
mutations carry no attribution at all for now.

**Consequence:** "who changed this price, and when, and from what" is not
answerable today, and neither is the weaker "who last changed it". This is the
sharpest open gap in module 3, and the status report says so.

> **Revised 2026-08-10.** An earlier draft of this entry recommended adding
> `updatedByAdminId` to `Service` and `ServiceCategory` as a partial answer.
> The ERD has no such columns; see conflict #14 for the reversal.

---

## 10 · Category tree depth is unspecified

**Module 3 · Resolved 2026-08-10**

Feature #1 says "parent/child nesting" without bounding the depth. Unbounded
nesting is trivial to store and expensive everywhere else — the browse response
becomes recursive, the SDUI home config (module 14) has to render arbitrary
depth, and US-3.8's "services must not be orphaned by a category deletion" grows
a subtree-walk.

**Decision:** **two levels.** A category is either a root (`parentId = null`) or
a child of a root. A category whose own parent is set may not itself become a
parent, enforced in the service layer with a `409`. The self-relation stays in
the schema, so allowing depth 3 later is a validation change, not a migration.

**Consequence:** "Home Cleaning → Deep Cleaning" works; a third level does not.
This matches every consumer-app catalogue in the category and keeps the browse
payload a fixed shape.

---

## 11 · Price snapshotting, with nowhere to snapshot to

**Modules 3 + 4 · Deferred 2026-08-10**

US-3.5 says "price is snapshotted onto `Booking` at creation" and US-3.2 says
"any screen showing a total must read the frozen `Booking.flatPrice`, not
recompute from the live catalog." `Booking` has **no price column at all** — the
model exists only as a stub for the counters modules 5/6/10 needed.

**Decision:** not module 3's to fix. Adding `flatPrice` to `Booking` without the
booking-creation flow that populates it would create a column nothing writes —
exactly the class of defect the 08-07 audit found on `Pro.monthlySalary`.

**Consequence:** module 4 must add `Booking.flatPrice` **and**
`Booking.expectedDurationMinutes` and populate both at creation. Until then,
editing a service price has no historical record to protect. Listed as an
inbound dependency in the status report.

---

## 12 · `Decimal` money serialises as a JSON string

**Modules 3, 6, 8 · Accepted 2026-08-08, reaffirmed 2026-08-10**

Prisma renders `Decimal` columns as strings, so `price` returns `"499.00"` and
`monthlySalary` returns `"18000"` — not numbers. This surprised the 08-07 cURL
run.

**Decision:** accept it and document it. The alternative — coercing to `number`
at the DTO boundary — reintroduces float error into money, which is the entire
reason the columns are `Decimal(12,2)`.

**Consequence:** every money field in Swagger is typed `string` with an example.
Clients must not `parseFloat` a total for display or arithmetic.

---

## 13 · `Service.allowsCash` — named by a ground rule, absent from the ERD

**Module 3 · Resolved 2026-08-10 · SUPERSEDED BY [#37](#37--serviceallowscash--reopening-13) on 2026-08-11**

> The decision below stood for one day and is now reversed. It is kept in full
> rather than edited, because the reasoning was right at the time and the thing
> that changed was not the ERD — it was that module 7 arrived and made the
> consequence real. Read #37 for what actually happens now.

The **Cash** ground rule names the column outright:

> Pay-after-service in cash is supported, **where `Service.allowsCash` and the
> city allow it**.

ERD v10's `Service` has no such column — and no city-level cash flag either.
What it does have is `Booking.paymentMode` (`online | cash`, frozen at
creation), with the whole cash lifecycle described around that one field.

**Decision:** ERD wins, exactly as in conflict #1. `allowsCash` is **not**
added. Per-service cash gating does not exist in the data model.

**Consequence:** cash eligibility is currently a property of the booking, not
of the service — meaning any service can in principle be booked as cash. If
per-service or per-city cash control is genuinely wanted, that is an ERD change
plus a module 7 (Payments) decision, not something module 3 can smuggle in. The
ground rule's parenthetical is, for now, describing a capability the model does
not have.

---

## 14 · Editor attribution on catalog rows

**Module 3 · Resolved 2026-08-10**

The module 3 plan proposed `updatedByAdminId` on `Service` and
`ServiceCategory` as a cheap partial answer to conflict #9 — record at least
_who last touched the row_. ERD v10 gives neither table such a column.
(`PlatformSetting` has one; the catalog tables do not.)

**Decision:** dropped, and conflict #9's resolution is **revised**. No editor
column is added. Catalog mutations carry no attribution at all until module 15
decides on `AdminAuditLog`.

**Consequence:** "who changed this price?" is unanswerable today — not merely
"who changed it last". This is the sharpest open gap in the module and is
listed as such in the status report. The plan document's §2.3 recommendation is
superseded by this entry.

---

## 15 · Catalog field names — implementation plan vs ERD

**Module 3 · Resolved 2026-08-10**

`MODULE_3_SERVICE_CATALOG_PLAN.md` was written before the ERD was available in
this workspace and proposed names by inference. The ERD disagreed on six:

| Plan proposed             | ERD v10 (implemented) |
| ------------------------- | --------------------- |
| `expectedDurationMinutes` | `durationMinutes`     |
| `price`                   | `flatPrice`           |
| `allowsInstant`           | `supportsInstant`     |
| `allowsScheduled`         | `supportsScheduled`   |
| `allowsRecurring`         | `supportsRecurring`   |
| `parentId`                | `parentCategoryId`    |
| `displayOrder`            | `sortOrder`           |

The ERD also has no `slug`, `iconUrl` or sort column on `Service`, and no
`description` on `ServiceCategory`. All were dropped.

**Decision:** ERD names used verbatim, everywhere — schema, migration, DTOs and
API. The plan document's §3 is superseded by the shipped schema.

**Consequence:** anyone reading the plan should treat §3 as historical. The
authoritative shapes are `prisma/schema.prisma` and
[`ERD_DATA_MODEL_V10.md`](ERD_DATA_MODEL_V10.md).

---

## 16 · Timestamps the ERD does not draw

**All modules · Accepted, pre-existing**

No table in ERD v10 lists `createdAt`/`updatedAt` as columns, except where they
carry business meaning (`Customer.createdAt`, `PlatformSetting.updatedAt`).
Every model in `schema.prisma` has both.

**Decision:** keep the house convention. This predates module 3 — `City`,
`Role`, `Pro` and every other built table already carry them — and the ERD is a
domain diagram, not a DDL listing.

**Consequence:** a mechanical ERD-vs-schema diff will always show these two
columns as extra on every table. That is expected, not drift.

---

## 17 · US-3.4 creates a service "with commission"; US-8.4 wants them separated

**Module 3 · Resolved 2026-08-10**

US-3.4 describes creating a service in one step:

> **State:** `Service` with price, duration, category, **commission type and
> value**.

US-8.4 and US-3.10 pull the other way. US-3.10 is tagged for finance as well as
ops, and US-8.4 insists a repricing screen must make the commission mode
visible precisely because the two are different decisions:

> With `commissionType = flat`, a price cut cuts the platform's margin, not the
> Pro's pay. With `percent`, it cuts both.

**Decision:** separate them. `POST /admin/catalog/services` takes no commission
fields and creates a **draft**; `PATCH /admin/catalog/services/:id/commission`
sets the rate behind its own `catalog.commission.set` permission, seeded to
`finance` rather than `ops`. Two calls reach US-3.4's stated end state.

**Consequence:** an ops admin holding only `catalog.manage` cannot take a
service all the way to live on their own — finance has to set the rate first.
That is separation of duties on the number that determines Pro pay, and it is
deliberate. If it proves to be friction in practice, the fix is to grant `ops`
both codes in the seed, **not** to fold commission back into the create
payload — that would put pay rates behind the catalogue-editing permission.

---

## 18 · "Actual duration is the number commission is calculated from"

**Module 4 · Resolved 2026-08-10**

Module 4 feature 18 reads:

> Actual duration computed from verified start to completion — **the number
> commission is calculated from**

Four sources disagree. The ground-rules table ("duration no longer changes what
a Pro earns"), module 8's preamble, the ERD (`actualDurationMinutes` — "recorded
for reporting, no longer sets the rate"), and US-4.17 outright:

> My commission does not change. One rate per service — a four-hour job pays the
> same as a one-hour one.

**Decision:** the last surviving fragment of the dead `CommissionTier` model,
and cancelled like the rest of it (see #7). `actualDurationMinutes` is computed
at completion, stored, and used for reporting only. Nothing in module 4 exposes
it to a pay calculation.

**Consequence:** a Pro who works four hours on a ninety-minute job earns exactly
the ninety-minute rate. That is the employment model working as designed —
they are salaried, and commission is a per-service constant — but it is the
single most likely thing for a Pro to dispute, so the Pro App should not present
duration anywhere near earnings.

---

## 19 · Coordinates — ERD says `decimal`, the codebase uses `Float`

**Modules 2, 4, 6 · Recorded 2026-08-10**

ERD v10 types every coordinate as `decimal`. Every coordinate already in
`schema.prisma` is a `Float`: `CustomerAddress.pinLat/pinLng`,
`Pro.homeBaseLat/Lng`, `Pro.lastKnownLat/Lng`. This predates module 4.

**Decision:** module 4's new coordinates (`BookingStatusEvent.lat/lng`,
`JobPhotoProof.lat/lng`) use `Float`, matching the codebase rather than the
ERD. Making module 4 the one place that uses `Decimal` would mean coordinates
that cannot be compared against an address pin without a cast, which is worse
than a consistent deviation.

**Consequence:** a mechanical ERD-vs-schema diff shows this on eight columns
across three modules. It should be resolved **all at once** — either the ERD
adopts `float`/`double precision`, or all three modules migrate together. It is
explicitly _not_ module 4's to fix unilaterally.

---

## 20 · The state machine is not linear — payment mode forks it

**Module 4 · Resolved 2026-08-10**

Feature 8 gives one ordered path:

> `created → awaiting_payment → assigning → assigned → en_route → arrived → started → completed`

The **Cash** ground rule contradicts it directly: a cash booking "skips
`awaiting_payment` and dispatches before any money moves", and has no `Order`
row at all.

**Decision:** ground rule wins, and the feature list is implemented as a
**transition table** rather than an ordered list. `created → assigning` is legal
only for cash; `created → awaiting_payment` only for online. One guard
(`isTransitionAllowed`) enforces both, and every one of the 81 possible
(from, to) pairs is asserted in `booking.types.spec.ts`.

**Consequence:** `paymentMode` is frozen at creation and a `CHECK` constraint
bounds it to two values, because a third would silently break the fork and
every report that joins `Order`.

---

## 21 · Recurring pricing — at plan creation or at generation? _(open in US-4.3)_

**Module 4 · Resolved 2026-08-10**

US-4.3 flags it open and says "Currently the latter". The customer persona's own
cross-reference table agrees: "recurring occurrences take the price when
generated, not when the plan was made".

**Decision:** price at generation, from the live catalogue. It needs no extra
column and is the only reading consistent with US-3.5 — a price change applies
to future bookings.

**Consequence:** a customer on a weekly plan can see their price move without
doing anything. Notifications (module 12) should tell them when it does;
silently repricing a standing order is a churn event.

---

## 22 · Rebook and the same Pro _(open in US-4.5)_

**Module 4 · Resolved 2026-08-10**

> If I explicitly want the same Pro, that conflicts with rotation. Unresolved;
> rotation currently wins.

**Decision:** rotation wins. `rebook` copies the service, address and payment
mode, records `rebookedFromBookingId` for lineage, and **never** copies `proId`.
There is no API surface for requesting a particular Pro.

**Consequence:** a customer who liked their cleaner has no way to ask for them
again, and dispatch rule 3 will actively deprioritise that Pro for that address.
The lineage column is there so a future preference feature has the data, but
building one means changing the ranking rules, not module 4.

---

## 23 · When does the chat close? _(open in US-4.8)_

**Module 4 · Resolved 2026-08-10**

> Chat must close some period after completion, or it becomes an unmonitored
> channel between strangers.

**Decision:** writes close `booking.chatWindowHoursAfterCompletion` after
completion (default 24) and immediately on cancellation. **Reads never close** —
the thread is dispute evidence (US-4.24). Enforced server-side; a client-side
check protects nobody.

---

## 24 · Is the customer charged when they are not home? _(open in US-4.15)_

**Module 4 · Resolved 2026-08-10**

> Whether I'm charged a fee is undecided. The Pro is salaried so nothing is owed
> to them, but a wasted visit is a real cost.

**Decision:** not automated. The system records the arrival, every failed OTP
attempt and the grace-window expiry; ops decides between cancelling (window D,
where a fee already exists as a setting) and rescheduling. The admin-side
US-4.15 says the same — "route it to a human".

**Consequence:** if policy later says charge, no new mechanism is needed — set
`booking.cancellationFeeAmount` above zero. Nothing in the code has to change.

---

## 25 · The OTP-at-the-door override _(open in US-4.11)_

**Module 4 · Resolved 2026-08-10**

> If the person at the door isn't me — I sent a relative — the code still goes
> to my phone. **Support needs a documented override.**

**Decision:** `POST /admin/bookings/:id/force-start`, behind its own
`booking.force_start` permission, requiring a written reason of at least ten
characters. It writes a `start_otp_bypassed` event **before** the transition and
attributes the start to `ops`, not to the Pro.

**Consequence:** a forced start is visibly not an OTP-verified start on the
timeline, which is the whole point — a dispute over whether work was consented
to turns on exactly that distinction. The permission is granted to `support`
rather than `ops` in the seed, since it is a support action.

---

## 26 · Cancellation windows are a proposal, not policy

**Module 4 · Resolved 2026-08-10**

The Cancellation & Refund Flow section says so itself: "the timings and fee are
business decisions, but the mechanics are not."

**Decision:** build the mechanics exactly as specified — six windows, the actor
table, the four principles — and put every number in `PlatformSetting`:
`booking.cancellationFeeAmount` (default 0), `booking.paymentHoldWindowMinutes`,
`no_start.graceWindowMinutes`, `booking.chatWindowHoursAfterCompletion`,
`booking.startOtpMaxAttempts`, `booking.taxPercent`,
`booking.recurringGenerateAheadDays`.

**Consequence:** changing cancellation policy is a settings edit, not a
deployment. Two rules are **not** configurable and are enforced in code, because
they are principles rather than tunables: a Pro can never cancel, and the
platform never charges a fee for its own failure to supply.

---

## 27 · `Booking.expectedDurationMinutes` — proposed, then dropped

**Module 4 · Resolved 2026-08-10**

The module 4 plan proposed snapshotting the service duration onto the booking,
so a later catalogue edit could not retroactively resize a sold job (US-3.6).
ERD v10's `Booking` has no such column.

**Decision:** not added — the same ruling as #13 and #14. Instead, `slotStartAt`
and `slotEndAt` are set for **every** booking including instant ones, so
`slotEnd − slotStart` _is_ the duration the job was sold against. The guarantee
is preserved with columns the ERD already has.

**Consequence:** anything wanting the expected duration computes it from the
slot window rather than reading a field. Dispatch (module 5) should size slots
from `Service.durationMinutes` for new work and from the booking's own window
for committed work.

---

## 28 · Invoice tax — added to the price, or contained within it?

**Module 4 · Resolved 2026-08-10**

`Booking.taxAmount` exists in the ERD but nothing says whether the flat price is
tax-inclusive. US-3.2 and US-3.2b are unambiguous about what the customer sees:

> **US-3.2:** a single final number, so there are no surprises at the end.
> **US-3.2b:** I want the invoice to show ₹200 so that nothing is ambiguous.

**Decision:** the flat price is **tax-inclusive**. `taxAmount` records the GST
component _within_ it — `price − price / (1 + rate)` — not an addition to it.
The rate is `booking.taxPercent` (default 18).

**Consequence:** a ₹599 service invoices at ₹599 with ₹91.37 shown as the tax
component. Had tax been additive the customer would have been billed ₹706.82
after being quoted ₹599, which is precisely the surprise US-3.2 exists to
prevent. Finance should confirm this matches how the catalogue prices were set.

---

## 29 · Rule 2 needs travel time; Geo & Routing does not exist

**Module 5 · Resolved 2026-08-10**

Feature 6 ranks candidates by "computed travel time". Module 13 owns that and
is not built.

**Decision:** a `TravelTimePort` owned by module 5, with a haversine stand-in
that divides straight-line distance by `dispatch.assumedSpeedKmph` (default 20).

Unlike module 4's payments stub this one **deliberately returns a usable
answer**, because crow-flight distance ranks candidates correctly nearly always
at city scale — the ordering between a Pro 3 km away and one 20 km away does
not invert once you follow real roads.

**Consequence:** good enough to _rank_, not good enough to _quote_. Module 4's
tracking view still returns a null ETA rather than publishing a number derived
from this, and it should stay that way until module 13 lands.

---

## 30 · "Redis-queued intake" with no worker process

**Module 5 · Resolved 2026-08-10**

Feature 1 wants one queued job per booking. This codebase has no job runner —
module 4's recurring generator is an admin-triggered route for the same reason.

**Decision:** implement the queue for real (a Redis list, `RPUSH` on booking
creation) and drain it from an admin route. The per-booking `SET NX PX` lock is
what makes draining safe from anywhere, so the _trigger_ is not load-bearing
and swapping in BullMQ later replaces the drain loop only.

**Consequence:** assignment is asynchronous but not yet automatic — something
has to call the drain. That is a deployment concern, not a design one.

---

## 31 · A supply gap is not a dispatch failure

**Module 5 · Resolved 2026-08-10**

US-5.5 and US-5.10 describe different situations, and US-5.5 is explicit about
why conflating them is harmful:

> A structural supply problem dressed as a per-booking error will be triaged as
> a bug for months. Separate the two.

**Decision:** two outcomes. `no_supply` — nobody holds this service here at all,
Rule 1's pool was empty. `exhausted` — candidates existed and were all tried or
excluded. Different values, different ops queues, both surfaced by
`GET /admin/dispatch/unassignable`.

---

## 32 · Module 5 cannot simply re-bind module 4's `DISPATCH_PORT`

**Modules 4 + 5 · Resolved 2026-08-10**

Nest resolves providers per module. `BookingsService` lives in
`BookingsModule`, so it receives _that module's_ `DISPATCH_PORT` binding no
matter what `DispatchModule` declares. Verified empirically — the naive
approach left `BookingsService` holding the no-op.

Making `BookingsModule` import `DispatchModule` would work and would invert the
dependency the port exists to prevent.

**Decision:** the no-op is a **delegate**. It holds an optional real
implementation and forwards to it when present; `DispatchModule` registers the
real adapter into it at construction. Module 4 still imports nothing from
module 5, and the presence of `DispatchModule` in `AppModule` is the entire
switch between manual and automatic assignment.

**Consequence:** asserted in `test/module-graph.e2e-spec.ts`, because a
registration that silently failed would look exactly like a working system that
never assigns anything.

---

## 33 · `ProCountersService` methods duplicated work their callers now own

**Modules 5 + 6 · Resolved 2026-08-10**

Three of its four methods were written when module 4 and module 5 did not
exist, so each owned the _transition_ as well as the counter. As real callers
arrived, each one broke in the same way — silently:

| Method                  | What it also owned                          | How it failed                                                                                                                                 |
| ----------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `recordCompletion`      | Set `status`/`completedAt`, wrote the event | Returned early on `status === 'completed'` — the state its caller hands it. `completedJobs` never moved                                       |
| `recordOffer`           | Created the winner's candidate row          | Used that row's existence as its idempotency guard; the engine writes it first, so it always returned early. `assignmentsOffered` never moved |
| `recordAcknowledgement` | Sets timestamps, event, counters            | Correct — but the _caller_ duplicated the update first, flipping `assignmentOutcome` off `pending_ack` so the counter refused its own work    |

**Decision:** counters own only counters. Each is now idempotent via its own
marker event rather than via a row some other module writes, and callers do the
transition. `recordOffer` upserts the candidate row with an empty `update` so
the engine's score inputs survive.

**Consequence:** every one of these was invisible to unit tests, which mock
Prisma and assert on calls. They surfaced only when a real caller met a real
database. Worth remembering when module 10 finally calls `recordReview` — it is
the one method that has still never run.

---

## 34 · A DTO documents the response; it does not filter it

**Module 3 · Found by cURL testing 2026-08-10**

`ServiceDto` correctly omits `commissionType` and `commissionValue`, and the
Swagger contract test asserted that it does. The **unauthenticated** catalogue
endpoints returned them anyway: the controller returns the Prisma row, the
response interceptor serialises whatever it is handed, and the
`@nestjs/swagger` plugin reads the DTO only to generate documentation.

US-3.2's ripple — "the platform/Pro split never appears on any customer-facing
surface" — was therefore violated on four public routes while the published
OpenAPI contract said otherwise.

**Decision:** customer-facing reads go through an explicit mapper
(`toPublicService`). DTOs stay documentation; filtering is code.

**Consequence, and the wider lesson:** a passing Swagger contract test proves
the _schema_ is right, not the _payload_. Any future endpoint that must withhold
a field needs a mapper and a test that inspects a real response body — which is
precisely what cURL testing caught and what unit tests, which mock the layer
below, structurally cannot.

---

## 35 · Cash is named as its own store of record, and the ERD has nowhere to put it

**Module 7 · Resolved 2026-08-11**

The module 7 mode table is explicit about where cash lives:

> | Cash | `cash` | After completion, at the door | **`Booking.cashCollectedAmount`** |

and features 13–16 name three more things: `cashCollectedAt`,
`Pro.cashInHand`, and a handover with two actors and two timestamps.

**ERD v10 contains none of them.** Its `Booking` block ends at
`cancellationFeeAmount` / `refundedAmount`. Its `Pro` block has `monthlySalary`
and nothing about cash. There is no handover table. The only trace of the whole
concept anywhere in the ERD is a comment on `LedgerEntry.debitAccount`:
`cash_in_hand:<proId>`.

**Decision:** add all four. The precedence rule still holds — this is not the
ERD losing, it is the ERD being silent about a mechanism the ground rules
describe in detail.

The distinction from #13 is what makes this consistent rather than convenient.
#13 declined a **gate** that `Booking.paymentMode` already expressed; these are
**storage** with no alternative expression:

| Added                                            | Why nothing else can hold it                                       |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| `Booking.cashCollectedAmount`, `cashCollectedAt` | The named store of record. Without it, cash has none               |
| `Booking.cashDeclinedAt`, `cashDeclinedReason`   | Feature 17 needs unpaid-completion distinguishable from unrecorded |
| `Pro.cashInHand`                                 | Feature 16 gates dispatch on it, per candidate                     |
| `CashHandover`                                   | Declare → confirm is two actors and two timestamps                 |

**`Pro.cashInHand` is a cache of the ledger, not the ledger.** It has exactly
the relationship to `Booking` that `Pro.completedJobs` already does, and the
same failure mode — it drifts, and a nightly rebuild is what makes it
authoritative. It exists as a column only because dispatch cannot afford a
ledger aggregate per candidate.

**Consequence:** four columns and a table that no ERD diagram shows, which is a
real cost when the next person reads the ERD as the map. Mitigated by keeping
the ERD's own vocabulary (`cash_in_hand:<proId>` is the account name module 9
will post to) and by feature 18's reconciliation, which is the check that the
cache still agrees with the bookings behind it.

---

## 36 · `paymentStatus = paid` means two different things

**Module 7 · Resolved 2026-08-11 · accepted, not fixed**

For an online booking, `paid` means the platform has the money. For a cash
booking, it means **an employee is carrying banknotes**. The module 7 feature
list states this plainly and does not resolve it, and neither do we.

**Decision:** keep the single column. Splitting it into `paymentStatus` plus a
`custodian` would be more honest and would touch module 4's state machine,
module 8's commission trigger and every report — for a distinction that
`paymentMode`, sitting in the same row, already carries.

**The four consequences, accepted explicitly:**

1. **No `Order` row for cash.** Any report joining `Order` silently
   undercounts every cash booking. The most likely bug this module can cause,
   and the reason `GET /admin/orders` says so in its own description.
2. **`paid` is not custody.** Financial reporting must read `paymentMode`
   alongside it. There is no way to enforce this in code; it is a rule readers
   have to know, which is why it is written on the column, the DTO and the
   admin route.
3. **Cancellation fees are uncollectable on cash.** No instrument, no balance.
   Late cancellation is free for a cash customer and costs a Pro their travel
   each time. Module 4 already computes the fee; for cash there is nothing to
   charge it against, and no attempt is made to net it off a future job.
4. **Handover is the only thing that clears a balance.** Commission never
   offsets it (feature 15), so a Pro who stops handing over accumulates
   indefinitely. Two operational numbers carry the whole risk — the ceiling
   and the handover cadence.

**What we did about (4):** the ceiling is now
`payments.cashInHandCeilingAmount` (default ₹10,000, city-scoped) and is
enforced — a Pro over it stops receiving cash work. **The cadence is still
undefined and is not enforced anywhere.** Nothing chases a Pro who simply never
declares a handover; the ceiling caps the exposure per Pro but does not
recover it. That is the one part of this feature that remains genuinely open.

---

## 37 · `Service.allowsCash` — reopening #13

**Modules 3 + 7 · Resolved 2026-08-11 · reverses #13**

#13 declined the column one day earlier and said why: the ERD wins, and
per-service cash gating does not exist in the data model. It also wrote its own
appeal route —

> If per-service or per-city cash control is genuinely wanted, that is an ERD
> change plus a **module 7 (Payments) decision**, not something module 3 can
> smuggle in.

This is that decision.

**What changed is not the ERD.** It is that #35 and #36 made the cost of cash
concrete: an uncollectable cancellation fee, a Pro carrying banknotes to a
ceiling, and no way to recover a balance except in person. Those costs scale
with the price of the job. A ₹4,999 deep clean and a ₹599 AC service are not
the same risk, and `Booking.paymentMode` cannot express the difference because
it is set per booking, by the customer, after the decision has already been
made for them.

**Decision:** both gates, both server-side, and deliberately not the same
mechanism.

| Gate        | Mechanism                                   | Why that one                                                                                                                                   |
| ----------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Per city    | `payments.cashEnabled` in `PlatformSetting` | Zero schema. `PlatformSettingsService` already resolves city over global, and ops can close cash in a city during an incident without a deploy |
| Per service | `Service.allowsCash` column, default `true` | Seven `payments.cashEnabled.service.<id>` rows would be a worse database than one boolean                                                      |

The column ships in **its own migration** (`20260811120100_add_service_allows_cash`)
so it can be dropped whole — schema, migration and the guard that reads it —
without unpicking the rest of module 7.

`allowsCash` is returned by `toPublicService`, unlike `commissionType` and
`commissionValue` (#34). It says nothing about margin, and the app has to know
which modes to offer _before_ the customer picks one, because `paymentMode` is
frozen at creation.

**Consequence:** `services` is a module 3 table and this is a module 7 change to
it — a coordination event under the ownership rule, not a unilateral edit. If
the catalogue owner would rather it did not exist, the fallback is the city
gate alone, which is enforceable and honest; feature 11 then degrades to
city-scoped and this section records that it did.

---

## 38 · The webhook HMAC needs the exact bytes; Fastify had already parsed them

**All modules · Resolved 2026-08-11**

Razorpay signs each webhook with an HMAC-SHA256 over the **bytes it delivered**.
`main.ts` created the app with no raw body, so the only thing a handler could
verify against was the parsed object re-serialised.

That does not work, and it fails in the worst possible way. `JSON.parse` →
`JSON.stringify` does not round-trip key order, unicode escaping or whitespace.
Verification would succeed whenever V8's serialisation happened to match
Razorpay's and fail when it did not — intermittently, unreproducibly, on the
code path that decides whether a customer has paid.

**Decision:** `NestFactory.create(..., { rawBody: true })`.

**Consequence:** a shared-file change made for one module's benefit, which is
exactly the kind of edit the ownership rule says to isolate. It is one option
in one call, commented with its single reason, and it is inert for every other
route — nothing else in the codebase reads `request.rawBody`. There is a spec
that fails if it is ever removed: the webhook service rejects a delivery with
no raw body rather than falling back to the parsed one.

---

## 39 · The global `ValidationPipe` would reject every webhook

**Modules 1 + 7 · Resolved 2026-08-11**

`VALIDATION_PIPE_OPTIONS` sets `whitelist` and `forbidNonWhitelisted`, and
`API_CONVENTIONS.md` §3 is explicit that this is deliberate — "a typo'd field
fails loudly instead of looking like it saved".

That reasoning holds for bodies we designed. Razorpay's webhook payload is a
deep object of **their** fields, versioned by them, and it grows. Applying
`forbidNonWhitelisted` to it means their next release 400s every delivery, and
because a 4xx is not retried, the payments those deliveries carried are lost
until someone notices.

**Decision:** the webhook endpoint takes **no DTO**. It reads the raw body,
verifies the HMAC, then parses and narrows only the four fields it uses.

The same reasoning explicitly does **not** extend to
`POST /bookings/:id/payment/verify`. That body is ours — three known fields —
and validates normally, including a regex on the signature.

**Consequence:** one endpoint in the API is unvalidated at the framework level,
so its parsing is hand-written and its types are hand-narrowed. The safety it
gives up is real; what replaces it is that nothing is trusted anyway — the HMAC
runs before the parse, and a malformed payload is acknowledged and ignored
rather than throwing.

---

## 40 · Idempotent webhooks, with no table to hold event ids

**Module 7 · Resolved 2026-08-11**

Feature 5 requires duplicate deliveries to be safe. The obvious implementation
is a `WebhookEvent` table keyed on Razorpay's event id — and it is the one
thing this module is built not to have. The stated trade-off is:

> In exchange, there is **no local copy of payment data** to drift out of sync
> with the gateway.

A table of every event they ever sent us is precisely that copy.

**Decision:** idempotency by construction, in three parts, with Redis as an
optimisation that correctness does not use.

1. **Convergent writes.** `capturedPaymentId`, `paymentMethod`, `amountPaid`
   and `paidAt` are all read from the event payload or from the row itself —
   never from the clock. Replaying a capture five times produces a
   byte-identical row.
2. **Forward-only status.** `advanceStatus` is a max, not an assignment.
   Razorpay does not guarantee ordering and `payment.captured` regularly
   arrives before `payment.authorized`; without this, that pair alone would
   leave a genuinely paid order at `attempted` — money taken, nothing
   dispatched.
3. **Capture written once.** A second, _different_ payment id against a paid
   order is a duplicate-charge signal. It is logged at error level and
   refused, never applied, and reconciliation surfaces it. Overwriting would
   erase the only evidence.

Redis `setIfAbsent` short-circuits the common redelivery before any query runs.
When Redis is unreachable the event is processed anyway — processing twice is
safe by (1)–(3); not processing leaves a paid booking undispatched.

**Consequence:** every future write in this module must be convergent, and
nothing enforces that but review. The side effects that genuinely must run once
— the booking transition, dispatch, the ledger entry — are gated on
`isForwardStatus`, which is the one place that rule is visible.

---

## 41 · A valid signature is not a successful payment

**Module 7 · Resolved 2026-08-11**

Feature 3 says the server must verify the signature before treating a payment
as successful, and it is easy to read that as sufficient. It is not.

A Razorpay checkout signature is an HMAC over `order_id|payment_id`. It proves
Razorpay produced that pair. It says nothing about:

- whether the payment was **captured** or merely authorized;
- **how much** was paid;
- which **order** it was actually against;

and it is **replayable** by the client that legitimately received it — the
attack being a customer who paid for booking A and posts their own valid
signature against booking B.

**Decision:** the signature is a precondition, not a proof. After it passes,
the server fetches the payment from Razorpay by id and refuses unless
`status === 'captured'`, `order_id` matches, and the amount equals the order's
to the paisa. Only then does anything move. The webhook remains the authority;
verify exists so the customer sees their booking dispatch immediately rather
than waiting on a delivery.

**Consequence:** every successful checkout costs one extra gateway round trip,
and a slow Razorpay makes the customer wait. Accepted — the webhook completes
the booking regardless if this call is missed entirely, so the cost is latency
on the happy path and nothing on the failure path. There are four specs on
this, one per way a signed payment can still be unusable.

---

## 42 · Serviceability was city-wide; the business is area-wide

**Modules 3 + 13 · Resolved 2026-08-11 · geometry revised the same day**

Conflict #8 settled that "per-city activation" meant `City.isActive` and not
per-city services, and #11 left pricing national. Both were right, and together
they left exactly one lever: a city is open or shut, and every service in it is
equally available everywhere in it.

The business does not work that way. It operates neighbourhood by
neighbourhood, and "AC repair in Vijay Nagar but not Rau" was **inexpressible**
— not hard, not unmodelled, impossible.

**Decision:** add `Area`, `AreaService` and `ProArea`, none of which exist in
ERD v10. `Booking.areaId` joins them, frozen at creation.

### The geometry: rectangles, after a false start with circles

> **This was built as circles first, then changed.** The original brief
> specified `centerLatitude`, `centerLongitude`, `radiusKm` and haversine, and
> that is what shipped. It is recorded here rather than quietly rewritten,
> because the reason for the change is the most useful thing in this section.

An area is an axis-aligned **rectangle**: `minLat`, `maxLat`, `minLng`,
`maxLng`. Not PostGIS — the entire geometry question is confined to one
function (`LocationService.resolveArea`), so a `geography(Polygon)` column can
replace it later without a single caller changing.

**Why the shape changed.** The brief also said areas "should ideally not
overlap", and that is impossible with circles: **circles cannot tile a plane.**
Disjoint circles leave wedge-shaped gaps between them where real customers
live. The circle build managed this — overlap deliberately, resolve ties by
nearest centre, sample for gaps with a coverage endpoint — and it worked, but
every part of it was machinery for a problem the shape had created.

Rectangles do not have the problem. A grid **tiles exactly**, so:

|                  | Circles                                           | Rectangles                  |
| ---------------- | ------------------------------------------------- | --------------------------- |
| Gaps and overlap | Inherent; managed by nearest-centre and a sampler | Absent by construction      |
| Resolution       | Load every active area, haversine each            | **One indexed range query** |
| Coverage         | Sampled, approximate                              | Guaranteed by the generator |
| Tiebreak         | Always needed                                     | Only for hand-edits         |

**Bounds are half-open: `min <= value < max`.** This is the detail that makes
tiling work, and it is not incidental. Adjacent cells share an edge _exactly_ —
one cell's `maxLat` is bit-identical to its neighbour's `minLat`, because the
generator derives both from the same origin and step. With closed bounds a pin
on that edge matches two cells; with half-open bounds it matches precisely one.
There is a spec that asserts this by sweeping points across a generated grid
and requiring at most one match.

Overlap's meaning inverted with the shape. It used to be healthy; it is now a
**warning** that a hand-edit broke the partition, which is what
`GET /admin/areas/:id/overlaps` reports. It should be empty. Touching edges do
not count — adjacent cells share them by design.

Where a hand-drawn map does produce two matches, the **smallest box wins** —
"the most specific answer" — with the id as a final tiebreak so the result is
stable rather than merely usually-stable. That also makes a useful pattern
possible on purpose: a precise box inside a larger fallback.

`haversineKm` survives the change and moved to this module, because dispatch
still ranks candidates by distance. It simply no longer decides which area a
pin is in.

**Consequence:** three tables the ERD diagram does not show, recorded in
`ERD_DATA_MODEL_V10.md` under a dated heading so the two do not silently
diverge. And a second lever on availability, which means "why can't this
customer book?" now has two possible answers instead of one — the API returns
`LOCATION_NOT_SERVICEABLE` and `SERVICE_NOT_AVAILABLE_IN_AREA` separately for
exactly that reason.

**Deliberately not added:** `CustomerAddress.areaId`. It would be a cache of
`resolveArea(pinLat, pinLng)` that nothing maintains — the customers module
cannot reach module 13 without a dependency cycle, and booking re-resolves from
the pin regardless, because areas get redrawn after an address is saved. The app
asks `GET /geo/serviceability` before saving, which answers the same question
without a column that can go stale.

---

## 43 · A mandatory gate that can only reject, added to a live product

**Module 13 · Resolved 2026-08-11**

The area check is the first rule in this codebase whose _only_ possible effect
is to refuse a booking that would previously have succeeded. Every other gate
added so far either created something (`Order`) or narrowed a set that was
already narrowed (dispatch eligibility).

Shipping it enabled would have rejected **every booking in every city** on
deploy. Not because the rule is wrong — because no areas are drawn yet, so no
pin resolves to one, so every booking fails a check that is technically working
perfectly.

**Decision:** `geo.enforceAreaServiceAvailability`, city-scoped, default
`false`. While it is off, the area is still **resolved and recorded on the
booking**, and every would-be rejection is logged with its reason.

The intended sequence is: ship off → ops maps a city → read the log to see what
the gate _would_ have refused there → flip that city's row to `true` → the gate
becomes real in that city and nowhere else.

**Consequence:** for a period, `Booking.areaId` is populated by a rule that
cannot enforce itself, and a booking can exist for a service its area does not
list. That is the intended state, not a gap — the alternative was a flag day
where the map has to be perfect and complete before anything works at all. The
same reasoning governs the `NoOpServiceabilityService` stub, which is permissive
for identical reasons rather than by omission.

---

## 44 · The proposed area plan contradicted four shipped decisions

**Modules 4, 5, 6, 13 · Resolved 2026-08-11**

The plan that introduced service areas also proposed, in passing, four changes
to things already built and working. Recorded here because each was considered
and rejected on its merits, not overlooked.

| Proposed                                                                                | Decision                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Replace the 9-state booking machine with `PENDING → ASSIGNED → IN_PROGRESS → COMPLETED` | **Rejected.** Deletes `awaiting_payment` (module 7's fork), `en_route`/`arrived` (what tracking and the no-start window key off) and `assigning` vs `assigned` (#31). Its real point — no `ACCEPTED`/`REJECTED` — was already true |
| "Do NOT use Redis GEO"                                                                  | **Rejected.** Already load-bearing in three modules: the Pro location ingest, dispatch scoring's origin lookup, and the customer's live pin. The plan's own §10 asks for exactly what it already provides                          |
| New `Employee` / `EmployeeService` entities                                             | **Rejected.** These are `Pro` and `ProService`. Only `EmployeeArea` was new, and it landed as `ProArea`                                                                                                                            |
| Employees must not accept/reject or set their own availability                          | **Already true.** Module 5 has no accept/decline at any depth, and `setAvailability` exists only on the admin controller                                                                                                           |

**Consequence:** the vocabulary in the product documents ("employee") and the
vocabulary in the schema (`Pro`) differ, deliberately. Renaming six tables and
every `/pros/me/*` route to close a naming gap would be pure churn; the docs can
say "employee" while the code says `Pro`, as they already do.

---

## 46 · A service sellable in an area nobody is staffed for

**Modules 5 + 13 · Resolved 2026-08-11**

`AreaService` says "we sell AC repair in Rau". `ProArea` plus eligibility says
"someone can actually do it in Rau". They are configured **independently, by
different people, for different reasons** — the catalogue owner and whoever
runs staffing — and until now nothing noticed when they disagreed.

You could switch a service on in an area with zero Pros posted to it. The
catalogue would advertise it, `/geo/catalog` would report it available, a
customer would book it, and dispatch would then fail to assign — with the
booking stranded in `assigning` and no alert, because there is no scheduler.

**The failure has two shapes and they need different answers:**

| Shape                          | What it is                                         |
| ------------------------------ | -------------------------------------------------- |
| Nobody is posted here at all   | A **configuration** mistake. Permanent until fixed |
| Posted, but all busy right now | A **timing** problem. Fixes itself in an hour      |

This is #31's `no_supply` versus `exhausted` distinction one level up, and
collapsing the two is the same mistake: a staffing gap gets triaged as a
dispatch bug for months.

**Decision: gate the first, widen for the second.**

**Config time.** Activating a service in an area now requires at least one
approved Pro posted there who holds it, or the call fails with
`AREA_NOT_STAFFED_FOR_SERVICE`. This extends US-3.9's city-launch supply gate
down one level — and it is now the more likely mistake of the two, because
areas get configured far more often than cities get launched. It fails at the
moment someone makes the error, to the person making it, which is the only
time it is cheap to fix.

Deliberately **only activation** is gated. Switching a service _off_ must
always work, or an area that lost its last Pro could never be corrected —
which is exactly when someone needs to switch it off. And the check counts
approved Pros while **ignoring `isAvailable`**: that flag is today's roster,
and a service must not become unsellable because everyone happens to be off
shift this afternoon.

**Run time.** When the area's own pool is momentarily empty, dispatch climbs a
ladder — the area, then its neighbours, then the whole city — and stops at the
first rung that yields anyone. Refusing a customer because a willing Pro sits
three kilometres outside a grid line an admin drew would be an arbitrary
boundary doing real damage.

Neighbours are found by **expanding the area's rectangle and asking what it
then overlaps** — two lines, and only possible because #42 made areas boxes.
Same city only: widening a Bhopal booking into Indore because the grids happen
to abut would be worse than not assigning it.

**Widening is never silent.** `AssignmentCandidate.searchTier` records which
rung produced each candidate, so "we served Rau from Vijay Nagar eleven times
this week" is a query rather than an inference from which Pro happened to win.
Without that column the only trace would be the winner's home address.

`dispatch.allowWidenBeyondArea` turns the ladder off per city for anyone who
wants strict boundaries.

**Consequence:** a city can now be in a state where a service is _bookable_
and _unstaffed_ — the gate only stops it being switched on, not staff leaving
afterwards. Nothing yet re-checks. The `searchTier` index is the evidence
someone will eventually build that alert on.

**A bug found while building this.** The first version returned `[]` when
nobody was posted to an area, which would have excluded every Pro in the city
and reported `no_supply` for a city that had simply never had its Pros posted
— the exact confusion #31 exists to prevent, reintroduced by the thing meant
to fix it. `null` (no restriction) and `[]` (restrict to nobody) look alike
and mean opposite things; the caught case is now a spec.

---

## 47 · The 60-minute travel cap was a guess refusing real customers

**Module 5 · Resolved 2026-08-11**

`dispatch.maxTravelMinutes` excluded any Pro whose estimated travel exceeded
60 minutes, as `out_of_range`. Two things were wrong with it.

**It was a guess applied to a guess.** The travel estimate is crow-flight
distance over an assumed 20 km/h — no road network, no traffic (#29). Comparing
that to a fixed 60 gave an arbitrary number the precision of a measurement it
never had. Worse, the two settings multiplied into an **undocumented 20 km
service radius** (`speed × maxMinutes ÷ 60`), so changing the assumed speed
silently moved the boundary of where the platform operated.

**It could only refuse.** A booking nobody within 60 minutes could take became
`no_supply` — a customer turned away while a Pro 65 minutes out sat idle and
willing.

**Decision: remove the exclusion.** Nothing is refused for distance. Proximity
still dominates the ranking — it is half the weight — but through a curve that
**decays and never reaches zero**:

```
0 min → 1.00     target → 0.50     2× → 0.33     4× → 0.20
```

The old form (`1 - travel / maxTravel`, clamped at zero) could not survive the
cap's removal: past the ceiling every candidate would tie at exactly 0, so a
70-minute Pro and a 200-minute one would rank identically and **rotation would
silently pick the winner**. The decay keeps distance ordering intact at any
range.

`dispatch.travelSoftTargetMinutes` replaces the cap and is a **scale, not a
limit**. Doubling it admits nobody new — nobody was being refused — it flattens
the curve, making dispatch weigh distance less against rating and rotation.
That is a genuinely different knob from the one it replaced, which is why it
got a new name rather than a new default.

**What bounds the search now:** the city. `findEligiblePros` has always
filtered by `cityId`, and that is a real operational boundary rather than a
number derived from two guesses.

**Consequence:** on a thin night a booking can be assigned to a Pro an hour and
a half away, where before it would have been refused. That is the intended
trade — a long trip beats no service — but it must not be invisible, so a
winner past the soft target is logged with its travel time and search tier.
`out_of_range` is no longer produced; the value stays legal so historical rows
still read, and `dispatch.maxTravelMinutes` is kept with a description
explaining its retirement rather than deleted, so a runbook reference resolves
to an explanation instead of an absence.

**Still true, and still the real limitation:** the estimate is crow-flight. A
Pro across a river ranks better than the road says. Google Routes (module 13,
instalment 2) is the fix; removing the cap does not pretend otherwise.

---

## 48 · A generated grid is thirty-six squares nobody can identify

**Module 13 · Resolved 2026-08-11**

`generateGrid` names cells by position — `A1`, `C3` — because it genuinely does
not know what is on the ground. That was fine as a generator output and useless
as a product: an admin's only route from `C3` to "Vijay Nagar" was copying four
coordinates into Google Maps, **once per cell**, thirty-six times per city.

That is not merely tedious. It is the step where somebody mislabels a cell, and
the mislabelling only surfaces later as bookings going to the wrong Pros.

**Decision: reverse-geocode each cell's centre into a suggestion**, using the
adapter module 2 already has, and let the admin review rather than research.

Three things make it safe:

|              |                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nameSource` | `generated` \| `geocoded` \| `manual`. The pass **only ever overwrites `generated`**, so a suggestion can never clobber a name a person chose — and re-running it, or running it while someone is renaming, is safe |
| `gridRef`    | The positional label kept **after** renaming. Ops keeps saying "cell C3" long after it became "Vijay Nagar", and a rename would otherwise destroy that shared reference                                             |
| Background   | The geocoder honours Nominatim's one-request-per-second policy, so 36 cells is over half a minute. The route starts the pass and returns a count; holding a request open for that is not an option                  |

A cell the geocoder cannot place **keeps its placeholder** rather than being
given an invented name, and the next pass retries it. One unreachable cell does
not abandon the other thirty-five.

Every area also gained its **centre, size in kilometres and a Google Maps
link** — all derived from the bounds, none stored. Four raw coordinates tell a
human nothing; one click tells them everything. That half is cheap and works
even when geocoding fails.

**Consequence, and a boundary crossed:** `AddressGeocoderService` is now
exported from module 2 and consumed by module 13. One adapter, one cache and
one rate limiter shared — a second client would double the request rate against
a service whose politeness policy is the entire reason that limiter exists.
Longer term the adapter belongs _in_ module 13, which owns geography and is
where the Google Places swap will land; exporting it was the smaller step.

**Also:** the customer-facing "we are available in…" list now maps to a narrow
`PublicAreaDto`. Publishing `AreaDto` there would tell a customer that "Vijay
Nagar" is really cell C3 of a generated grid nobody has reviewed, and hand out
the bounds of the entire service map. Conflict #34's rule, applied again: the
mapper filters, the DTO documents.

---

## 49 · The geocoder had two owners and could have neither

**Modules 2 + 13 · Resolved 2026-08-11**

Reverse geocoding lived in `customers` because address-saving was its only
caller. Then module 13 needed it to name grid cells, and the obvious moves were
all wrong:

- **Leave it in module 2 and export it** — which is what #48 did. It works, but
  `geo` already sits downstream of `customers` (`geo → bookings → customers`),
  so the dependency runs the wrong way for something neither module owns.
- **Move it into module 13** — a cycle, immediately: `customers` would have to
  import `geo`, which imports `bookings`, which imports `customers`.
- **Give each module its own client** — two caches and, fatally, **two rate
  limiters**. OpenStreetMap's limit is one request per second _for the whole
  application_; two independent limiters is a way of breaking it twice.

**Decision:** neither owns it. `src/geocoding` sits beside `redis/` and
`storage/` as infrastructure, `@Global`, and both modules inject `GEOCODER`.

### Two adapters, chosen by presence

Google when `GOOGLE_MAPS_API_KEY` is set, Nominatim otherwise — the same
presence-based selection the OTP provider already uses to swap the mock for
Slide. `GEOCODER_PROVIDER` overrides, and **refuses to boot** if it names
Google without a key rather than quietly using a different provider than the
operator asked for.

`minIntervalMs` is on the interface rather than in the caller, and that matters
more than it looks: Nominatim declares 1100ms, Google declares 0.
`AreaNamingService` reads it instead of hard-coding a delay, so **configuring a
key makes a 36-cell naming pass roughly thirty times faster** without a line
changing there.

**A bug this found in its own adapter.** Every failing Google status —
`REQUEST_DENIED`, `OVER_QUERY_LIMIT` — arrives with an empty `results` array.
Testing emptiness first, as the first draft did, reported a misconfigured key or
an exhausted quota as "no address could be resolved for this pin": our billing
problem, rendered to every customer as a coverage problem, with nothing in the
logs to say otherwise. Status is now judged before emptiness, and a spec pins
the distinction.

**Consequence:** the address a customer sees changes shape when the key is
added — the two providers format `addressLine` quite differently — so the cache
key is provider-scoped and `provider` is published on the response.

---

## 50 · Socket authentication in `handleConnection` loses a race it cannot win

**Module 4 · Resolved 2026-08-11 · found by live testing**

`JwtAuthGuard` is HTTP-only, so the tracking gateway verified its token in
`handleConnection` — which is `async`. Socket.IO fires `connect` on the client
as soon as the transport is up, and every sensible client emits its first
message right there.

So the first message races the verification, and usually wins. Live testing
showed it plainly: a **valid** customer, with a **valid** token, got
`{"ok":false,"error":"Not authenticated"}` on their first `track`.

**Decision:** authenticate in Socket.IO **handshake middleware**
(`server.use()`), which completes _during_ the handshake. By the time a message
can be received the identity is attached, or the socket was never accepted. A
rejected handshake surfaces as `connect_error`, which a client can tell apart
from a dropped network.

**Consequence:** the failure now lands at the right moment — a client with an
expired token cannot connect at all, rather than connecting and being baffled
by every message failing.

**Worth remembering:** this was invisible to a unit test that awaited
`handleConnection` before calling `track` — because awaiting is exactly what a
real client does not do. The spec now drives the middleware the way Socket.IO
does, so the ordering guarantee is asserted rather than assumed.

---

## 51 · The bank account is stored masked, so it cannot be paid to

**Module 2/8 · Resolved 2026-08-12 · found while building disbursement**

`ProBankAccount.accountNumberMasked` is exactly what it says — and it is worse
than a storage choice. `CreateBankAccountDto` **rejects** anything that is not
already masked:

```ts
@Matches(/^X{4,}\d{4}$/, { message: 'accountNumberMasked must contain only masking Xs and the last 4 digits' })
```

So the unmasked number never reaches this server at all. There is no
verification step holding it, no column to fill in later, and no point in the
request lifecycle where module 8 could have obtained it. **This platform cannot
make a bank transfer**, and no amount of work inside module 8 changes that.

Nothing in the schema is wrong; the two requirements were simply never held up
against each other.

**Decision: UPI is the payout rail.**

`ProBankAccount.upiId` is stored in full and RazorpayX pays to a VPA. Module 8
creates the contact and the VPA fund account on the first payout and reuses both
forever after. A Pro with no UPI id is **not payable**, and that is surfaced
where it can be acted on:

- `POST /admin/payouts/generate` skips them with `NO_PAYABLE_DESTINATION` and
  says what to add. Ops sees it beside everyone else who is not getting paid.
- `disburse` refuses with a `422` naming them, as a second line of defence.

`ProBankAccount.razorpayxFundAccountId` and `Pro.razorpayxContactId` exist and
are honoured if present, so a bank rail can be added later without touching this
module.

**Consequence to accept:** every Pro must have a UPI id to be paid. In India in
2026 that is close to universal, but it is a real operational requirement and
onboarding has to enforce it rather than discover it on payday.

**What enabling bank transfers would take** — a module 2 decision, not a module
8 one:

1. `CreateBankAccountDto` accepts the **full** account number.
2. The service sends it straight to RazorpayX, stores the returned
   `razorpayxFundAccountId`, and persists only the masked form.
3. The full number is never written to a column — the masking rule survives; it
   is the _transport_ that changes, not the storage.

That is the right long-term design. It is also a change to how a piece of
regulated data enters the system, which is why it is written down here as a
decision for a human rather than made quietly in a payout service.

---

## 52 · "Commission" names the Pro's pay here, not the platform's cut

**Module 3/8 · Resolved 2026-08-12 · CONFIRMED WITH THE BUSINESS 2026-08-12**

In most marketplaces "commission" is what the platform takes. Read
`BookingCommission` and it is the opposite: `commissionAmount` feeds
`netPayable`, which is what the Pro is paid, and `platformAmount` is the
remainder.

Both readings are defensible from the word alone. Only one is defensible from
the schema, and the schema is what the code does.

**Decision:** `commissionAmount` is **what the Pro earns**. `platformAmount` is
`customerFlatAmount - commissionAmount`, always computed as the remainder so the
two provably sum to the price — enforced by a CHECK constraint rather than
trusted to the calculator.

**Consequence to accept:** the name is a trap for anyone who has worked on a
marketplace before, and no amount of schema comment reaches the finance admin
typing into the box. So the direction is stated in three places a person
actually reads: the column comment, the `rate` field on every earnings DTO, and
`SetCommissionDto`'s description. The repricing screen must say _"Pro earns 30%
of the job price"_ in words, not `commissionValue: 30`.

If this is ever read the other way round, every Pro is paid 30% where they
should have had 70%, and nothing in the system disagrees with itself — which is
precisely why it is written down here.

**Confirmed, not merely inferred.** The reading above was originally settled by
what the schema does rather than by what anyone intended, which left it open
whether the code or the intent was wrong. Asked directly on 2026-08-12, the
answer was that `commissionValue` is the Pro's rate and `commissionAmount` is
the amount to be paid to the Pro. The code was already correct; this question is
closed and module 9 is safe to record against.

---

## 53 · Incentive progress with one `commissionId` cannot survive a reversal

**Module 8 · Resolved 2026-08-12 · found in review**

The ERD gives `ProIncentiveProgress` a single `commissionId` — the job the
reward was credited against — and a `progressValue` counter. US-8.7's edge says
a later reversal must decrement the progress, "or a cancelled job banks a
permanent bonus".

It cannot. `commissionId` records the job that **tipped the total over** and
forgets the other forty-nine. Reversing any of those has nothing to follow back,
so the progress silently keeps a job it no longer has, and the next job over the
line pays the bonus again.

**Decision:** `ProIncentiveContribution` — one row per (progress, job), unique
on the pair. Progress is the **sum of its contributions**, re-derived from source
on every evaluation rather than incremented. Unwinding a reversal is a delete
and a recount.

`ProIncentiveProgress.commissionId` stays, and keeps its original meaning: where
the reward was credited, which is what a reversal of _that_ job follows to
recover the money.

**Consequence to accept:** an extra row per job per active scheme, and an
evaluation that is O(jobs in period) rather than O(1). With a handful of active
schemes and a few dozen jobs a month per Pro that is nothing, and it buys a
progress figure that is correct by construction rather than correct until
something retries.

---

## 54 · A recurring bonus locked by `@@unique([proId, incentiveId])`

**Module 8 · Resolved 2026-08-12 · found in review**

"Complete 20 jobs → ₹2,000" is a different promise depending on whether it can
be won again next month, and the source documents never say which. The ERD's
unique key answers by accident: one progress row per Pro per incentive, forever,
so every scheme is once-ever whatever anyone intended.

Worse, it is invisible. A monthly scheme configured in August simply never pays
again in September, and the row that explains why looks perfectly normal.

**Decision:** `Incentive.recurrence` (`once | daily | weekly | monthly`) and a
`periodKey` in the unique key. The key is derived from the completion instant in
**Asia/Kolkata** — a job finished at 3 a.m. on 1 September happened in September
to the person who did it, and computing the boundary in UTC would file it under
August for five and a half hours every month.

Weekly keys use the ISO week, so a new-year week belongs to the year holding its
Thursday. Without that rule the same weekly bonus can be won twice in eight days.

**Consequence to accept:** `periodKey` is a string in a unique index and is only
as good as the function that builds it. `incentive-periods.ts` is pure, takes the
instant as an argument, and is tested on the boundaries that matter — month
rollover in IST, the Monday of a week, and 1 January.

---

## 55 · A reversal after payment has no money movement to book

**Module 8/9 · Resolved 2026-08-12 · found while writing the adapter**

The module 9 plan's account table gave reversal one row:

> | Commission reversed | `pro_commission` | `payable:pro:<proId>` | `expense:pro_commission` |

That is right for a reversal before payment and **wrong** for one after it, and
the difference is not cosmetic.

Before payment, `payable:pro` still carries the amount, so debiting it back out
undoes the accrual and the books read as though the job never earned anything —
which is true.

After payment, `payable:pro` is already zero and the money is in the Pro's bank
account. Debiting it again drives the account negative and states that money
came back, which it has not. The ledger is append-only, so there would be no way
to take that entry out again once the real recovery happened.

**Decision:** a reversal after payment books **nothing**.

What the platform holds at that moment is a **claim**, not a movement, and a
claim already has a home — `PayoutDeduction`. It becomes a ledger entry when a
later payout actually consumes it, as `payable:pro:<proId>` →
`revenue:recoveries` from `recordDeductionRecovered`.

**Consequence to accept:** the expense stays on the books for a job that was
reversed, offset later by recovery income rather than by cancelling the original
expense. That is ordinary accounting for a recovery, and it is the honest
sequence: the cost was incurred, the money was paid, and some of it came back
later.

**What this buys.** `payable:pro:<proId>` returns to exactly zero for a Pro with
nothing in flight, whatever mixture of reversals, bonuses and deductions they
have been through. That invariant is testable — it is the strongest of the
ledger-scope reconciliation checks — and it would be meaningless if a reversal
could push the account negative for reasons that were correct.

**Same reasoning, one step later:** deductions are booked at **settlement**, not
when a batch claims them. A claimed deduction on a draft batch is still a claim,
and rejecting the batch gives it back — so booking it at claim time would put a
movement that never happened into a table that cannot be edited.

---

## 56 · Two modules served `pros/me/payouts`, and every test stayed green

**Module 6/8 · Resolved 2026-08-12 · found by trying to run the app**

`ProsController` (module 6) declared `GET pros/me/payouts` and
`GET pros/me/payouts/:id`, reading `CommissionPayout` directly because when it
was written nothing else could. Module 8 then declared the same two routes.

Fastify refuses to start with `FST_ERR_DUPLICATED_ROUTE`. **The application had
been unbootable since module 8 landed**, through two modules of further work.

**Why nothing caught it.** `module-graph.e2e-spec.ts` calls `.compile()`, which
resolves the dependency graph and stops. No HTTP adapter is created and no route
is registered, so a duplicate path compiles perfectly. Unit tests construct
services by hand and never see a controller at all. Every suite was green
against an application that could not start.

That is the more useful half of this entry: the gap was not the collision, it
was that _"the tests pass"_ had been quietly redefined to exclude "it runs".

**Decision:** module 8 owns payout history — it owns `CommissionPayout`, and its
version returns the deductions, line items and bank reference module 6's could
not. The two routes are removed from `ProsController`.

**And the real fix:** `test/http-routes.e2e-spec.ts` boots the application
through `createNestApplication().init()`, which registers every route and runs
every `onModuleInit`. It needs no database, no port and no request, and it fails
the moment two routes clash — naming the path, via Fastify's `onRoute` hook.

**Left alone deliberately:** `GET pros/me/commissions` still exists on module 6
alongside module 8's `GET pros/me/earnings/commissions`. Different paths, so
nothing breaks, but two endpoints now answer nearly the same question from
different code. Module 6's is the redundant one and should go — flagged rather
than removed here, because it is the teammate's module and no longer urgent.

---

## 57 · An ETA the platform cannot stand behind is worse than no ETA

**Module 4/5/13 · Resolved 2026-08-12**

Travel time has two consumers with incompatible accuracy needs, and one
implementation had to serve both.

**Dispatch** ranks candidates. Only the _ordering_ has to be right, and
crow-flight preserves it at city scale — a Pro 3 km away does not fall behind
one 20 km away once you follow real roads. It has been shipping on straight
lines and was never wrong to.

**A customer** reads "8 minutes" as a promise and plans around it. Indore's road
network is not a straight line, and the same 4 km is eight minutes at 6 a.m. and
twenty-five at 6 p.m. `tracking.etaMinutes` was `null` precisely because nobody
wanted to publish the dispatch number.

The tempting resolution is one number for both, and it is wrong in whichever
direction it is taken: withhold the estimate and dispatch loses its ranking;
publish it and customers stand at the door on a figure that was never a road
time.

**Decision:** one router, and every answer carries `source` — `google` for a
real traffic-aware road route, `haversine` for a straight line. Dispatch
consumes both indifferently. `BookingEtaService` returns **null** for anything
that is not `google`, and `null` is a real answer the app renders as "on the
way".

**Consequence to accept:** a deployment without a Routes key shows no ETA at all
— not a worse one. That is the intended outcome, and the boot log says so
plainly rather than leaving it to be discovered.

**Extended to staleness.** A position older than three minutes yields no ETA
either. A number computed from where a Pro _was_, presented as where they are,
is the same lie the `isStale` flag exists to prevent — and harder to spot,
because a number reads as more authoritative than a dot on a map.

### Two things the live run confirmed

**Google returns matrix elements out of order.** The real reply for a two-origin
matrix came back `originIndex: 1` first. Reading elements in arrival order would
have given one Pro another's travel time — a silently wrong ranking that looks
entirely plausible. Everything is placed by index, and there is a test for it.

**Cost is a design input, not an afterthought.** A Pro's phone reports every few
seconds and every report fans out to every booking they are travelling to.
Unbounded, the live map alone would bill thousands of calls an hour per job. The
origin is rounded to ~110 m before it becomes a cache key and the entry lives 60
seconds, which turns that into roughly one call a minute per job — measured at
538 ms fresh against 1 ms cached.

---

## 58 · A city map had no supported way to be pruned or reshaped

**Module 13 · Resolved 2026-08-12 · found by asking what an admin actually does**

`generate-grid` laid a square of cells around a centre and stopped there. Three
things were missing, and each one turns a ten-minute job into an afternoon.

**The extent was a guess.** `extentKm` is a half-width an admin types. Nobody
knows how many kilometres across their city is, so they round up, and every
rounded-up kilometre becomes cells over farmland.

**Pruning was one cell at a time.** `PATCH /admin/areas/:id` with
`isActive: false` was the documented way to drop a cell outside the city. At 1
km cells over Indore that is **525 cells, ~350 of them farmland** — 350
individual requests. Nobody finishes that, and a half-pruned map is worse than
an unpruned one because the leftovers are invisible until somebody books from a
field.

**Changing cell size was a dead end.** `generate-grid` refuses on a city that
already has areas (`CITY_ALREADY_MAPPED`), and nothing cleared them. "I
generated at 6 km and actually want 1 km" ended with someone editing rows by
hand.

**Decision: three additions, all respecting the existing rules.**

`GET /admin/areas/city-bounds` asks the geocoder for a named place and returns
its rectangle, plus — if you pass a cell size — the number of cells it would
produce. Measured for Indore: **24.7 × 20.2 km, 525 cells at 1 km**, against
**930** for the 30 km square somebody would otherwise have guessed. Nearly half
the farmland, gone before anything is created.

`POST /admin/areas/generate-grid-for-box` tiles a **rectangle** rather than a
square. Cities are not square and Indore is a fifth taller than it is wide.

`POST /admin/areas/deactivate-outside` retires every cell whose centre falls
outside a box, in one call, with a `dryRun` that reports and changes nothing.

`POST /admin/areas/regenerate` replaces a map: cells **never booked** are
deleted, cells **with booking history** are deactivated and renamed with a
`(retired …)` suffix.

### Two details that are not arbitrary

**Judged by the centre, not by overlap.** A cell straddling the city boundary is
_kept_. Erring inward would leave a hole at the edge, and a hole surfaces as "we
do not serve your street" to somebody who lives in town — a worse failure than
one spare cell of farmland.

**Renamed before the new grid is created.** `Area` is unique on
`(cityId, name)`, so a retired `A1` would collide with the new grid's `A1` and
the whole regeneration would die on a constraint. The rename is not cosmetic and
there is a test asserting it happens first.

### And the rule that did not move

**Nothing deletes a cell a booking points at.** `Booking.areaId` is `SetNull`,
so deleting one silently erases where that work was sold — and "how much came
out of Vijay Nagar last year" is exactly the question areas exist to answer.
`deactivate-outside` never deletes at all; `regenerate` deletes only what has
no booking history.

### What this exposed about the seed

The four seeded areas are a 2×2 grid of 6 km squares with real neighbourhood
names on the quadrants. `resolveArea` was answering correctly all along — a pin
in Scheme 94 genuinely is inside the rectangle labelled "Vijay Nagar", because
that rectangle is 36 km² and swallows a dozen localities. The data was demo
scaffolding; the tooling to replace it with something real is what was missing.

---

## 59 · Cell names came from the first line of the address

**Module 13 · Resolved 2026-08-12 · found by reading real Google responses**

`AreaNamingService` reverse-geocoded each cell centre and took
`addressLine.split(',')[0]`. That is correct for Nominatim, which leads its
address line with the locality:

    "Vijay Nagar, Indore, Madhya Pradesh, India"  ->  Vijay Nagar

Google leads with the **building**. Three real responses from this codebase's
own key:

    "EW 105, Schema No. 94 ... Telephone Nagar, Indore, ..."   ->  EW 105
    "Pawar Villa, N-430, ... Talawali Chanda, Indore, ..."     ->  Pawar Villa
    "121, Badi Bhamori, vijaynagar, Indore, ..."               ->  121

So configuring a Google key — the thing that makes the naming pass thirty times
faster — silently made it name service areas after people's houses. The digit
guard caught the third and left that cell unnamed; the first two would have
been saved as area names.

**Decision:** read the provider's **structured components**, never its display
string. `ReverseGeocodeResult.localityCandidates` carries the neighbourhood
layer, ordered by the provider's own hierarchy — Google's
`sublocality_level_1 -> sublocality -> neighborhood -> locality`, Nominatim's
`suburb -> neighbourhood -> quarter -> city_district`. The address-line split
survives only as the fallback for a provider that offered nothing.

`pickAreaName` additionally rejects plot-shaped candidates (`121`, `EW 105`,
`N-430`, `Plot 14`) and returns **null** rather than a bad name. An unnamed
`A1` in a review list is a cell an admin knows to look at; a plot number reads
as a decision somebody already made.

Names are also tidied, because Google returns Indian localities inconsistently
cased — `vijaynagar` beside `Vijay Nagar`. All-caps words of four letters or
more are calmed down (`RAJWADA` -> `Rajwada`); shorter ones are left as
acronyms (`MG Road` must not become `Mg Road`).

### Measured

A 2 km preview over central Indore, live against the real key: **12 of 16 cells
named**, and the names are real localities — Jabran Colony, Navlakha, Vandana
Nagar, Scheme No 140, Chiman Bagh, Shankar Nagar, Alok Nagar, Bhagirathpura,
Nanda Nagar, Solanki Nagar.

One of the twelve came back as "Doctor Roshan Singh Bhandari Marg" — a road,
not a neighbourhood, because Google had no sublocality for that square. That is
the residual error rate, it is why these are **suggestions** behind
`nameSource: 'geocoded'`, and it is why an admin reviews them.

---

## 60 · Opening a city was a one-way door

**Module 13 · Resolved 2026-08-12**

Committing a grid was the only way to see one. Pick a cell size, create five
hundred rows, and only then find out the cells are too coarse to be useful —
with `regenerate` the sole way back, retiring rows and leaving debris behind.

**Decision:** `POST /admin/areas/preview-grid` returns exactly the cells
`generate-grid-for-box` would create, with the names the naming pass would
suggest, and **writes nothing**. Try 2 km, look, try 1 km, look, commit.

**Naming in a preview is sampled, and that is the interesting constraint.** A
525-cell grid is 525 geocoder calls — seconds on Google, nine minutes on
Nominatim's one-per-second courtesy limit — which is not a request that can be
held open. `nameLimit` defaults to 25 and caps at 100; the rest of the cells
come back with their grid reference and no name.

That is enough, because a preview answers exactly one question: **is this cell
size right?** Twenty-five real names across a city tell you whether cells are
landing on one locality or swallowing five. Whether cell C7 specifically is
"Nanda Nagar" is a question for after the grid exists, which is what the full
naming pass is for.

**Consequence to accept:** the preview and the eventual grid can disagree on a
name, if the geocoder's answer changes between the two calls. They cannot
disagree on the geometry, which is the part the decision rests on — both come
from the same pure `generateGridForBounds`.

---

## 61 · A Pro rating a customer would have rated themselves down

**Module 10, feature 11 vs module 6's nightly rebuild.** Found while planning,
before a line of module 10 was written — which is the only reason it is a
decision rather than an incident.

### The disagreement

The feature list says Pro→customer reviews are "distinguished by
`reviewerType`", which puts them **in the `reviews` table**. And every row in
that table carries both participants:

```
Review.proId       — the Pro on the booking
Review.customerId  — the customer on the booking
Review.reviewerType — which of them WROTE it
```

`ProCountersService.rebuildAll`, correct since module 6 and running at 02:00
IST, said:

```sql
SELECT "proId", SUM("rating") FROM "reviews" GROUP BY "proId"
```

No direction filter, because until module 10 there was only one direction.

A Pro's review **of a customer** carries that Pro's own `proId` — the Pro is
its author. So the moment the first Pro tags a household `no_access` and rates
it 2, that 2 sits inside the Pro's `GROUP BY` bucket. At 02:00 the rebuild
folds a Pro's opinion of a customer into the Pro's own public rating.

Three things make this worse than an ordinary bug:

1. **It is silent and delayed.** Nothing is wrong at write time. The damage
   lands hours later, in a job with no user watching it.
2. **It looks authoritative.** This is the job that _corrects_ drift. Whatever
   it writes is what the platform then believes.
3. **It punishes the right behaviour.** A Pro diligent about flagging difficult
   or unsafe households drives their own rating — and therefore their dispatch
   priority and their income — down. A Pro who never reports anything is
   unaffected.

### Measured

One booking, two reviews, run against the real database:

|        | customer→Pro | Pro→customer |
| ------ | ------------ | ------------ |
| rating | 5            | 2            |

```
                     filtered (shipped)   unfiltered (the bug)
Pro   ratingSum/Count       5 / 1                7 / 2
Pro   average                5.0                  3.5
Customer ratingSum/Count    2 / 1                0 / 0
```

A five-star Pro reading as 3.5, and the customer signal never collected at all.

### Decision

**One table, `reviewerType` on every query, filtered in three places** — the
rebuild, the drift check that reports on the rebuild, and a second statement
that builds `Customer.ratingSum` from the opposite direction.

One table rather than a separate `CustomerFeedback` table, which was the
alternative and would have made the hazard structurally impossible. Rejected
because the feature list is explicit about `reviewerType`, and because two
tables means two sets of moderation, two admin screens and two shapes for what
is genuinely one concept. The cost of that choice is that `reviewerType` is now
load-bearing in every query touching `reviews`, and it is on us to remember.

**A third instance turned up during implementation** —
`incentive-evaluation.service.ts` reads a booking's review to score a rating
incentive. Unfiltered, a Pro could reach a five-star bonus by rating their own
customers five stars. Same root cause, different table, caught only because
changing `Review?` to `Review[]` in the schema made it fail to compile.

### Consequence to accept

`reviewerType` is a filter that can be forgotten, and forgetting it is silent.
Three guards, none of them sufficient alone:

- The rebuild's SQL is asserted by `pro-counters.service.spec.ts`, text-match,
  including a negative assertion against the old unfiltered form.
- `reviews.service.spec.ts` proves the counter moves on the **other** party in
  each direction.
- The schema comment on `Review` states the rule where a reader will hit it.

What would have caught it structurally is two tables. That option is written
down here so the next person weighing it has the reasoning rather than having
to reconstruct it.

---

## 62 · A migration that fails halfway leaves its DDL behind

Not an architecture decision — a **procedure** one, recorded because it cost
twenty minutes and will cost the next person the same.

`20260812180000_add_training_and_reviews` re-declared
`reviews_rating_check`, which already existed from
`20260809000000_add_pro_standing_sources`. Postgres refused with 42710 and
Prisma reported the migration as failed.

**The four `ALTER TABLE … ADD COLUMN` statements before it had already been
applied, and stayed applied.** Prisma does not wrap a migration file in a
transaction — it sends the statements and stops at the first error.

`prisma migrate resolve --rolled-back` then does what it says and no more: it
clears the bookkeeping row in `_prisma_migrations`. It does **not** touch the
schema. So the re-run failed again, this time on 42701 — the column it was
about to add already existed.

### The recovery, in order

1. Fix the migration file.
2. Undo the partial DDL by hand, `IF EXISTS` on every statement so the script
   is safe on a database where the first attempt never ran.
3. `prisma migrate resolve --rolled-back <name>`.
4. `prisma migrate deploy`.

Step 2 is the one that is easy to skip, and skipping it makes step 4 fail in a
way that looks like the original problem.

### Consequence to accept

Before adding a constraint to an existing table, grep the earlier migrations
for its name. `ADD CONSTRAINT` has no `IF NOT EXISTS` in Postgres, and the
cost of a collision is not a clean failure — it is a half-applied schema that
the tooling will not clean up for you.

---

## 63 · Module 15 is staged without audit storage or admin WebSockets

**Module 15 · Resolved for the current delivery 2026-08-13**

The module feature list requires a cross-cutting audit log and describes a live
dispatch map. The current delivery explicitly excludes `AdminAuditLog` and a
new admin WebSocket because both contracts may change after the core admin APIs
are exercised.

**Decision:** decision #2 remains in force. Do not recreate `AdminAuditLog` in
this pass. The dispatch map uses a city-scoped HTTP snapshot suitable for
polling; existing customer tracking sockets are neither copied nor weakened.

**Consequence:** availability and other mutations retain their existing
entity-specific attribution only. Module 15 is not complete against features
2 and 15 until the audit retention/access contract and realtime protocol are
reopened deliberately.

---

## 64 · Admin OTP replaces Firebase-first Admin authentication

**Modules 1/15 · Revised 2026-08-14**

V10 comments and `US-1.9` describe phone OTP for Admins. Admin accounts remain
pre-provisioned and never self-register, but proof of phone ownership now uses
the same configured Slide OTP provider as Customer and Pro authentication.

**Decision:** `POST /auth/otp/request` and `POST /auth/otp/verify` accept
`actorType: admin`; verification succeeds only when an active `AdminUser` with
that phone already exists. New Admin provisioning requires no password and
does not create a Firebase user. Nullable `firebaseUid` and
`POST /auth/admin/firebase-login` remain temporarily for already-linked legacy
accounts. Deactivation revokes sessions and disables Firebase only when that
legacy link exists.

---

## 65 · Payment attempts are dashboard-only, but a read-through endpoint exists

**Modules 7/15 · Resolved 2026-08-13**

The narrative says attempt-level details are read in Razorpay's dashboard.
Module 7 already exposes `GET /admin/orders/:id/attempts`, which fetches the
current attempts from Razorpay and persists none of them locally.

**Decision:** keep and document the endpoint. The important architectural rule
is no local `PaymentAttempt` table and therefore no second copy to drift; a
permission-checked read-through does not violate that rule.

---

## 66 · A signup OTP has no recipient row yet

**Modules 1/12 · Resolved 2026-08-14**

The ERD says exactly one of `NotificationLog.customerId`, `proId`, or
`adminUserId` is set. Customer signup sends its OTP before a verified Customer
row necessarily exists, while Module 12 promises to track every outbound
message. Creating an account merely to log an unverified OTP would turn an
authentication attempt into durable customer data.

**Decision:** delivery logs allow zero or one recipient foreign key. Pre-auth
OTP logs retain `recipientType`, a masked destination, the Slide provider
reference and timestamps; they never store the code. Once an actor exists,
normal notification rows still carry the matching foreign key. Outbox rows are
stricter and require exactly one recipient because background delivery is only
allowed to authenticated platform actors.

---

## How to add to this file

One section per conflict, numbered, with: where the two sources disagree
(quote both), the decision, and the consequence you are accepting. Add a row to
the index. Update it **in the same pass as the code**, not afterwards.
