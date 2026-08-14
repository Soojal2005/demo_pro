# Homingo frontend engineering handoff

**Backend snapshot:** 13 August 2026  
**Audience:** customer app, professional app, and admin-panel engineers  
**API prefix:** `/api/v1`  
**Primary contract:** `/docs/json` on a running non-production backend

This document describes the frontend state that must exist, how it maps to the
backend's domain state, and the integration rules that should not be inferred
from screen designs alone. It is framework-neutral. The examples use
TypeScript-style discriminated unions because they make mutually exclusive UI
states explicit; the same model works in Flutter, Kotlin, Swift, React, Vue, or
another client.

## 1. Sources of truth

Use these in this order:

1. The live OpenAPI document at `/docs/json` for paths, DTOs, required fields,
   validation, authentication, and response schemas.
2. [API conventions](API_CONVENTIONS.md) for the response envelope and error
   rules.
3. [API inventory](API_INVENTORY.md) for a human-readable feature map. It is a
   dated inventory, so prefer OpenAPI when it disagrees with current source.
4. [Geo Postman collection](../postman/Homingo-Geo-Indore.postman_collection.json)
   for executable Geo/admin-area examples and saved responses.
5. This document for frontend state ownership and screen behaviour.

Do not manually maintain a second set of request/response interfaces if the
frontend stack supports OpenAPI generation. Generate the API client and add a
small handwritten adapter layer for view models.

## 2. There are three products, not one role-switching UI

| Product      | Authentication                               | Primary scope                                                          |
| ------------ | -------------------------------------------- | ---------------------------------------------------------------------- |
| Customer app | Guest session, then phone OTP                | Location, catalogue, addresses, bookings, payments, tracking, reviews  |
| Pro app      | Phone OTP                                    | Onboarding, KYC, jobs, location reporting, training, earnings, payouts |
| Admin panel  | Firebase client login, then backend exchange | RBAC- and city-scoped operational surfaces                             |

The access token contains `sub`, `actorType`, `roleId?`, `accessMode`, `type`,
`iat`, and `exp`. Decoding it locally is acceptable for navigation hints and
expiry scheduling, but never treat decoded claims as authorization. The server
reloads mutable account state on every authenticated request.

## 3. Universal API client contract

### 3.1 Response envelope

Every normal JSON response is wrapped as:

```ts
export interface ApiEnvelope<T> {
  success: boolean;
  statusCode: number;
  message: string;
  data: T | null;
  errors?: Array<{
    field?: string;
    message: string;
    code?: string;
  }> | null;
  timestamp: string;
  path?: string;
}
```

Read the business payload from `data`. Do not assume that a `2xx` response
itself is the payload. `204 No Content` logout responses may have no parseable
body and must be accepted as success.

### 3.2 Shared async UI state

Every independent server query should support all of these states:

```ts
type RemoteState<T> =
  | { kind: 'idle' }
  | { kind: 'loading'; previous?: T }
  | { kind: 'success'; data: T }
  | { kind: 'empty' }
  | { kind: 'error'; error: UiError; previous?: T };
```

Keep `empty` separate from `error`. Examples of valid empty results include no
saved address, no bookings, no training sessions, and no payout history.

For mutations, also model `submitting` and prevent accidental double-submit:

```ts
type MutationState<T> =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success'; data: T }
  | { kind: 'error'; error: UiError };
```

### 3.3 Error handling

Normalize failures once in the API layer. Preserve `message`, field errors,
business `code`, HTTP status, and request path.

| HTTP status | Frontend behaviour                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `400`       | Request or query is malformed. Show field errors when supplied.                                                                     |
| `401`       | Try one token refresh. If it fails, clear the session and show login.                                                               |
| `403`       | Authenticated but wrong actor, permission, city scope, or write blocked by Pro suspension. Show an access state, not a login error. |
| `404`       | Show not found. Some ownership checks intentionally return 404 so another user's resource cannot be discovered.                     |
| `409`       | Domain conflict. Display the returned message/code and refetch the affected resource.                                               |
| `422`       | Valid JSON but unusable business input, such as unresolved location or invalid application state.                                   |
| `429`       | OTP/rate limit. Disable resend until the retry window expires.                                                                      |
| `500`       | Generic retry screen; never display an internal stack trace.                                                                        |
| `503`       | Upstream provider unavailable. Offer retry or a safe alternative flow.                                                              |

Unknown request-body properties are rejected. A misspelled property is an
error, not silently ignored. Send only fields defined in the OpenAPI DTO.

### 3.4 Dates, money, identifiers, and null

- Dates are ISO 8601. Parse for display, retain the original instant, and
  explicitly choose the user's timezone when rendering.
- Money such as `flatPrice`, `amount`, `taxAmount`, `refundAmount`, commission,
  and payout totals is serialized as a **decimal string in rupees**. Do not use
  `parseFloat` for calculations. Use a decimal/money library or integer paise.
- UUIDs and human-readable numbers such as `bookingNumber` have different
  purposes. Use UUIDs in API paths; show `bookingNumber` to people.
- `null` is often a valid answer, not incomplete data. Important examples are
  `area`, `position`, `etaMinutes`, `proId`, `slotStartAt`, and address metadata.
- Never convert `etaMinutes: null` to `0 min`; show “ETA unavailable” or “On the
  way”.

## 4. Session and authentication state

### 4.1 Required session state

```ts
type SessionState =
  | { kind: 'bootstrapping' }
  | { kind: 'anonymous' }
  | { kind: 'guest'; accessToken: string; refreshToken: string }
  | {
      kind: 'authenticated';
      actorType: 'customer' | 'pro' | 'admin';
      accessMode: 'full' | 'suspended_read_only';
      accessToken: string;
      refreshToken: string;
    }
  | { kind: 'refreshing'; previous: 'guest' | 'authenticated' }
  | { kind: 'expired'; reason?: string };
```

Also keep an OTP flow separate from the authenticated session:

```ts
type OtpState =
  | { kind: 'phone_entry' }
  | { kind: 'requesting' }
  | { kind: 'code_entry'; providerRef: string; resendAt: number }
  | { kind: 'verifying'; providerRef: string }
  | { kind: 'rate_limited'; retryAt?: number }
  | { kind: 'provider_unavailable' }
  | { kind: 'error'; message: string };
```

### 4.2 Customer and Pro OTP flow

1. `POST /auth/otp/request` with `phone` and `actorType` (`customer` or `pro`).
2. Keep the returned `providerRef` only for the current OTP attempt.
3. `POST /auth/otp/verify` with the same phone/actor type, the six-digit code,
   and `providerRef`.
4. A customer upgrading a guest session should also send the stable `deviceId`.
5. Store the returned token pair using the platform's secure storage.

The backend normalizes a valid 10-digit Indian phone to E.164, but the frontend
should still show the normalized country code clearly.

### 4.3 Guest customer flow

Create or resume a guest session with `POST /auth/guest-session` and a stable
per-install `deviceId` of at least eight characters. The guest token is useful
for progressive onboarding; do not force OTP before a customer can inspect
availability.

### 4.4 Admin login

Authenticate with the Firebase client SDK first, obtain a Firebase ID token,
then exchange it using `POST /auth/admin/firebase-login`. Do not send a Firebase
access token directly to normal Homingo endpoints.

### 4.5 Refresh and logout

- Default access-token lifetime is 15 minutes; default refresh-token lifetime
  is 7 days. Configuration can change these values, so schedule from JWT `exp`.
- `POST /auth/refresh` **rotates** the refresh token. Replace both stored tokens
  atomically.
- Only one refresh may run at a time. Queue concurrent failed requests behind
  a single refresh promise and replay each request at most once.
- Reusing an already rotated refresh token revokes all sessions, so two
  simultaneous refresh calls are not harmless.
- `POST /auth/logout` revokes one refresh token. `POST /auth/logout-all`
  revokes all sessions for the identity.

## 5. State ownership in the frontend

Do not put all API data into one global mutable store.

| State category        | Examples                                                                  | Recommended lifetime                                   |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ |
| Persisted session     | token pair, device ID, selected app environment                           | Secure persistent storage                              |
| Server state          | profile, addresses, catalogue, bookings, areas, services, payouts         | Query cache keyed by endpoint parameters               |
| Cross-screen workflow | selected address, booking draft, onboarding draft                         | Feature store; persist only if product requires resume |
| Volatile device state | GPS permission, current device coordinate, socket status, upload progress | Memory; reacquire when appropriate                     |
| Local presentation    | active tab, modal visibility, unsaved form edits                          | Component/screen state                                 |

Invalidate or refetch related queries after mutations. Do not manually patch
five copies of a booking or area unless the state library guarantees the update
is consistent.

## 6. Customer app state

### 6.1 Location state machine

The customer app needs more than a nullable coordinate:

```ts
type CustomerLocationState =
  | { kind: 'unknown' }
  | { kind: 'using_saved'; addressId: string; lat: number; lng: number }
  | { kind: 'permission_required' }
  | { kind: 'permission_denied'; canOpenSettings: boolean }
  | { kind: 'locating' }
  | { kind: 'resolving'; lat: number; lng: number }
  | {
      kind: 'resolved';
      lat: number;
      lng: number;
      addressLine: string;
      attribution: string;
      area: ResolvedArea | null;
    }
  | { kind: 'unserviceable'; lat: number; lng: number; reason: string }
  | { kind: 'error'; retryable: boolean; message: string };
```

Launch sequence:

1. Call authenticated `GET /geo/my-location` before prompting for device GPS.
2. `source: null` and `code: NO_KNOWN_LOCATION` are a normal first-run result.
3. If needed, request device location permission or allow manual pin/address
   selection.
4. Call public `GET /geo/reverse-geocode?lat=&lng=` for the chosen pin.
5. Display the returned `attribution` wherever the geocoded address is shown.
6. Call `GET /geo/catalog?lat=&lng=` before presenting bookable services.

Never send an `areaId` from the customer app. Send coordinates; the backend
owns area resolution. This prevents a client from claiming a serviceable area.

### 6.2 Three different meanings that must not be mixed

| Result                                                      | Meaning                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `addressLine` exists                                        | The geocoder understood the coordinate.                                                                      |
| City-level customer reverse-geocode `serviceable: true`     | The pin matched an active Homingo city and the address may be saved.                                         |
| `/geo/serviceability` or `/geo/catalog` `serviceable: true` | The pin is inside an active operational zone, and when a service is supplied, that service is enabled there. |

The compatibility endpoint
`GET /customers/me/addresses/reverse-geocode` currently uses city-level
semantics. Do **not** use its `serviceable` field to enable checkout. Operational
booking UI must use `/geo/serviceability`, `/geo/catalog`, or `/geo/my-location`.

`area: null` means the pin is outside every active internal zone. It does not
mean that Google failed or that the address is missing.

Serviceability business states:

| State                         | API shape                                                                   | UI                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Location covered              | `serviceable: true`, `area != null`                                         | Show location and available catalogue.                             |
| Location outside grid         | `serviceable: false`, `area: null`, `code: LOCATION_NOT_SERVICEABLE`        | Allow browsing/saving if desired; block booking and show `reason`. |
| Area exists, service disabled | `serviceable: false`, `area != null`, `code: SERVICE_NOT_AVAILABLE_IN_AREA` | Keep service visible but disabled.                                 |
| No known saved location       | `/geo/my-location` returns `source: null`, `code: NO_KNOWN_LOCATION`        | Prompt for location/manual pin.                                    |

The tested pin `22.724158, 75.905052` demonstrates this distinction: it returns
`Ring Road, Indore, Madhya Pradesh 452001, India`, but `area: null` and
`LOCATION_NOT_SERVICEABLE` because it lies east of the current pilot grid.

### 6.3 Address state

Maintain:

- address list query;
- selected address ID;
- default address ID;
- create/edit form draft;
- pin-selection and reverse-geocode state;
- deletion confirmation and mutation state.

Address labels are `home | office | other`. Saving an address in an active city
does not guarantee zone-level serviceability. Recheck operational serviceability
when selecting the address for a booking because zones can be renamed,
deactivated, or reconfigured after the address was saved.

### 6.4 Catalogue and booking draft

Use `GET /geo/catalog?lat=&lng=` for the customer funnel. The plain
`GET /catalog/services` endpoint is useful for general search/admin-like browse
but is not location-aware.

Unavailable services are returned with `isAvailable: false`; they are not
removed. Render them as disabled with `unavailableReason` unless product has
explicitly decided to hide them.

Recommended booking draft:

```ts
interface BookingDraft {
  serviceId: string | null;
  addressId: string | null;
  pin: { lat: number; lng: number } | null;
  bookingType: 'instant' | 'scheduled';
  slotStartAt: string | null;
  paymentMode: 'online' | 'cash' | null;
  serviceabilityCheckedAt: string | null;
}
```

Create a booking with only `serviceId`, `addressId`, `paymentMode`, and optional
`slotStartAt`. Never submit price, tax, duration, slot end, customer ID, area ID,
or Pro ID; the backend derives and freezes them.

Recurring bookings are created through recurring-plan endpoints, not by
posting `bookingType: recurring` to `/bookings`.

### 6.5 Booking domain state machine

Backend states are exact string values:

```text
created
  online -> awaiting_payment -> assigning
  cash   ---------------------> assigning
assigning -> assigned -> en_route -> arrived -> started -> completed
assigned may return to assigning during reassignment
en_route <-> arrived may repeat
most non-terminal states may become cancelled
completed and cancelled are terminal
```

| Booking status     | Customer UI                                                                         |
| ------------------ | ----------------------------------------------------------------------------------- |
| `created`          | Short-lived creation state; refetch if it persists.                                 |
| `awaiting_payment` | Show online checkout/retry and cancellation.                                        |
| `assigning`        | Show “Finding a professional”; do not invent a Pro card.                            |
| `assigned`         | Show assigned Pro and acknowledgement/dispatch progress available from the booking. |
| `en_route`         | Enable live tracking and chat.                                                      |
| `arrived`          | Show arrival and start OTP controls.                                                |
| `started`          | Show work in progress; cancellation is an ops judgement flow.                       |
| `completed`        | Show receipt/payment/review actions.                                                |
| `cancelled`        | Terminal cancellation detail, reason, fee/refund state.                             |

Do not optimistically advance booking status. Refetch after lifecycle mutations
and treat the backend result as authoritative.

### 6.6 Payment state

The frontend must read both `paymentMode` and `paymentStatus`.

- Booking payment status: `unpaid | authorized | paid | refunded`.
- Razorpay order status: `created | attempted | paid`.
- Refund status: `none | initiated | settled | failed`.

For a cash booking, `paymentStatus: paid` means the Pro collected cash; there
may be no Razorpay order at all.

Online flow:

1. Create booking.
2. `POST /bookings/:id/payment/order` and open Razorpay Checkout using only the
   returned publishable handoff.
3. On client checkout success, call
   `POST /bookings/:id/payment/verify` with the gateway response.
4. Refetch booking and payment state. A client callback is not proof of payment.
5. Handle delayed webhook updates without moving the UI backwards.

Refund `initiated` and `settled` are visibly different states. The money can
take 5–7 working days after initiation. `refundAmount` is cumulative.

### 6.7 Live tracking socket

- Socket.IO namespace: `/tracking` at the server origin, not under `/api/v1`.
- Handshake auth: `{ token: accessToken }`.
- Client sends `track` with `{ bookingId }`.
- Server emits `tracking` frames.
- Client sends `untrack` when leaving a booking.
- `connect_error: Not authenticated` means refresh/login, not ordinary network
  retry.
- Keep `GET /bookings/:id/tracking` as the fallback when the socket cannot stay
  connected.

Socket state should be explicit:

```ts
type TrackingConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'auth_failed'
  | 'offline';
```

Each tracking frame contains `status`, `proId`, nullable `position`, `isStale`,
nullable `lastReportedAt`, and nullable `etaMinutes`. A stale pin must be labeled
as last known, not rendered as live.

### 6.8 Customer reviews

Only offer review creation for a completed booking. Photo upload is a two-step
presigned flow: request an upload URL, upload bytes directly to storage, then
submit/attach the issued object key as required by the endpoint. Track upload
progress separately from review submission.

## 7. Pro app state

### 7.1 Pro account and access mode

Pro status:

```text
applied | under_review | approved | suspended | rejected
```

`isAvailable` is controlled by admins, not the Pro. Do not build an availability
toggle in the Pro app. Show the current value as read-only with appropriate
operational guidance.

A suspended Pro receives `accessMode: suspended_read_only`. They must still be
able to read standing, job/ratings history, training content, earnings,
commissions, deductions, and payouts. Writes and normal working actions may
return 403. Build a persistent suspension banner and disable write controls;
do not treat suspension as logout.

### 7.2 Onboarding and KYC

Application queue states:

```text
pending | docs_review | call_pending | changes_requested | approved | rejected
```

Document states for Aadhaar and PAN:

```text
pending | verified | rejected
```

The onboarding UI should derive a checklist from the application response, not
collapse the entire process into one `isApproved` boolean. Required screen
states include:

- profile incomplete;
- KYC upload required/uploading/uploaded;
- document pending verification;
- document rejected with reason and re-upload action;
- verification call pending;
- changes requested with resubmit action;
- application approved;
- application rejected.

KYC/private-photo flow:

1. Request a presigned upload URL and key.
2. Upload bytes directly with the required method/content type.
3. Persist/submit the returned key through the Homingo API.
4. Treat URL expiry as recoverable by requesting a new URL; never reuse an
   expired upload URL.

Only masked Aadhaar/PAN and bank-account numbers should be displayed.

### 7.3 Jobs and lifecycle actions

Pro job lists should be grouped into actionable/current/history views using the
same booking states as the customer app.

| Booking state             | Pro action                                                          |
| ------------------------- | ------------------------------------------------------------------- |
| `assigned`                | Acknowledge assignment, then mark en route.                         |
| `en_route`                | Report location; mark arrived.                                      |
| `arrived`                 | Verify customer's start OTP. May return to en route if appropriate. |
| `started`                 | Upload before/after/completion proof and complete the job.          |
| `completed` / `cancelled` | Read-only history.                                                  |

A Pro cannot cancel a booking. Do not expose a client-only cancel action.

The start OTP is a trust boundary. Never cache it in analytics or logs, and do
not simulate a successful start before the verification endpoint succeeds.

### 7.4 Pro location reporting

`POST /pros/me/location` accepts `{ lat, lng }` and returns resolved address/
area information. Device-side state should distinguish:

- permission not requested;
- permission denied;
- acquiring location;
- reporting;
- successfully reported with timestamp;
- temporarily offline/queued;
- rejected because account cannot work.

The backend uses live location rather than storing a route history in the Pro
profile. Avoid presenting an old `lastKnownLat/Lng` as current.

### 7.5 Training

Progress states:

```text
not_started | in_progress | completed
```

Content types:

```text
video | doc | checklist | quiz
```

Session states:

```text
scheduled | held | cancelled
```

Frontend requirements:

- Cache content by module ID **and version**; a version change invalidates the
  downloaded copy.
- Respect `wifiRecommended` as advice and allow override.
- Save video/document progress periodically, not only when leaving the screen.
- `percentComplete` only moves forward.
- Quiz answers are never delivered by the backend. Submit answers for server
  grading.
- Model quiz `submitting`, `passed`, `failed`, `attempts_left`, and `locked`.
- When attempts reach zero, show the admin-reset requirement; do not keep
  resubmitting into a 409 loop.
- Show `mandatoryOutstanding` because it can block service activation where
  the training gate is enabled.

### 7.6 Earnings and payouts

Commission states:

```text
pending | approved | paid | reversed
```

Payout states:

```text
draft | approved | processing | paid | failed | rejected
```

The Pro earnings summary contains commission and incentives, not external
salary payroll. Always display the response's `salaryNote` so a partial number
is not presented as total compensation.

Show deductions as itemized future payout reductions. The system never debits
the Pro's bank account for a reversal.

## 8. Admin panel state

### 8.1 RBAC bootstrap gap that must be resolved

The admin access token exposes `roleId`, but not effective permission codes,
role name, or city scope. The existing role-list endpoint itself requires
`identity.role.manage`, so ordinary admins cannot reliably fetch their own
permissions. There is also no dedicated current-admin endpoint in the present
API.

Before building reliable permission-driven navigation, add or agree on a
backend bootstrap response such as:

```ts
interface CurrentAdminSession {
  id: string;
  actorType: 'admin';
  accessMode: 'full';
  role: {
    id: string;
    name: 'ops' | 'support' | 'finance' | 'super_admin' | string;
    permissionCodes: string[];
  };
  cityScope: string[];
}
```

Recommended endpoint: `GET /auth/me` or `GET /admin/me`.

Until that exists, the server's 403 responses remain authoritative, but using
403 probing to construct the navigation is not an acceptable permanent design.
Do not infer permissions from role names in frontend code.

### 8.2 Permission-driven surfaces

The current permission vocabulary is defined in
`src/modules/identity/constants/permission-code.ts`. Important separation of
duties includes:

- catalogue editing vs commission-rate editing;
- booking cancellation vs refund execution;
- payout approval vs payout disbursement;
- payout read vs payout adjustment;
- cash handover declaration vs admin confirmation;
- general Pro moderation vs bank-account verification;
- booking read vs force-start/dispatch override.

Hide unavailable navigation for usability, but still handle 403 because an
admin's role or city scope can change while the app is open.

### 8.3 City scope

Admin resources can be scoped to one or more city IDs. The backend reloads
scope on every request. The admin frontend needs:

- an effective city-scope list from the proposed bootstrap endpoint;
- one selected city for city-specific screens;
- an “all allowed cities” option only where the endpoint supports it;
- immediate reset/refetch when scope changes or a request returns 403;
- no ability to enter an arbitrary city ID outside scope.

### 8.4 Geo/city operations state machine

The admin Geo surface should be a guided workflow, not a collection of raw
forms:

```text
city selected
  -> city bounds fetched or manually adjusted
  -> grid previewed (no write)
  -> grid generated
  -> address/naming job pending
  -> suggested names reviewed/confirmed
  -> out-of-city cells dry-run reviewed
  -> cells deactivated
  -> Pros posted to active zones
  -> services configured per zone
  -> readiness checked
  -> booking enforcement enabled
```

Required frontend states and safeguards:

- **Bounds:** loading, resolved, manually edited, invalid, provider unavailable.
- **Preview:** cell count, geometry, suggested-name coverage, cost-awareness via
  `nameLimit`, and explicit “no data written” copy.
- **Generation:** confirmation and result; refuse a second grid unless the
  regenerate flow is deliberately selected.
- **Naming:** poll `GET /admin/areas/naming-progress`; display pending,
  suggested, and completion. `addressStatus` is `pending | resolved`.
- **Name review:** preserve `gridRef`; show `nameSource` as `generated`,
  `geocoded`, or `manual`; admin confirmation changes the source to a human
  decision.
- **Address:** show `addressLine`, state, postcode, provider, attribution, and
  refresh action. Do not enable enforcement while required addresses are null.
- **Pruning:** call `POST /admin/areas/deactivate-outside` with `dryRun: true`
  first, show considered/kept/would-deactivate names, then require confirmation
  for the real call.
- **Map editing:** area bounds are half-open rectangles. Shared edges are
  intentional. Surface overlap checks after manual edits.
- **Area activation:** deactivation affects new resolution; historical bookings
  retain the old area.
- **Pro posting:** distinguish posted-to-area from on-duty `isAvailable` and
  from approved/capable-for-service.
- **Service matrix:** render both `isAvailable` and `isConfigured`; “never
  configured” and “explicitly disabled” are operationally different.
- **Replace semantics:** `PUT /admin/areas/:id/services` sends the complete
  desired service-ID list. It is not an incremental toggle request.
- **Enforcement:** `GET /admin/areas/enforcement?cityId=` returns `enabled`,
  `ready`, active-area count, missing addresses, unconfigured areas, and
  unstaffed area/service combinations. `PUT /admin/areas/enforcement` is
  refused with `AREA_ENFORCEMENT_NOT_READY` until every active area has an
  address, at least one service, and capable staffing for enabled services.

Destructive or high-impact operations—regeneration, real pruning, city
activation, enforcement changes, refunds, payout approval/disbursement, and
ledger discrepancy resolution—need confirmation screens that show the exact
scope and consequences.

### 8.5 Other admin domains

Use server-state queries with URL-backed filters for list screens. A copied URL
should restore search, city, status, service, Pro, and date filters.

Build explicit state views for:

- customer blocked/unblocked;
- Pro application queue, document verification, approval, suspension, service
  assignments, area postings, and admin-controlled availability;
- booking lifecycle, status-event timeline, manual reassignment, cancellation,
  and force start;
- catalogue category/service active states, booking modes, price, duration, and
  commission configuration;
- payment order/refund/reconciliation states;
- commission, payout, incentive, and deduction states;
- immutable ledger rows, hash verification, reconciliation run, and discrepancy
  resolution;
- training content publishing, quiz reset, sessions, enrolment, and attendance;
- review visible/hidden moderation state.

Never implement a ledger “edit” UI. Corrections are reversing entries. Never
mark a payout paid when disbursement is merely submitted; `processing` exists
for that interval.

## 9. Features that the frontend must not pretend already exist

The current backend still lacks or only partially covers:

- Safety/SOS/support-ticket APIs.
- Notification delivery and notification history. A Pro assignment is stored,
  but no complete notification module currently guarantees the Pro is alerted.
- General platform-settings APIs beyond the dedicated Geo enforcement surface.
- Server-driven customer home-screen configuration.
- Admin audit-log and async report-export surfaces.
- Admin live dispatch map endpoint.
- Service-centric bulk Pro assignment surface.

Do not ship fake local-only screens for these. Use feature flags, hide the
surface, or display clearly labeled non-interactive placeholders agreed with
product. Recheck the current OpenAPI document because these gaps can change.

## 10. Retry, offline, and cache rules

- Safe GET requests may retry with bounded exponential backoff.
- Do not blindly retry mutations, payment verification, refunds, payout actions,
  grid generation/regeneration, or lifecycle transitions. Refetch first after
  an ambiguous network failure.
- OTP request/resend must respect 429 and server/provider cooldowns.
- Preserve the previous successful query value during a background refresh, but
  show that it is refreshing.
- Cache keys must include every meaningful parameter, especially `lat`, `lng`,
  `serviceId`, `cityId`, filters, and pagination.
- Location-aware catalogue cache entries must not be reused for another pin.
- On reconnect, refresh live bookings and payment state before replaying local
  UI assumptions.
- Queued Pro location updates should be coalesced to the newest coordinate;
  replaying every stale point adds no value.

## 11. Forms and validation

- Generate field constraints from OpenAPI where possible.
- Map `errors[].field` to inputs and keep non-field errors at form/page level.
- Preserve the server's business error `code` for deterministic UI decisions;
  do not branch on English message text.
- Disable submit while a mutation is active.
- On a conflict, retain the user's draft where safe, refetch server state, and
  explain what changed.
- Phone, IFSC, UUID, coordinate, ISO-date, money-string, array-size, and enum
  validation should happen client-side for immediate feedback, but the server
  remains authoritative.

## 12. Security and privacy requirements

- Never log access tokens, refresh tokens, OTPs, provider references, Firebase
  ID tokens, Razorpay signatures, presigned URLs, or full identity documents.
- Use Keychain/Keystore-equivalent secure storage on native apps. On web, keep
  the access token in memory where practical and minimize exposure of the
  refresh token; the current API returns tokens in JSON rather than HttpOnly
  cookies.
- Clear sensitive state on logout, refresh failure, blocked account, or admin
  deactivation.
- Do not expose another user's resource existence; respect backend 404
  non-disclosure.
- Do not send price, commission, eligibility, role, city scope, serviceability,
  booking status, or payout status as client-authoritative values.
- Display only masked Aadhaar, PAN, and bank-account data.
- Treat presigned URLs as short-lived secrets.

## 13. Suggested frontend implementation order

1. Generated API types/client, envelope parser, error normalization, and query
   cache.
2. Secure session store, single-flight refresh, actor routing, and logout.
3. Customer location/address state and location-aware catalogue.
4. Booking draft, booking lifecycle, online/cash payment, and history.
5. Customer live tracking, chat, and reviews.
6. Pro profile/onboarding/KYC/bank state.
7. Pro jobs, lifecycle actions, location reporting, and proof uploads.
8. Pro training, earnings, incentives, deductions, and payouts.
9. Admin current-session/effective-permission backend contract.
10. Admin list framework and city scope.
11. Admin Geo guided workflow.
12. Remaining admin operational and finance surfaces by permission.

## 14. Frontend integration acceptance checklist

- [ ] All API calls use `/api/v1` and unwrap `data` from the shared envelope.
- [ ] The API layer handles bodyless `204` responses.
- [ ] One and only one refresh request can run concurrently.
- [ ] Rotated tokens replace both stored values atomically.
- [ ] 401 and 403 produce different UI states.
- [ ] Empty, loading, refreshing, offline, validation, and server-error states
      are visibly different.
- [ ] Customer launch calls `/geo/my-location` before requesting GPS.
- [ ] Geocoder attribution is displayed with geocoded addresses.
- [ ] Customer booking surfaces use `/geo/catalog`, not only `/catalog/services`.
- [ ] Operational booking availability never relies on the customer
      compatibility endpoint's city-level `serviceable` flag.
- [ ] `area: null`, `position: null`, and `etaMinutes: null` are handled as valid
      business results.
- [ ] No client request supplies area ID, price, duration, tax, Pro ID, or
      booking status for customer booking creation.
- [ ] Money stays decimal-safe and is not calculated with floating point.
- [ ] Booking controls are derived from the exact backend state machine.
- [ ] Tracking socket authenticates in the handshake and HTTP polling remains
      available as fallback.
- [ ] Pro suspension is read-only mode, not forced logout.
- [ ] The Pro app has no self-availability toggle and no cancel-booking action.
- [ ] Upload flows separate URL request, storage upload, and API attachment.
- [ ] Admin navigation is permission-driven once the current-admin bootstrap
      contract exists.
- [ ] Admin city selectors never exceed server-provided scope.
- [ ] Geo pruning uses dry-run before apply.
- [ ] Geo enforcement renders every readiness blocker before enablement.
- [ ] High-impact admin and finance operations require explicit confirmation.
- [ ] Missing backend modules are feature-flagged rather than simulated locally.

## 15. Verification resources

The Geo/Postman scenario currently covers customer OTP registration, city and
zone administration, grid preview/generation/pruning/naming, service matrices,
Pro zone posting, customer address flows, serviceability, catalogue filtering,
customer best-known location, and professional live-location resolution.

Latest isolated verification report:

- 86 HTTP executions;
- 216 assertions;
- 0 failed assertions.

See [the summary](../postman/reports/Homingo-Geo-Indore.summary.md) and
[sanitized captured responses](../postman/reports/Homingo-Geo-Indore.responses.json).
