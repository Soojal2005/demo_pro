# Homingo Pro App — backend flow guide

**Audience:** the engineer building the Professional (Pro) mobile app.
**Backend snapshot:** 18 August 2026.
**Scope:** everything the backend exposes to a `pro` actor, and nothing else.

This document explains what the Pro app can do, in the order a Pro actually does
it, so screens can be designed against real backend behaviour instead of guessed
behaviour. Where a rule is a product decision rather than an implementation
detail, it is called out — those are the rules that will otherwise be discovered
as bugs during integration.

Live contract: `GET /docs/json` (OpenAPI) on a running non-production backend.
When this document and OpenAPI disagree, OpenAPI is right.

Related reading: [API conventions](API_CONVENTIONS.md),
[frontend handoff (all three apps)](FRONTEND_ENGINEER_HANDOFF.md).

---

## 0. The five product rules that shape every screen

Read these before designing anything. Each one removes a screen you would
otherwise build.

1. **A Pro is a salaried employee, not a gig worker.** There is no accept and no
   decline on a job — anywhere in the API. The only action on a new assignment
   is _acknowledge_, which means "I have seen it", not "I agree to it".
2. **A Pro cannot cancel a job.** There is no cancel route on any Pro endpoint,
   at any depth. If they genuinely cannot proceed, ops closes the assignment and
   dispatch re-runs. Do not build a cancel button.
3. **A Pro cannot put themselves on or off duty.** `isAvailable` is admin-set
   only. There is no duty toggle endpoint. Same for city, skills/services, and
   approval status.
4. **This system pays commission and incentives only — never salary.** Salary is
   external payroll. Every earnings screen must display the `salaryNote` string
   the API returns, or the number reads as wrong to the Pro.
5. **Money is a string, always.** `"599.00"`, never `599.0`. Never `parseFloat` a
   rupee value for anything but display.

---

## 1. Ground rules for the API client

### 1.1 Base URL

```
{host}/api/v1
```

(`API_PREFIX` = `api`, `API_VERSION` = `v1`.)

### 1.2 Every response is enveloped

```jsonc
{
  "success": true,
  "statusCode": 200,
  "message": "Success",
  "data": {/* the actual payload */},
  "errors": null,
  "timestamp": "2026-08-18T09:15:00.000Z",
  "path": "/api/v1/pros/me",
}
```

Failures use the same envelope with `success: false`, `data: null`, and
`errors: [{ field, message, code }]`. Read business data from `data`. Read
machine-readable failures from `errors[].code` — those strings are stable
(`START_OTP_INVALID`, `COMPLETION_PHOTO_REQUIRED`, …) and are what the UI should
branch on, not `message`.

A `204 No Content` (logout) may have no parseable body — treat it as success.

### 1.3 Authentication

`Authorization: Bearer <accessToken>` on everything except the auth routes.

The access token carries `sub`, `actorType`, `accessMode`, `type`, `iat`, `exp`.
Decoding it locally is fine for navigation hints and refresh scheduling, but it
is never authorization — the server reloads live account state on every request,
so a Pro suspended a minute ago is refused with a token that still looks valid.

### 1.4 Errors the app must handle globally

| Status | Meaning for the Pro app                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------- |
| 401    | Token missing/expired/revoked → refresh once, else log out                                                          |
| 403    | Wrong actor type, **or** the Pro is suspended and this route is not a read-only one → route to the Suspended screen |
| 404    | Not yours, or does not exist — the backend deliberately does not distinguish                                        |
| 409    | Wrong state for this action (e.g. complete before start) — show the message, refresh the job                        |
| 422    | Quiz submission rejected                                                                                            |
| 429    | Too many OTP attempts                                                                                               |

---

## 2. Login and session

Pros authenticate by phone OTP only. (Firebase login is admin-only; guest
sessions are customer-only.)

```
POST /auth/otp/request
  { "phone": "+919876543210", "actorType": "pro" }
  → { "providerRef": "..." }

POST /auth/otp/verify
  { "phone": "+919876543210", "code": "123456",
    "providerRef": "...", "actorType": "pro" }
  → { accessToken, refreshToken, isNewUser,
      user: { id, phone, name, email, photoUrl } }
```

- `phone` accepts E.164 or a bare 10-digit Indian mobile (normalised to +91).
- `code` is exactly 6 digits.
- `providerRef` from the request step **must** be echoed back on verify.
- **`actorType: "pro"` matters.** The same phone number can exist as a customer
  and as a Pro; the actor type picks which account the session belongs to.
- **Verifying an unknown phone as a Pro creates the Pro** with `status: "applied"`
  and returns `isNewUser: true`. That is the entry point to onboarding — there is
  no separate signup call.

Session maintenance:

| Route                                   | Use                                                    |
| --------------------------------------- | ------------------------------------------------------ |
| `POST /auth/refresh` `{ refreshToken }` | Rotate the pair. The old refresh token dies.           |
| `POST /auth/logout` `{ refreshToken }`  | End this device's session (204)                        |
| `POST /auth/logout-all`                 | End every session for this Pro (204)                   |
| `GET /auth/me`                          | The account behind the token                           |
| `PATCH /auth/me`                        | Edit account basics (see §4.6 for what a Pro may edit) |

---

## 3. Account state → what the app shows

This is the most important table in this document. The Pro's `status` (from
`GET /pros/me`) plus suspension decides which part of the app is even reachable.

| `status`       | Meaning                                              | What the app should show                            |
| -------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `applied`      | Account exists, KYC not submitted (or resubmittable) | Onboarding: submit application + upload documents   |
| `under_review` | Application with ops                                 | "Under review" screen, read-only application status |
| `approved`     | Employed and dispatchable                            | The full app                                        |
| `rejected`     | Application refused                                  | Rejection reason + allow a fresh application        |
| `suspended`    | Blocked from working, still owed money               | Suspended screen — read-only surfaces only          |

Additional gates that only matter once `approved`:

- `isAvailable` (admin-set) — **off duty**. No new jobs will be assigned. The app
  cannot change it and should say so plainly rather than offering a switch.
- At least one active `ProService` (admin-assigned skill) is required before
  dispatch will ever consider this Pro.

### 3.1 Suspension is read-only, not lock-out

A suspended Pro gets `403` on everything **except** the read-only allowlist:

- `GET /pros/me/standing`, `/jobs`, `/ratings`, `/earnings`, `/commissions`
- Every `GET /pros/me/earnings/*`, `/incentives`, `/deductions`, `/payouts/*`
- Every `GET /pros/me/training*` (module reads and the manifest)

Money already earned is still owed, and a suspended Pro often needs to retake a
training module to be reinstated — so both stay readable. Training **writes**
(progress, quiz) are blocked while suspended.

Design implication: the Suspended screen is not a dead end. It is a reduced app
with Earnings, Payouts, Training and History intact and everything else hidden.
`suspendedReason` and `suspendedAt` are on the profile — show them.

---

## 4. Onboarding and KYC

### 4.1 The shape of every file upload in this API

There is no multipart upload endpoint anywhere. Every file follows the same
three-step pattern:

```
1. POST .../upload-url        → { key | photoKey, uploadUrl, expiresIn }
2. HTTP PUT the raw bytes to uploadUrl   (no auth header; Content-Type must match)
3. POST/PATCH the returned key back to the API
```

The key is namespaced server-side; a key from another Pro or another booking is
rejected. Build this once as a reusable uploader.

### 4.2 KYC documents

```
POST /pros/me/kyc/upload-url
  { "docType": "aadhaar" | "pan",
    "contentType": "image/jpeg" | "image/png" | "application/pdf" }
  → { key, uploadUrl, expiresIn }
```

### 4.3 Submit the application

```
POST /pros/me/applications
{
  "documentFullName": "Ramesh Kumar",      // exactly as printed on the document
  "documentDateOfBirth": "1995-08-17",     // YYYY-MM-DD
  "documentGender": "male" | "female" | "transgender",
  "referredByType": "pro" | "customer" | "none",
  "referredById": "…",                     // optional
  "aadhaarSource": "manual",               // "manual" is the only accepted value
  "aadhaarUrl": "<key from step 4.2>",     // required
  "aadhaarNumberMasked": "XXXX-XXXX-1234", // optional, format enforced
  "panSource": "manual",
  "panUrl": "<key from step 4.2>",         // required
  "panNumberMasked": "XXXXX1234X"          // optional, format enforced
}
```

Rules the UI must respect:

- Both `aadhaarUrl` and `panUrl` are mandatory (400 otherwise).
- Masked-number formats are validated exactly: `XXXX-XXXX-1234` and `XXXXX1234X`.
- **Re-submitting while an application is open (or in `changes_requested`)
  updates that application** rather than creating a second one. After a
  rejection, a new submission creates a new row — the old one and its documents
  are preserved.
- Submitting when already `approved` or `suspended` is a `409`. Approved legal
  identity cannot be changed by self-service.

```
GET /pros/me/applications  → ProApplication[]
```

Track `queueStatus` for the review screen:
`pending → docs_review → call_pending → changes_requested → approved | rejected`.

Also show per-document state: `aadhaarStatus` / `panStatus` are
`pending | verified | rejected`, each with its own `…RejectionReason`. A document
can be rejected on its own — the screen should show two independent document
rows, not one overall badge.

`verificationCallAt` is when ops scheduled the verification call; surface it if set.

### 4.4 Profile photo

```
POST  /pros/me/profile-photo/upload-url   { "contentType": "image/jpeg" | "image/png" }
PATCH /pros/me/profile-photo              { "key": "…" }   → Pro
```

### 4.5 Bank accounts (needed to actually get paid)

```
GET   /pros/me/bank-accounts
POST  /pros/me/bank-accounts
PATCH /pros/me/bank-accounts/:id
```

Body:

```jsonc
{
  "accountHolderName": "Ramesh Kumar",
  "accountNumberMasked": "XXXXXXXX1234", // masking Xs + last 4 only
  "ifscCode": "HDFC0001234",
  "upiId": "ramesh@upi", // optional, but see below
  "isPrimary": true,
}
```

**Tell the Pro to add a UPI id.** The account number is stored masked, and a
masked number cannot be paid to. Today the payout rail creates a UPI (VPA)
destination — a verified account with no `upiId` is skipped at payout time with
code `NO_PAYABLE_DESTINATION` and the earnings roll forward. This is the most
common "why wasn't I paid" case, and it is fixable entirely from this screen.

`isVerified` is admin-set. Show it; don't offer to change it.

### 4.6 Profile fields the Pro may edit

`PATCH /pros/me` accepts only: `email`, `languages[]` (max 20),
`emergencyContactName`, `emergencyContactPhone`, `emergencyContactRelation`,
`addressLine`, `homeBaseLat`, `homeBaseLng`.

Everything else on the profile is read-only to the Pro: `fullName`,
`dateOfBirth`, `gender` (copied from the approved KYC application), `status`,
`isAvailable`, `cityId`, `employeeCode`, `monthlySalary`, services, ratings and
counters.

`GET /pros/me` returns the full profile object.

---

## 5. Duty, location and how a job arrives

### 5.1 Reporting location

```
POST /pros/me/location   { "lat": 22.7196, "lng": 75.8577 }
  → { lat, lng, addressLine, stateName, postalCode, provider, attribution,
      area: { areaId, areaName, cityId, cityName } | null }
```

- Accepted **only** while `status === "approved"` and `isAvailable === true`;
  otherwise `403`. Stop the location loop when off duty rather than retrying into
  a 403 wall.
- Live position lives in Redis GEO — dispatch reads it, and the customer's
  tracking map is fed from it. Only a cold fallback is persisted on the Pro row.
- The response tells you which service area the Pro is standing in — useful for a
  "you are in <area>" line on the home screen.
- Suggested cadence: every 10–20 s while on duty or on a live job, less when idle.
  There is no server-enforced rate limit today; don't abuse it.

### 5.2 How an assignment happens (Pro side)

Dispatch scores eligible Pros and writes the winner onto the booking. The Pro's
booking then carries:

| Field               | Meaning                                |
| ------------------- | -------------------------------------- |
| `assignedAt`        | When it was assigned                   |
| `notifiedAt`        | When the Pro should have been told     |
| `ackDeadlineAt`     | The acknowledgement window closes here |
| `acknowledgedAt`    | Set once acknowledged                  |
| `assignmentOutcome` | `pending_ack`, then resolved           |

> ### ⚠️ There are no push notifications yet
>
> The notifications module does not exist. `notifiedAt` is stamped, but nothing
> is sent — `pushToken` is stored on the Pro row and never read.
>
> **The Pro app must poll `GET /pros/me/bookings`** (every 15–30 s while on duty,
> plus on app foreground) to discover a new assignment. Design the home screen
> around polling, and expect a push integration later.

### 5.3 Acknowledge

```
POST /pros/me/bookings/:id/acknowledge   → 200, no body
```

- Idempotent — acknowledging twice is not an error.
- Missing `ackDeadlineAt` costs that one job: the assignment expires, dispatch
  re-runs with this Pro excluded, and their `acceptanceRate` moves.
- **`acceptanceRate` is reporting only.** It does not affect dispatch ranking and
  never affects pay — `GET /pros/me/standing` returns
  `acceptanceAffectsDispatch: false` and `acceptanceAffectsPay: false` precisely
  so the app can say this on screen. Don't design a scary "acceptance score" gauge.

---

## 6. The job flow — the core of the app

### 6.1 State machine (Pro-visible part)

```
assigned ──en-route──▶ en_route ──arrived──▶ arrived ──verify-otp──▶ started ──complete──▶ completed
                          ▲                     │
                          └────── en-route ─────┘   (left and came back — every leg is recorded)
```

- `en_route → arrived → en_route` may repeat freely. `arrivedAt` is stamped on
  the **first** arrival only; going away and coming back does not restart the
  grace clock.
- `cancelled` can arrive from the customer or ops at any live state. The Pro app
  learns about it by polling — handle a job disappearing from the list or
  flipping to `cancelled` mid-flow.
- The Pro can never drive a transition to `cancelled`.

### 6.2 The calls, in order

Every transition body optionally carries coordinates. **Send them.** They are
evidence: "marked arrival from 3 km away" is only visible because the coordinates
actually captured were stored.

```
GET  /pros/me/bookings                 → live jobs, earliest slot first
GET  /pros/me/bookings/:id             → one job

POST /pros/me/bookings/:id/acknowledge
POST /pros/me/bookings/:id/en-route    { lat?, lng? }            → booking
POST /pros/me/bookings/:id/arrived     { lat?, lng? }            → booking
POST /pros/me/bookings/:id/verify-otp  { code, lat?, lng? }      → booking
POST /pros/me/bookings/:id/photos/upload-url { photoType, contentType }
                                       → { photoKey, uploadUrl, expiresIn }
POST /pros/me/bookings/:id/photos      { photoType, photoKey, lat?, lng? }
                                       → JobPhotoProof
GET  /pros/me/bookings/:id/photos      → JobPhotoProof[]
POST /pros/me/bookings/:id/complete    { lat?, lng? }            → booking
```

`GET /pros/me/bookings` returns only **live** work: `created`, `awaiting_payment`,
`assigning`, `assigned`, `en_route`, `arrived`, `started`. Completed and cancelled
jobs are history — read them from `GET /pros/me/jobs` (§9).

### 6.3 The start code — the one screen to get right

At `arrived` the backend mints a 6-digit code and shows it **in the customer's
app**. The customer reads it out; the Pro types it in.

- The Pro app **cannot** read the code. It is not in any Pro response, by design
  — that is what makes starting a job the customer's consent rather than the
  Pro's claim.
- Wrong code → `400` with `code: "START_OTP_INVALID"` and a message carrying
  "Attempt N of M" (default max 5).
- Attempts exhausted → `429` with `START_OTP_LOCKED`. The customer must request a
  fresh code from their app, which issues a **new** code and resets the counter.
  Your error state should say exactly that.
- A wrong code does **not** pause the grace-window clock — a Pro stuck at the door
  is a situation ops needs to see.
- If the customer is absent and a relative is at the door, ops can force-start.
  There is no Pro-side route for it; the app should offer "contact support".

`startedAt` — set only by a verified code — is the basis for the job timer and for
commission existing at all.

### 6.4 Photos

`photoType` is `before` | `after` | `completion`.

**At least one `completion` photo is mandatory.** `POST /complete` returns `409`
with `COMPLETION_PHOTO_REQUIRED` without one, and `409 JOB_NOT_STARTED` if the
code was never verified. Build the completion screen so a photo is captured
before the Complete button is enabled — a 409 at that point is a terrible place
to discover the requirement.

These photos are the platform's only structured record of finished work, and the
Pro's own defence in a dispute. Say so on the screen.

### 6.5 Completion, and what it triggers

`POST /complete` writes `completedAt`, computes `actualDurationMinutes`, generates
the invoice, and **writes the commission row synchronously**. The earnings summary
moves the moment the job finishes — no end-of-day roll-up to wait for.

`actualDurationMinutes` is reporting only. Commission is one flat rate per service:
a four-hour job pays exactly what a one-hour one does. Don't imply otherwise in
the UI.

### 6.6 Chat with the customer

```
GET  /pros/me/bookings/:id/messages     → ChatMessage[]  (oldest first)
POST /pros/me/bookings/:id/messages     { "body": "…" }  (1–2000 chars)
```

- Messages carry `senderType` + `senderId` only — **no names, no phone numbers**,
  in either direction. That is the point of the thread.
- The thread **closes** 24 h after completion (configurable) and immediately on
  cancellation. Writing after that is a `409` with `CHAT_WINDOW_CLOSED`; reading
  still works. Show a closed-thread state rather than a failing input box.
- No attachments from the Pro side today.
- No websocket for chat — poll while the job screen is open.

---

## 7. Cash jobs

A booking's `paymentMode` is `cash` or `online`, frozen at creation. Cash is the
only mode where the Pro handles money.

```
POST /pros/me/bookings/:id/cash-collection          → booking
POST /pros/me/bookings/:id/cash-collection/decline  { "reason": "…" } → booking
GET  /pros/me/cash-balance                          → CashBalanceDto
POST /pros/me/cash-handovers                        { "declaredAmount": "4500.00" }
GET  /pros/me/cash-handovers                        → CashHandoverDto[]
```

Rules:

- **Collection takes no amount.** It is `flatPrice` or nothing. A part payment
  cannot be recorded anywhere in this API. Do not build an amount field.
- Collection is idempotent — a double tap on a bad connection does not collect
  twice.
- **Decline is not a penalty.** The job still completes and the Pro is still paid
  their commission; it raises a billing ticket for ops. Write the screen copy so
  the Pro is not afraid to use it. `reason` is 5–500 chars and goes to ops.

Cash balance screen:

```jsonc
{
  "cashInHand": "4500.00",
  "ceiling": "10000.00",
  "isBlockedFromCashJobs": false,
  "openHandoverId": null, // an open declaration waiting on an admin
}
```

- Past the ceiling, **cash** jobs stop being assigned. Online work and commission
  are unaffected — commission is never netted against this balance. Say that
  explicitly; it is the main anxiety this screen creates.
- Handover: the Pro declares an amount, then an admin **counts** it. Declaring
  alone clears nothing, and the balance moves by the _counted_ figure, not the
  declared one. Status is `declared → confirmed | rejected`.
- Only **one open declaration at a time** (`409` otherwise) — hence
  `openHandoverId`.

---

## 8. Rating the customer, and the advisory

```
GET  /pros/me/bookings/:bookingId/customer-advisory  → CustomerAdvisoryDto
POST /pros/me/bookings/:bookingId/review             { rating: 1–5, tags?: […] }
GET  /pros/me/bookings/:bookingId/review             → ReviewDto | null
```

Pro review tags (the whole vocabulary):
`no_access`, `unsafe`, `pets_loose`, `payment_difficulty`, `pleasant`.

- **There is no `comment` field.** Sending one is a `400`, not a dropped field.
  Free text about a household, held internally and shown to the next stranger at
  their door, is the one thing this design refuses. Build a tag picker, not a
  text box.
- The rating is internal: the customer never sees it, and it drives nothing
  automatically — not dispatch, not pricing, not their ability to book.

The advisory is for the **job card, before setting off**:

```jsonc
{
  "ratingAverage": 2.7,
  "ratingCount": 6,
  "tagCounts": { "no_access": 3, "unsafe": 0, "pets_loose": 1 },
  "recentNotes": [/* tags only — no prior Pro is ever named */],
}
```

`ratingCount: 0` is the normal case and means nothing has been reported — not
that the household is risky. Present this as context, never as a verdict or a
warning banner.

---

## 9. Standing and history

```
GET /pros/me/standing                → ProStandingDto
GET /pros/me/jobs?page&limit&from&to → paginated job history { data, meta }
GET /pros/me/ratings?page&limit      → ratings received
GET /pros/me/commissions?page&limit  → commission history
GET /pros/me/earnings?page&limit     → commission-only earnings summary (legacy)
```

`ProStandingDto` is written to be displayed honestly:

| Field                                     | Show it as                                         |
| ----------------------------------------- | -------------------------------------------------- |
| `ratingAverage`, `ratingCount`            | The headline rating (null until first rating)      |
| `smoothedRatingScore`                     | What dispatch actually ranks on                    |
| `ratingAffectsDispatch: true`             | "Your rating affects the jobs you get"             |
| `acceptanceRate`, `acceptanceRatePercent` | Reporting figure                                   |
| `acceptanceAffectsDispatch/Pay: false`    | "This does not affect your jobs or pay"            |
| `completedJobs`                           | Lifetime count                                     |
| `countersRebuiltAt`                       | Counters rebuild nightly — use for an "as of" line |

Ratings a moderator has hidden come back with `contentHidden: true`,
`comment: null` and empty `tags` — the star still counts, the text is gone.

For the money view prefer §10 (`/earnings/*`), which is richer.
`/pros/me/earnings` and `/pros/me/commissions` here are the older, thinner reads.

---

## 10. Earnings, deductions and payouts

Every route in this section is readable while suspended.

```
GET /pros/me/earnings/summary            → EarningsSummaryDto
GET /pros/me/earnings/commissions        → CommissionLineDto[]  (page, limit, from, to, status)
GET /pros/me/earnings/commissions/:id    → CommissionLineDto
GET /pros/me/incentives                  → ProIncentiveDto[]
GET /pros/me/deductions                  → DeductionStatementDto
GET /pros/me/payouts                     → PayoutDto[]  (page, limit)
GET /pros/me/payouts/:id                 → PayoutDto
GET /pros/me/payouts/:id/commissions     → the lines inside that payout
```

### 10.1 Earnings summary — the home-screen money card

```jsonc
{
  "today": {
    "jobs": 4,
    "commission": "1200.00",
    "incentives": "0.00",
    "total": "1200.00",
  },
  "period": {},
  "lifetime": {},
  "unpaidEarnings": "14800.00",
  "pendingDeductions": "300.00",
  "unpaidBalance": "14500.00", // what is actually coming
  "lastPayout": {
    "id": "…",
    "netAmount": "…",
    "paidAt": "…",
    "periodStart": "…",
    "periodEnd": "…",
  },
  "salaryNote": "…", // MUST be displayed
}
```

Live figures — commission rows are written synchronously at completion.

### 10.2 Commission lines

Each line carries the rate **snapshotted at completion** (`rate: { type, value }`),
so the arithmetic can be checked and a later catalogue edit cannot rewrite
history. Also `customerPaid`, `earned`, `incentive`, `deduction`, `netPayable`,
and `reversedAt` / `reversalReason` when a job's commission was reversed.

### 10.3 Deductions — build this screen carefully

```jsonc
{
  "outstandingTotal": "300.00",
  "items": [
    {
      "id": "…",
      "amount": "300.00",
      "recovered": "0.00",
      "kind": "commission_reversal",
      "reason": "…",
      "bookingNumber": "HMG-000812",
      "raisedAt": "…",
      "settledAt": null,
      "payoutId": null,
    },
  ],
}
```

`kind` is `commission_reversal` | `incentive_unwind` | `manual`.

**Money is never debited from a Pro's bank account.** Anything to be recovered
appears here and comes off a future payout, itemised with a human-written reason.
A deduction the Pro can read and argue with is recoverable; a surprise debit is a
dispute. Show the reason text prominently.

### 10.4 Payouts

`PayoutDto` gives `periodStart/End`, `commissionAmount`, `incentiveAmount`,
`deductionAmount`, `netAmount`, `status`, `paidAt`, `reference` (the bank UTR —
show it so the Pro can match it against their passbook) and `mode`
(`vpa` | `bank_account`).

`GET /payouts/:id/commissions` returns every job in the batch plus every deduction
taken out of it, so the bank statement reconciles line by line. That is the
"why is this number what it is" screen.

### 10.5 Incentives

`ProIncentiveDto` gives `progressValue` against `targetValue`, `contributingJobs`,
`periodKey` / `periodEndsAt`, `achievedAt`, `rewardCredited`. Draw a progress bar
from `progressValue / targetValue`.

Only schemes the platform can actually credit are listed — schemes with no
evaluator are filtered out, so anything the Pro sees here is genuinely being
counted.

---

## 11. Training

```
GET   /pros/me/training?serviceId=       → CurriculumDto
GET   /pros/me/training/manifest         → TrainingManifestDto
GET   /pros/me/training/sessions         → ProSessionDto[]
GET   /pros/me/training/:moduleId        → TrainingModuleDetailDto
PATCH /pros/me/training/:moduleId/progress { percentComplete?, lastPositionSeconds? }
POST  /pros/me/training/:moduleId/quiz     { answers: { "q1": "b", "q2": ["a","c"] } }
```

- The curriculum is derived live from the services the Pro is active on — assign
  a service and it changes the same instant. Mandatory modules sort first;
  `mandatoryOutstanding` is what stands between the Pro and activation for a
  trade (when the activation gate is switched on).
- `?serviceId=` narrows it to one trade — the in-job reference case ("what should
  I be able to read standing in front of this job").
- `contentUrl` is a presigned GET valid for **six hours** (long, because a 48 MB
  video on mobile data is not a five-minute download). Refresh it if the user
  returns later.
- `lastPositionSeconds` is the resume point — resume there, don't restart. Send
  progress **periodically**, not only on exit; an app killed mid-video is exactly
  the case it exists for. `percentComplete` only moves forward, so scrubbing back
  cannot undo a completion.
- Reaching 100 % completes a module — **except a quiz**, which is completed by
  passing it.
- Quizzes are graded server-side; answers are never sent to the app. An omitted
  question counts as wrong. `attemptsLeft: 0` sets `isLocked` and further attempts
  are a `409` until an admin resets it. `bestQuizScore` is what the activation
  gate reads, so a curious retake cannot un-qualify anyone.
- **Offline is a first-class case.** `GET /training/manifest` lists sizes,
  versions and six-hour URLs so the app can pre-download on wifi and work in a
  basement. `version` is the field that matters: a change means the content was
  replaced and the cached copy is last month's procedure. `wifiRecommended` (over
  10 MB) is advice, not a rule — let a Pro on unlimited data override it.
- Classroom/field sessions are **read-only**; enrolment is done by an admin.

---

## 12. Screen inventory → endpoints

| Screen                              | Reads                                                                                                        | Writes                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Phone entry                         | —                                                                                                            | `POST /auth/otp/request`                                     |
| OTP entry                           | —                                                                                                            | `POST /auth/otp/verify`                                      |
| Onboarding: identity form           | —                                                                                                            | `POST /pros/me/kyc/upload-url`, `POST /pros/me/applications` |
| Application status                  | `GET /pros/me/applications`, `GET /pros/me`                                                                  | resubmit                                                     |
| Under review / Rejected / Suspended | `GET /pros/me`                                                                                               | —                                                            |
| Home (on duty)                      | `GET /pros/me`, `GET /pros/me/bookings` (poll), `GET /pros/me/earnings/summary`, `GET /pros/me/cash-balance` | `POST /pros/me/location` (loop)                              |
| New assignment card                 | `GET /pros/me/bookings`                                                                                      | `POST …/acknowledge`                                         |
| Job detail                          | `GET …/bookings/:id`, `GET …/customer-advisory`, `GET …/photos`                                              | `POST …/en-route`, `…/arrived`                               |
| Start-code entry                    | —                                                                                                            | `POST …/verify-otp`                                          |
| In-progress / photo capture         | `GET …/photos`                                                                                               | `…/photos/upload-url`, `…/photos`                            |
| Complete                            | —                                                                                                            | `POST …/complete`                                            |
| Cash collection                     | `GET /pros/me/cash-balance`                                                                                  | `…/cash-collection`, `…/cash-collection/decline`             |
| Cash handover                       | `GET /pros/me/cash-handovers`                                                                                | `POST /pros/me/cash-handovers`                               |
| Rate customer                       | `GET …/review`                                                                                               | `POST …/review`                                              |
| Chat                                | `GET …/messages` (poll)                                                                                      | `POST …/messages`                                            |
| Earnings                            | `/earnings/summary`, `/earnings/commissions`                                                                 | —                                                            |
| Payout detail                       | `/payouts`, `/payouts/:id/commissions`                                                                       | —                                                            |
| Deductions                          | `/deductions`                                                                                                | —                                                            |
| Incentives                          | `/incentives`                                                                                                | —                                                            |
| Training list / player / quiz       | `/training`, `/training/:id`, `/training/manifest`                                                           | `PATCH …/progress`, `POST …/quiz`                            |
| Sessions                            | `/training/sessions`                                                                                         | —                                                            |
| Standing & history                  | `/standing`, `/jobs`, `/ratings`                                                                             | —                                                            |
| Profile                             | `GET /pros/me`                                                                                               | `PATCH /pros/me`, profile-photo pair                         |
| Bank accounts                       | `GET /pros/me/bank-accounts`                                                                                 | `POST` / `PATCH`                                             |

---

## 13. Known gaps — read before estimating

These are backend limitations as of this snapshot, not app bugs. Plan around them
and raise them with the backend team.

1. **The job payload does not contain the address, the customer, or the service
   name.** `GET /pros/me/bookings[/:id]` returns the booking row: `addressId`,
   `customerId`, `serviceId` — ids only. There is no Pro-facing endpoint that
   resolves a customer address, so **the app currently cannot show the Pro where
   to go or who to meet.** The service name can be fetched from the public
   `GET /catalog/services/:id`; the address and customer cannot. This blocks the
   job card and needs a backend change (a Pro booking view that includes
   `address`, the customer's first name, and `service.name`).
2. **No push notifications.** Poll (§5.2). `pushToken` is stored and never read,
   and there is no route for the app to register one.
3. **No duty toggle.** `isAvailable` is admin-only; there is no endpoint for the
   Pro to go online/offline.
4. **The Pro cannot see their own assigned services/skills.** `ProService` rows
   drive the curriculum and dispatch eligibility but have no Pro-facing read.
5. **No Pro-facing document view URL.** Uploaded KYC files cannot be read back by
   the Pro; only admins can view them.
6. **No websocket for the Pro.** The tracking gateway (`/tracking` namespace)
   serves the customer's map. Everything on the Pro side is polled.
7. **`BookingDto` in Swagger is thinner than the real response.** The runtime
   response is the booking row (minus the start code, which is stripped from
   every Pro surface). Generate from OpenAPI, but expect extra fields.

---

## 14. Integration checklist

- [ ] One API client with the envelope unwrapped and `errors[].code` surfaced
- [ ] Token refresh on 401, single-flight, with logout on refresh failure
- [ ] A route guard driven by `status` + suspension (§3), re-checked on resume
- [ ] Reusable three-step uploader (§4.1) for KYC, profile photo and job photos
- [ ] Polling: jobs while on duty, messages while a job screen is open
- [ ] Location loop that starts/stops with `isAvailable` and never hammers a 403
- [ ] Money rendered from strings, never parsed to float
- [ ] `salaryNote` visible on every earnings screen
- [ ] Completion blocked in the UI until a `completion` photo exists
- [ ] Copy that never promises accept/decline, cancel, or a duty switch
