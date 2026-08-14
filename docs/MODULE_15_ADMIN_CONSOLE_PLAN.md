# Module 15 · Admin Console & Reporting backend

**Implementation date:** 2026-08-13  
**Frontend:** separate React + Vite project; this repository supplies APIs only.

## Delivery boundary

This pass deliberately excludes the general `AdminAuditLog` and a new admin
WebSocket namespace. Those are recorded in conflict #63 and must not be treated
as silently completed. The live dispatch API is an HTTP snapshot designed for
polling.

Modules 11 (Safety & Support) and 12 (Notifications) remain unbuilt. The 360
responses mark those sections unavailable instead of returning fake empty
arrays. They can be attached to the existing aggregate endpoints when their
tables and read services exist.

## Reused implementation

No duplicate onboarding, roster, booking, commission, payout, payment, ledger,
training, review, or dispatch engine was added. Module 15 reads their existing
tables and calls `ProsService`, `ProServiceAssignmentsService`, and
`BookingsService` for mutations.

Existing routes remain compatible. The synchronous Pro availability bulk route
is retained; new console work should prefer durable `/admin/bulk-jobs`.

## New backend surface

- Admin context: `GET /admin/me`
- Polling dispatch snapshot: `GET /admin/dispatch/live-map?cityId=`
- Aggregate views: `GET /admin/customers/:id/360`, `GET /admin/pros/:id/360`
- Reassignment: `POST /admin/bookings/:id/reassign`
- Settings: list, upsert and reset under `/admin/platform-settings`
- Async jobs: submit bulk/report jobs, inspect progress and obtain a temporary
  download link under `/admin/jobs`
- Reports: commission, operational, retention and city performance in CSV,
  XLSX or PDF
- Analytics: overview, retention cohorts and city performance

The settings registry covers every key currently consumed by booking,
dispatch, geo, training, reviews, payments, commission and payout services.
Unknown keys are rejected, count settings require whole numbers, and scoped
admins cannot mutate global values.

The generated Postman Module 15 folder contains 21 saved requests. Together
they cover every new route, both supported bulk targets, all four report types,
all three artifact formats, expected response examples, environment chaining
and executable value assertions.

## Safety rules

- City scope is validated at submission and again while each bulk row runs.
- Report type access also requires the underlying booking, customer or payout
  permission.
- Generated files are private S3 objects; only the key is stored and every
  download URL is short-lived.
- Bulk updates are idempotent safe edits only: Pro availability and Pro-service
  activation. Successful rows survive partial failure and errors are exported.
- GMV and platform revenue are separate. Cash bookings are included even though
  they have no `Order` row.
- Commission reports read snapshotted `BookingCommission` values and never
  recalculate historical earnings from the current catalogue.
