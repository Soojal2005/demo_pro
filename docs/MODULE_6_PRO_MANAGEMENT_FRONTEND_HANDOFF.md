# Module 6 — Pro Management · Frontend Handoff

**Backend snapshot:** 18 August 2026
**Audience:** Pro App engineers, and Admin Panel engineers building the
onboarding queue and roster screens
**API prefix:** `/api/v1`
**Live contract:** `/docs/json` on a running non-production backend — **that is
authoritative**, this document is not. If they disagree, OpenAPI wins and this
file is stale.

**Read first:** [`FRONTEND_ENGINEER_HANDOFF.md`](FRONTEND_ENGINEER_HANDOFF.md)
covers the response envelope, auth token handling, error shape, retry rules and
date/money conventions for **all three apps**. This document does not repeat
any of it. It covers only what is specific to Pro Management, in the depth
needed to build the screens.

---

## 0 · The one-paragraph version

A Pro is an **employee, not a marketplace seller**. They do not set prices, do
not choose jobs, cannot decline work, and cannot switch themselves on. Almost
every state that matters about a Pro is set by an admin, and the Pro App's job
is to show that state honestly and let the Pro do the work. If you find
yourself designing a screen where a Pro accepts or rejects a booking, stop —
that endpoint does not exist at any depth, and its absence is deliberate.

---

## 1 · The lifecycle, end to end

### 1.1 The state machine

`Pro.status` has five values and this is the whole graph:

```
                    ┌──────────── changes_requested ◄──┐
                    ▼                                  │
  (signup) ──► applied ──► under_review ──► approved ──┴──► suspended
                                   │                            │
                                   └────────► rejected          │
                                                  │             │
                                                  └── re-apply ─┘
                                                  (new application row)
```

| `status`       | What it means                                                | Pro App behaviour                                             |
| -------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| `applied`      | Account exists, no application submitted yet                 | Show the onboarding form                                      |
| `under_review` | Application submitted, or changes were requested on it       | Show queue progress; allow a corrected re-submission          |
| `approved`     | Employed. **Not the same as dispatchable** — see §1.3        | Full app                                                      |
| `rejected`     | Application refused. The Pro can still log in                | Read-only, with the rejection reason and a re-apply route     |
| `suspended`    | Employed but stood down. Token carries `suspended_read_only` | Read-only — see §1.4, this is the one that catches people out |

**Crucial:** a rejected Pro **still authenticates successfully**. Do not treat
a valid token as permission to show the working app. Branch on `status` from
`GET /pros/me`, every launch.

### 1.2 Onboarding, step by step

This is the sequence the Pro App must implement. Every step is a real endpoint.

```
1. POST /auth/otp/request      { phone, actorType: "pro" }      → { providerRef }
2. POST /auth/otp/verify       { phone, code, actorType, providerRef }
                                                                 → token pair
3. GET  /pros/me                                                 → status: "applied"

4. POST /pros/me/kyc/upload-url  { docType: "aadhaar", contentType }
                                                                 → { key, uploadUrl, expiresIn }
5. PUT  <uploadUrl>  (raw file bytes, Content-Type must match exactly)
6. repeat 4–5 for docType: "pan"

7. POST /pros/me/applications   { documentFullName, documentDateOfBirth,
                                  documentGender, aadhaarSource: "manual",
                                  aadhaarUrl: <key from step 4>,
                                  panSource: "manual", panUrl: <key>,
                                  referredByType?, referredById? }
                                                                 → application row
8. GET  /pros/me/applications   (poll, or refresh on app resume)
```

**Notes that will save you a bug:**

- `aadhaarUrl` / `panUrl` take the **`key`** from the upload-url response, not
  the `uploadUrl`. The `uploadUrl` is a short-lived presigned PUT and is
  useless after the upload.
- `documentDateOfBirth` is a plain date string, `"1995-08-17"` — not an ISO
  datetime.
- `documentGender` is one of `male | female | transgender`.
- Aadhaar and PAN are verified **independently**. One can be `verified` while
  the other is `rejected`.
- The application form does **not** collect a city or a home base. An admin
  sets `cityId`; the Pro sets `homeBaseLat/Lng` later via
  `PATCH /pros/me`.

### 1.3 The three gates — approved ≠ dispatchable

This is the single most misunderstood part of the module. A Pro receives work
only when **all three** are true:

| Gate                     | Field                      | Who sets it                            |
| ------------------------ | -------------------------- | -------------------------------------- |
| Employed                 | `status === 'approved'`    | Admin, via the application decision    |
| Has at least one service | an active `ProService` row | Admin, `POST /admin/pros/:id/services` |
| On duty                  | `isAvailable === true`     | **Admin only** — never the Pro         |

**`isAvailable` is not a Pro-facing toggle.** There is no
`PATCH /pros/me/availability`. If your design has an "I'm online" switch in the
Pro App, it cannot be built against this backend — availability is roster
policy, set by ops. Show it as **status**, not as a control.

A useful derived flag for the Pro App home screen:

```ts
const dispatchable =
  pro.status === 'approved' && pro.isAvailable && activeServiceCount > 0;
```

`activeServiceCount` is not on `GET /pros/me` today. Until it is, treat "no
jobs arriving" as explainable by any of the three and say so generically
rather than guessing which one.

### 1.4 Suspension — the read-only mode

When a Pro is suspended, their **existing tokens keep working** and the access
token carries `accessMode: "suspended_read_only"`. The server then allows only
routes explicitly marked read-safe and returns `403` on everything else.

Allowed while suspended:

- `GET /pros/me`, `GET /pros/me/standing`
- `GET /pros/me/jobs`, `/ratings`, `/earnings`, `/commissions`
- module 8's earnings and payout reads

Refused while suspended: every job action, every profile mutation, every bank
edit, location ingest.

**Design implication:** the Pro App needs a persistent suspension banner
carrying `suspendedReason`, and every action button disabled — not hidden.
A suspended Pro who can still see their earnings and why they were stood down
files fewer support tickets than one staring at a dead app.

---

## 2 · The Pro App API surface

All routes below require `Authorization: Bearer <accessToken>` from a **pro**
token. A customer or admin token gets `403` from the actor-type guard.

### 2.1 Identity and profile — `/pros/me`

| Method  | Path                                | Notes                                                        |
| ------- | ----------------------------------- | ------------------------------------------------------------ |
| `GET`   | `/pros/me`                          | The whole profile. Poll on resume — status changes elsewhere |
| `PATCH` | `/pros/me`                          | **Allow-listed fields only**, see below                      |
| `POST`  | `/pros/me/profile-photo/upload-url` | `{ contentType }` → presigned PUT                            |
| `PATCH` | `/pros/me/profile-photo`            | `{ key }` from the step above                                |

**What a Pro may edit about themselves** — and nothing else:

```
email, languages[], emergencyContactName, emergencyContactPhone,
emergencyContactRelation, addressLine, homeBaseLat, homeBaseLng
```

`fullName`, `dateOfBirth` and `gender` are **copied from the verified KYC
document at approval and locked**. Sending them is rejected. Render them
read-only with a "from your verified ID" hint, or your users will file bugs
about a broken form.

`monthlySalary` and `employeeCode` are admin-set and read-only too.
`employeeCode` (`HG-D003` style) is generated on approval — before that it is
`null`, so do not build a header that assumes it exists.

### 2.2 Application and KYC

| Method | Path                      | Notes                                                   |
| ------ | ------------------------- | ------------------------------------------------------- |
| `GET`  | `/pros/me/applications`   | **A list.** Newest first. A re-application is a new row |
| `POST` | `/pros/me/applications`   | Submit; see §1.2                                        |
| `POST` | `/pros/me/kyc/upload-url` | `{ docType: aadhaar\|pan, contentType }`                |

Application history is a **list, not a singleton** — a rejected Pro who
re-applies has two rows and the old documents are preserved. Render the latest
as current and keep the rest as history.

Per-application fields the UI needs:

```ts
queueStatus: 'pending' | 'docs_review' | 'call_pending'
           | 'changes_requested' | 'approved' | 'rejected';
aadhaarStatus: 'pending' | 'verified' | 'rejected';
panStatus:     'pending' | 'verified' | 'rejected';
aadhaarRejectionReason?: string;   // show this verbatim
panRejectionReason?: string;
verificationCallAt?: string;       // set when ops logged the call
decision?: 'approved' | 'rejected' | 'changes_requested';
rejectionReason?: string;
```

**Show per-document rejection reasons separately.** The backend deliberately
verifies the two documents independently so a Pro can be told "your PAN scan
is blurry" without re-uploading their Aadhaar. Collapsing them into one
"documents rejected" message throws that away.

### 2.3 Standing — `GET /pros/me/standing`

```ts
{
  ratingAverage: number | null; // null until first review
  ratingCount: number;
  smoothedRatingScore: number; // what dispatch actually uses
  ratingAffectsDispatch: true;

  assignmentsOffered: number;
  assignmentsAcknowledged: number;
  acceptanceRate: number | null; // 0..1
  acceptanceRatePercent: number | null;
  acceptanceAffectsDispatch: false; // ← read this
  acceptanceAffectsPay: false; // ← and this

  completedJobs: number;
  countersRebuiltAt: string | null;
}
```

Those two `false` flags are a product decision the backend is telling you
about explicitly. **Acceptance rate is reporting only** — it changes nothing
about how much work a Pro gets or what they earn. Do not present it as a score
to improve, or you will manufacture anxiety about a number that does nothing.
Rating is the one that matters, and `smoothedRatingScore` (not
`ratingAverage`) is what ranks them, so a Pro with two five-star jobs does not
outrank one with two hundred.

### 2.4 History — pagination is uniform

`GET /pros/me/jobs`, `/ratings`, `/earnings`, `/commissions` all take:

```
?page=1&limit=20&from=<ISO>&to=<ISO>      limit max 100
```

All four are readable while suspended.

> ⚠️ **OpenAPI defect — do not generate the `jobs` model.**
> `GET /pros/me/jobs` is annotated `@ApiOkEnvelope(ProLocationDto)` in
> [`pros.controller.ts:115`](../src/modules/pros/pros.controller.ts#L115). That
> is wrong — it returns paginated **job history**, not a location. A generated
> client will produce a `ProLocation` type for this route and it will not match
> the payload. Hand-write this one model until the annotation is fixed, and
> check the real response shape against a live call. Filed in §8.

The other three are annotated `@ApiOkEnvelope()` with no DTO, so the generator
gives you `unknown` for their `data`. That is honest but unhelpful — confirm
their shapes against a live response too.

### 2.5 Bank accounts

| Method  | Path                         |
| ------- | ---------------------------- |
| `GET`   | `/pros/me/bank-accounts`     |
| `POST`  | `/pros/me/bank-accounts`     |
| `PATCH` | `/pros/me/bank-accounts/:id` |

```ts
{
  accountHolderName: string;
  accountNumberMasked: string;  // MUST match /^X{4,}\d{4}$/  e.g. "XXXXXX1234"
  ifscCode: string;
  upiId?: string;
  isPrimary?: boolean;
}
```

**The account number is masked at the client and the server enforces the
format.** The backend never holds a full account number. Two consequences for
your UI:

1. The form must mask before sending. `"XXXXXX1234"` passes; a real number is
   a `400`.
2. **Payouts currently run over UPI only.** Because the stored number is
   masked, a bank fund account cannot be created from it — so `upiId` is
   effectively required for a Pro to be paid. Mark it as such in the form even
   though the schema calls it optional. (Backend conflict #51.)

`isVerified` is set by finance, not by the Pro. A Pro **cannot verify their own
account** — the server rejects it.

### 2.6 Live location — `POST /pros/me/location`

```ts
{ lat: number, lng: number }
```

Accepted **only while `status === 'approved'` and `isAvailable === true`**;
otherwise `403`. This writes to a Redis GEO index, not to a history table —
there is no route to read a track back, and `Booking.routeTrail` is still
unpopulated (module 13, instalment 2).

Practical guidance: post on a timer while the app is foregrounded and the Pro
has a live job. Treat a `403` as "stop posting until the profile is refetched"
rather than as an error to retry — retrying a 403 in a location loop is a
battery bug.

### 2.7 Where the rest of the Pro App lives

Pro Management owns the account. The working day is other modules, all under
`/pros/me/...`, and they are listed here so you can find them:

| Area                       | Base path                                  | Module |
| -------------------------- | ------------------------------------------ | ------ |
| Assignment acknowledgement | `POST /pros/me/bookings/:id/acknowledge`   | 5      |
| Job actions                | `/pros/me/bookings/:id/...`                | 4      |
| Reviewing a customer       | `/pros/me/bookings/:bookingId/review`      | 10     |
| Training                   | `/pros/me/training`                        | 10     |
| Earnings, payouts          | `/pros/me/earnings`, `/pros/me/payouts`    | 8      |
| Support & SOS              | `/pros/me/sos`, `/pros/me/support/tickets` | 11     |

**`acknowledge` is a receipt, not an acceptance.** It confirms the phone got
the assignment. There is no decline, and calling it does not mean the Pro
agreed to anything. Label it accordingly — "Got it", not "Accept".

Job history lives in **two** places for a reason: `GET /pros/me/jobs` (module 6) is the paginated career history; `/pros/me/bookings/...` (module 4) is the
live job being worked. Use the second for the active-job screen.

---

## 3 · The Admin Panel surface

Every route is under `/admin`, requires an **admin** token, and is guarded by a
permission code. A missing grant is a `403` — the panel should hide the surface
rather than render it and fail.

### 3.1 Onboarding queue — `pro.application.review`

| Method  | Path                                                      | Purpose                           |
| ------- | --------------------------------------------------------- | --------------------------------- |
| `GET`   | `/admin/pro-applications`                                 | The queue. Joins the Pro identity |
| `GET`   | `/admin/pro-applications/:id/documents/:docType/view-url` | Short-lived presigned GET         |
| `PATCH` | `/admin/pro-applications/:id/verify-document`             | `{ docType, decision, reason? }`  |
| `PATCH` | `/admin/pro-applications/:id/log-call`                    | Records `verificationCallAt`      |
| `PATCH` | `/admin/pro-applications/:id/decision`                    | `{ decision, reason? }`           |

**Document images are never public URLs.** Fetch a `viewUrl` per document, per
view; it expires. Do not cache it in application state beyond the screen.

**The decision endpoint enforces four rules — surface them as validation, not
as surprise 409s:**

| Rule                                                                      | Status |
| ------------------------------------------------------------------------- | ------ |
| Both Aadhaar **and** PAN must be `verified` before `approved`             | `409`  |
| Legal name, DOB and gender must all be present before `approved`          | `409`  |
| `reason` is required for `rejected` and `changes_requested`               | `400`  |
| A final decision (`approved`/`rejected`) **cannot be changed afterwards** | `409`  |

The right UI is an approve button that stays disabled, with the missing items
listed, until the first two hold. `changes_requested` is the non-final option —
it sends the Pro back to `under_review` so they can correct and resubmit,
and it is the one reviewers will use most.

Approval is transactional and does three things at once: copies the verified
legal identity onto the Pro, sets `status = 'approved'`, and generates the
`employeeCode`. Refetch the Pro row after — do not patch it locally.

### 3.2 Roster — `pro.moderate` / `pro.availability.set`

| Method  | Path                            | Permission             |
| ------- | ------------------------------- | ---------------------- |
| `GET`   | `/admin/pros`                   | `pro.moderate`         |
| `PATCH` | `/admin/pros/:id/profile`       | `pro.moderate`         |
| `PATCH` | `/admin/pros/:id/suspend`       | `pro.moderate`         |
| `PATCH` | `/admin/pros/:id/reinstate`     | `pro.moderate`         |
| `PATCH` | `/admin/pros/:id/availability`  | `pro.availability.set` |
| `PATCH` | `/admin/pros/availability/bulk` | `pro.availability.set` |

Availability is a **separate grant** from moderation, deliberately: turning
the roster on and off for the day is a shift-manager action, suspending
somebody is an HR one.

**Suspension has a two-step confirmation you must build:**

```
PATCH /admin/pros/:id/suspend  { reason }
  → 409 "This Pro has live bookings that require an explicit ops decision"

PATCH /admin/pros/:id/suspend  { reason, confirmLiveBookingHandling: true }
  → suspended
```

The first call is a **check**, not a failure. Catch that specific `409`, show
the admin what is live on this Pro, and only then re-send with the flag. Do not
send `confirmLiveBookingHandling: true` on the first attempt — that defeats the
guard entirely. `reason` is mandatory and is stored on the Pro as the
moderation record.

**Reinstatement re-checks the gates** and returns `409` with a structured
`errors[]` array naming each blocker:

```json
{
  "errors": [
    {
      "field": "activeServiceGate",
      "code": "NO_ACTIVE_SERVICE",
      "message": "At least one active ProService is required"
    },
    {
      "field": "availabilityGate",
      "code": "PRO_NOT_AVAILABLE",
      "message": "The Pro must be switched on before reinstatement"
    }
  ]
}
```

Render those as a checklist with fix-it actions, since both blockers are
resolvable from adjacent screens.

### 3.3 Services (competency) — `pro.moderate`

| Method  | Path                                  |
| ------- | ------------------------------------- |
| `GET`   | `/admin/pros/:id/services`            |
| `POST`  | `/admin/pros/:id/services`            |
| `PATCH` | `/admin/pros/:id/services/:serviceId` |

```ts
{ serviceId: string; proficiency?: 'trainee' | 'skilled' | 'expert' }
```

`ProService` is the **only** thing dispatch matches skills on — there is no
separate skill or certification code. `isActive` on a single row suspends one
service without touching the rest of the Pro, which is the lightest of the four
consequences ops can apply to a quality complaint.

A **draft** service is assignable on purpose: Pros are trained ahead of a
launch. Do not filter the picker to active services only.

### 3.4 Bank verification — `pro.bankAccount.verify`

| Method  | Path                                                    |
| ------- | ------------------------------------------------------- |
| `GET`   | `/admin/pros/:id/bank-accounts`                         |
| `PATCH` | `/admin/pros/:id/bank-accounts/:accountId/verification` |

Its own grant, held by finance rather than ops — reading where a Pro's money
goes is not part of editing a roster.

---

## 4 · Data model, as the frontend needs it

```ts
type ProStatus =
  'applied' | 'under_review' | 'approved' | 'suspended' | 'rejected';
type QueueStatus =
  | 'pending'
  | 'docs_review'
  | 'call_pending'
  | 'changes_requested'
  | 'approved'
  | 'rejected';
type DocumentStatus = 'pending' | 'verified' | 'rejected';
type Proficiency = 'trainee' | 'skilled' | 'expert';
type ReferredByType = 'pro' | 'customer' | 'none';
type DocumentGender = 'male' | 'female' | 'transgender';

interface Pro {
  id: string;
  phone: string;
  fullName: string | null; // locked after approval
  dateOfBirth: string | null; // locked
  gender: string | null; // locked
  email: string | null;
  languages: string[];
  profilePhotoUrl: string | null;
  addressLine: string | null;
  homeBaseLat: number | null;
  homeBaseLng: number | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  emergencyContactRelation: string | null;

  employeeCode: string | null; // null until approved
  monthlySalary: string | null; // decimal-as-string; admin-set
  cityId: string | null; // admin-set

  status: ProStatus;
  isAvailable: boolean; // admin-set — NOT a Pro toggle
  suspendedReason: string | null;
  suspendedAt: string | null;
  approvedAt: string | null;

  ratingSum: number;
  ratingCount: number;
  completedJobs: number;
  acceptanceRate: number | null; // reporting only
  cashInHand: string; // decimal-as-string
}
```

**Money is a decimal string, never a JS number.** `flatPrice`, `cashInHand`,
`monthlySalary` and every commission amount arrive as strings like
`"4999.00"`. Parsing them into floats will produce rounding errors in totals.
Use a decimal library or integer paise.

---

## 5 · Things the frontend must not build

Each of these is absent by design. Building a placeholder for it creates a
promise the backend will not keep.

| Do not build                               | Why                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| Accept / decline a job                     | A Pro is a salaried employee and cannot decline work. No route, at any depth |
| A Pro-facing "go online" toggle            | `isAvailable` is admin-only                                                  |
| A cancel-job button in the Pro App         | Pros never cancel; ops closes the assignment and dispatch re-runs            |
| Editing name / DOB / gender after approval | Copied from verified KYC and locked                                          |
| Self bank verification                     | Explicitly rejected server-side                                              |
| A location history / breadcrumb screen     | Location is a Redis index; no read-back route exists                         |
| Acceptance rate as a performance score     | `acceptanceAffectsDispatch` and `acceptanceAffectsPay` are both `false`      |
| Salary payslips                            | Out of scope by decision; every earnings response carries a `salaryNote`     |

---

## 6 · Screen-by-screen state, Pro App

| Screen           | Source                                         | Empty / edge state                                               |
| ---------------- | ---------------------------------------------- | ---------------------------------------------------------------- |
| Splash / routing | `GET /pros/me` → `status`                      | Route to onboarding, review-pending, rejected, suspended or home |
| Onboarding       | `POST kyc/upload-url` ×2 → `POST applications` | Per-document rejection reasons shown separately                  |
| Review pending   | `GET /pros/me/applications[0]`                 | `queueStatus` drives a 4-step progress indicator                 |
| Home             | `GET /pros/me` + module 4 live booking         | No job **and** not dispatchable → explain generically (§1.3)     |
| Profile          | `GET /pros/me`, `PATCH /pros/me`               | Locked fields rendered read-only with provenance                 |
| Standing         | `GET /pros/me/standing`                        | `ratingAverage: null` → "No ratings yet", not "0.0"              |
| Earnings         | module 8 `/pros/me/earnings/summary`           | Carries `salaryNote` — display it                                |
| Bank             | `GET/POST/PATCH /pros/me/bank-accounts`        | Mask before send; UPI effectively required                       |
| Suspended        | `GET /pros/me` → `suspendedReason`             | Banner + disabled (not hidden) actions                           |

---

## 7 · Verification status of what is described here

Module 6 is **19/19 features built** and is the most complete module in the
system. The behaviours in this document are covered by unit tests and were
exercised in the full cURL pass; see
[`MODULE_STATUS_REPORT.md`](MODULE_STATUS_REPORT.md) §6.

Two caveats worth knowing before you plan sprints:

1. **`ProCountersService` rebuilds counters nightly**, so `acceptanceRate` and
   `completedJobs` can lag a completed job by up to a day. `standing` reads
   the live columns, which the completion hook writes synchronously — so the
   numbers are current, but a discrepancy after a rebuild is expected, not a
   bug.
2. **The training activation gate ships off.** `training.gateActivation` is
   `false`, so assigning a service does not currently check mandatory
   training. If it is switched on, `POST /admin/pros/:id/services` starts
   returning an error naming the missing modules — handle that error path now
   rather than retrofitting it.

---

## 8 · Open questions for the backend team

Raise these rather than working around them. The first two are the ones that
will actually cost frontend time.

1. **`GET /pros/me/jobs` is annotated with the wrong response DTO**
   (`ProLocationDto`, [`pros.controller.ts:115`](../src/modules/pros/pros.controller.ts#L115)).
   Anyone generating a client from `/docs/json` gets a type that does not match
   the payload. One-line fix on the backend; until then this route needs a
   hand-written model. `/ratings`, `/earnings` and `/commissions` have no DTO
   annotation at all, so their `data` generates as `unknown`.
2. **`GET /pros/me` does not expose `activeServiceCount`**, so the Pro App
   cannot tell a Pro _which_ of the three dispatchability gates is holding
   them back — only that something is. Adding it turns a vague "you're not
   receiving jobs" into an actionable message.
3. **There is no Pro-facing endpoint listing their own assigned services.**
   A Pro can see the jobs they get but not the trades they are on the books
   for. `GET /admin/pros/:id/services` exists; the `/pros/me` mirror does not.
4. `Booking.routeTrail` is still null everywhere, so nothing can draw a
   completed route (module 13, instalment 2).
