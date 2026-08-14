# ERD — Data Model v10 (reference copy)

**Source:** Eraser workspace, team TheUnknownGMR — _Home Services App Suite — Data Model v10 (Detailed Scope, Aug 2026)_.
**Captured:** 2026-08-10.

**This is the authority on schema shape** — column names, types and presence.
Where `prisma/schema.prisma` and this file disagree, this file wins and the
schema is wrong. Where this file and `Modules_and_Features 1.md` disagree on
_behaviour_, the ground-rules table wins. Every such conflict found so far is
recorded in [`CONFLICTS_AND_DECISIONS.md`](CONFLICTS_AND_DECISIONS.md).

> ⚠️ **This is a point-in-time copy, not a live view.** The Eraser MCP connector
> is not authorised in this workspace, so it cannot be refreshed automatically.
> If the diagram changes in Eraser, re-paste it here and re-run the reconciliation.

---

```eraser
title Home Services App Suite — Data Model v10 (Detailed Scope, Aug 2026)

// 38 tables. Everything drawn below is a real table. Nothing else is.
//
// ===== v10 CHANGES =====
//   DeviceToken     dropped -> pushToken columns on Customer / Pro / AdminUser
//                   (ONE DEVICE PER USER — multi-device is no longer modelled)
//   Payment         dropped -> attempt detail stays at Razorpay and is read in
//                   THEIR dashboard by razorpayOrderId. The admin console does
//                   not surface it. Order keeps gateway refs and refund state.
//   Assignment      dropped -> the live attempt lives on Booking;
//                   AssignmentCandidate now keys on bookingId + attemptNumber
//   CommissionTier  dropped, and CommissionConfig with it -> commission is one
//                   rate per Service. Duration no longer changes the rate.
//   ProQualityAudit dropped -> CUSTOMER RATING is the only Pro signal that
//                   affects allocation. Pro.acceptanceRate is ANALYTICS ONLY.
//   ProShift        dropped -> Pro.isAvailable is the on/off-duty flag, and it
//                   is SET BY AN ADMIN, never by the Pro. Free windows now
//                   derive from committed Bookings alone.
//
// ===== PAYMENT MODE =====
// Booking.paymentMode is online | cash, FROZEN AT CREATION.
//   online -> awaiting_payment; nothing dispatches until the webhook confirms.
//   cash   -> SKIPS awaiting_payment and dispatches immediately. Money moves at
//             the door, and NO Order row exists for the booking at all — any
//             report joining Order silently undercounts every cash job.
// paymentStatus therefore no longer implies the platform holds the money: for
// cash, "paid" means a Pro is carrying banknotes. Read paymentMode beside it.
// COMMISSION IS IDENTICAL IN BOTH MODES. Collected cash is handed back to the
// platform in full and settled on its own track; it is NEVER netted against
// what a Pro is owed, so CommissionPayout has no cash field.
//
// ===== KYC SOURCE =====
// Each document records where it came from, independently of the other.
//   digilocker -> OAuth consent, issuer-signed document fetched directly. Can
//                 AUTO-VERIFY; nobody looks at it, so record the verifier as
//                 "system" rather than leaving it null. Consent is per-fetch:
//                 pull once, keep the document, discard the token.
//   manual     -> a photograph, needing a human. THIS PATH NEVER GOES AWAY —
//                 DigiLocker only works if the applicant already linked those
//                 documents there, and many will not have.
//
// ===== WHERE STATE LIVES =====
// REDIS (never a table): Pro live GPS (GEO pros:live) · booking ETA · the
//   per-booking assignment lock (SET NX PX) · computed free windows ·
//   the ROTATION LOOKUP, an indexed query over
//   Booking(addressId, proId, completedAt) with cooldown from PlatformSetting.
//   There is no household-history table — that data is already in Booking.
// POSTGRES: everything written once and read in joins, reports or exports.
// RAZORPAY: online payment attempt detail, failure codes, saved instruments —
//   read in the Razorpay dashboard, not mirrored here.
//
// ===== AUTHORITY RULES =====
// 1. Booking.arrivedAt / startedAt / completedAt are AUTHORITATIVE.
//    BookingStatusEvent is the append-only audit of how it got there.
// 2. Booking.proId + assignmentOutcome hold the CURRENT attempt. Prior attempts
//    survive only in AssignmentCandidate and BookingStatusEvent.
// 3. Booking.paymentStatus is business state written by the Razorpay webhook
//    (online) or by the Pro's collection confirmation (cash).
// 4. Pro.ratingSum / ratingCount / assignmentsOffered / assignmentsAcknowledged
//    / completedJobs are EXACT INTEGER COUNTERS, rebuilt nightly.
//    ratingSum + ratingCount DRIVE DISPATCH RANKING — drift there changes who
//    gets work. The assignment counters feed reporting only.
// 5. Pro.isAvailable is written only by an admin; every toggle is audited.
//
// DISPATCH: the system assigns. A Pro can only ACKNOWLEDGE, never decline.
// RANKING: tie-break is SMOOTHED RATING, then load spread —
//   (ratingSum + priorMean x priorWeight) / (ratingCount + priorWeight),
//   both constants in PlatformSetting. A Pro with no reviews ranks at the
//   platform average, so there is no cold start to patch around and no grace
//   flag to expire. acceptanceRate is deliberately NOT a ranking input.
// PRO PAY: salary is out of scope. Commission is the only Pro money computed.
// KYC: Aadhaar + PAN only, as columns on ProApplication.
// GEO: City only.

// =========================================================
// 01 · IDENTITY & CUSTOMER  (Scope 02-A)
// =========================================================

Customer [icon: user, color: blue] {
  id string pk
  deviceId string // guest identity before phone OTP
  phone string unique // null while guest; auth key once verified
  email string // optional, invoice delivery only — never login
  fullName string
  status string // guest | verified
  verifiedAt datetime
  razorpayCustomerId string unique // gateway-side saved instruments live here
  pushToken string // FCM / APNs registration — one device per user
  pushPlatform string // ios | android | web
  pushTokenUpdatedAt datetime
  defaultAddressId string fk
  isBlocked boolean
  createdAt datetime
}

CustomerAddress [icon: map-pin, color: blue] {
  id string pk
  customerId string fk
  label string // home | office | other
  addressLine string
  landmark string
  pinLat decimal // exact pinned coordinate
  pinLng decimal
  geoPoint geojson // routing target, not text address
  cityId string fk
  isDefault boolean
}

// =========================================================
// 02 · GEO & SERVICE CATALOG  (Scope 02-B, 05-E, 05-F)
// =========================================================

City [icon: map, color: green] {
  id string pk
  name string
  state string
  timezone string
  isActive boolean
}

// ---------------------------------------------------------
// SERVICE AREAS  (added 2026-08-11, not in Eraser v10)
// ---------------------------------------------------------
// Three tables the ERD does not have. Recorded here so the diagram and the
// database do not silently diverge — see CONFLICTS_AND_DECISIONS #42.
//
// Before them, "can this customer book this service" had ONE answer:
// City.isActive. A city was open or shut and every service in it was equally
// available everywhere, which cannot express what the business does.
//
// An Area is an axis-aligned RECTANGLE — no PostGIS, no circles. The shape is
// the point: rectangles TILE. A generated grid covers a city with no gaps and
// no overlap by construction, which is why there is no coverage-sampling
// machinery here. The whole geometry question lives in one function, so a
// polygon column can replace this later.
//
// BOUNDS ARE HALF-OPEN: min <= value < max. Adjacent cells share an edge
// exactly (one cell's maxLat IS its neighbour's minLat, the same float), so a
// pin on that edge resolves to precisely one cell instead of two or none.

Area [icon: grid, color: green] {
  id string pk
  cityId string fk
  name string // "Vijay Nagar", or "A1" until an admin renames a generated cell
  minLat float // inclusive
  maxLat float // exclusive
  minLng float // inclusive
  maxLng float // exclusive
  isActive boolean
}

// Availability ONLY. Price stays national and per-service: there are still no
// per-area price rows, and Booking.flatPrice is snapshotted from Service.
AreaService [icon: check-square, color: green] {
  id string pk
  areaId string fk
  serviceId string fk
  isActive boolean
}

// Where a Pro is posted. A FILTER on dispatch, never the ranking — distance
// and travel time still order candidates, and a Pro posted to Vijay Nagar may
// physically be anywhere while travelling.
ProArea [icon: user-check, color: orange] {
  id string pk
  proId string fk
  areaId string fk
  isActive boolean
}

ServiceCategory [icon: layers, color: green] {
  id string pk
  parentCategoryId string fk // null = top-level category
  name string
  slug string unique
  iconUrl string
  sortOrder int
  isActive boolean
}

Service [icon: tag, color: green] {
  id string pk
  categoryId string fk
  name string
  description string
  durationMinutes int // slot sizing only — no longer drives commission
  flatPrice decimal // the single customer-facing price
  commissionType string // percent | flat
  commissionValue decimal // the Pro's commission for this service
  supportsInstant boolean
  supportsScheduled boolean
  supportsRecurring boolean
  isActive boolean
}

// =========================================================
// 03 · BOOKING — job, assignment and invoice on one row
// =========================================================

Booking [icon: clipboard, color: purple] {
  id string pk
  bookingNumber string unique // human-facing reference
  customerId string fk
  serviceId string fk
  addressId string fk
  areaId string fk // added 2026-08-11 (#42). FROZEN at creation like flatPrice:
                   // areas get redrawn and this must keep saying where the job
                   // was sold. Null on bookings predating areas, and on a pin
                   // that resolved to none.
  bookingType string // instant | scheduled | recurring
  recurringPlanId string fk
  rebookedFromBookingId string fk // one-tap re-book
  slotStartAt datetime
  slotEndAt datetime
  flatPrice decimal // frozen at creation
  paymentMode string // online | cash — FROZEN at creation; cash skips awaiting_payment
  paymentStatus string // unpaid | authorized | paid | refunded — webhook-written
  status string // created | awaiting_payment | assigning | assigned | en_route | arrived | started | completed | cancelled
  proId string fk // AUTHORITATIVE current Pro
  assignmentAttempt int // 1 = best candidate, 2 = next best after a timeout
  assignedAt datetime
  notifiedAt datetime
  ackDeadlineAt datetime // window length from PlatformSetting
  acknowledgedAt datetime
  assignmentOutcome string // pending_ack | acknowledged | no_ack_timeout | ops_reassigned | cancelled
  overriddenByAdminId string fk // non-null => manual ops override
  overrideReason string
  arrivedAt datetime // AUTHORITATIVE — BookingStatusEvent is the audit trail
  startOtpProviderRef string // third-party OTP verification reference
  startOtpAttempts int
  startOtpVerifiedByProId string fk
  startedAt datetime // set only on OTP verify — job timer origin
  completedAt datetime // also the rotation source, with addressId + proId
  actualDurationMinutes int
  routeTrail json // sampled polyline, written once at completion
  invoiceNumber string unique // invoice is a Booking artifact, not a table
  invoicePdfUrl string
  taxAmount decimal
  invoicedAt datetime
  cancelledAt datetime
  cancelReason string
  cancelledByType string // customer | pro | ops | system
  cancellationFeeAmount decimal // uncollectable on a cash booking — nothing to charge
  refundedAmount decimal
  createdAt datetime
}

RecurringPlan [icon: repeat, color: purple] {
  id string pk
  customerId string fk
  serviceId string fk
  addressId string fk
  frequency string // daily | weekly | biweekly | monthly
  daysOfWeek json
  timeOfDay time
  startDate date
  endDate date
  nextRunAt datetime
  isActive boolean
}

BookingStatusEvent [icon: activity, color: purple] {
  id string pk
  bookingId string fk
  status string
  actorType string // customer | pro | ops | system
  actorId string
  lat decimal // dispute + SOS evidence
  lng decimal
  occurredAt datetime // append-only; also the record of superseded attempts
}

ChatMessage [icon: message-circle, color: purple] {
  id string pk
  bookingId string fk
  senderType string // customer | pro
  senderId string
  body string
  attachmentUrl string
  sentAt datetime
  readAt datetime
}

JobPhotoProof [icon: camera, color: purple] {
  id string pk
  bookingId string fk
  proId string fk
  photoType string // before | after | completion
  photoUrl string
  lat decimal // geo-stamped: evidence, not decoration
  lng decimal
  capturedAt datetime // mandatory for completion
}

// =========================================================
// 04 · RAZORPAY ORDERS  (Scope 02-D)
// =========================================================
// ONLINE BOOKINGS ONLY. A cash booking has no Order row at all.
// No Payment table either. Attempt-level detail — every try, its failure code,
// the method used — lives at Razorpay and is read in THEIR dashboard by
// razorpayOrderId. Nothing in the admin console surfaces it: a deliberate
// call, not a gap. Only what the platform must join or reconcile on is here.

Order [icon: shopping-bag, color: teal] {
  id string pk
  bookingId string fk // a booking may have several orders (voided, reissued)
  customerId string fk
  razorpayOrderId string unique // rzp order_id — the key for all gateway lookups
  receipt string unique // our reference sent to Razorpay
  amount decimal // stored in rupees; Razorpay transacts in paise
  amountPaid decimal
  amountDue decimal
  currency string // INR
  status string // created | attempted | paid
  attempts int // Razorpay's own counter
  capturedPaymentId string // rzp payment_id of the successful attempt
  paymentMethod string // upi | card | netbanking | wallet, as reported
  failureCode string // last failure only, for support triage
  notesJson json // rzp notes: bookingId, serviceId, cityId
  refundAmount decimal // CUMULATIVE across refunds, never per-refund
  razorpayRefundId string
  refundStatus string // none | initiated | settled | failed
  refundedAt datetime
  createdAt datetime
  paidAt datetime
}

// =========================================================
// 05 · PRO — EMPLOYEE PROFILE & ONBOARDING  (Scope 03-A, 05-C)
// =========================================================
// THREE GATES TO DISPATCHABILITY, all admin-set:
//   1. Pro.status = approved
//   2. at least one ProService with isActive = true
//   3. Pro.isAvailable = true
// Most "why isn't this Pro getting work" questions are one of these.

Pro [icon: users, color: orange] {
  id string pk
  phone string unique // auth key, OTP only
  fullName string
  email string // optional, not login
  employeeCode string unique // payroll identity (payroll itself is external)
  monthlySalary decimal // bookkeeping only — never paid by this system
  salaryUpdatedAt datetime
  status string // GATE 1: applied | under_review | approved | suspended | rejected
  approvedApplicationId string fk // the attempt holding the live KYC record
  isAvailable boolean // GATE 3: on / off duty — ADMIN-SET, never Pro-set
  availabilityUpdatedAt datetime // stamped on every admin toggle; audited
  pushToken string // FCM / APNs registration — one device per user
  pushPlatform string // ios | android
  pushTokenUpdatedAt datetime
  homeBaseLat decimal // fixed at onboarding: fallback dispatch origin
  homeBaseLng decimal
  lastKnownLat decimal // cold fallback, flushed from Redis every ~2 min
  lastKnownLng decimal
  lastLocationAt datetime
  cityId string fk
  ratingSum int // counter: sum of Review.rating — DRIVES DISPATCH RANKING
  ratingCount int // counter: number of reviews — DRIVES DISPATCH RANKING
  assignmentsOffered int // counter: assignments pushed to this Pro
  assignmentsAcknowledged int // counter: acknowledged before the deadline
  acceptanceRate decimal // ANALYTICS ONLY — no effect on ranking or pay
  completedJobs int // counter: bookings completed
  countersRebuiltAt datetime // last nightly rebuild from source tables
  approvedAt datetime // employment start date
  createdAt datetime
}

ProApplication [icon: user-plus, color: orange] {
  id string pk
  proId string fk // one Pro may apply more than once
  referredByType string // pro | customer | none
  referredById string
  submittedAt datetime
  queueStatus string // pending | docs_review | call_pending | approved | rejected
  aadhaarSource string // manual | digilocker — per document, not per application
  aadhaarUrl string
  aadhaarNumberMasked string
  aadhaarStatus string // pending | verified | rejected
  aadhaarVerifiedByAdminId string fk // "system" when digilocker auto-verified — never null
  aadhaarVerifiedAt datetime
  aadhaarRejectionReason string
  panSource string // manual | digilocker — independent of aadhaarSource
  panUrl string
  panNumberMasked string
  panStatus string // pending | verified | rejected
  panVerifiedByAdminId string fk
  panVerifiedAt datetime
  panRejectionReason string
  digilockerRequestId string // consent / fetch reference for documents pulled from DigiLocker
  digilockerFetchedAt datetime // token discarded after the fetch — no standing access
  reviewedByAdminId string fk
  verificationCallAt datetime
  decision string // approved | rejected
  decisionAt datetime
  rejectionReason string
}

ProService [icon: tool, color: orange] {
  id string pk
  proId string fk
  serviceId string fk // matches Booking.serviceId directly
  proficiency string // trainee | skilled | expert
  certifiedAt datetime
  isActive boolean // GATE 2: suspend one service without suspending the Pro
}

ProBankAccount [icon: credit-card, color: orange] {
  id string pk
  proId string fk
  accountHolderName string
  accountNumberMasked string
  ifscCode string
  upiId string
  isPrimary boolean
  isVerified boolean
}

// =========================================================
// 06 · DISPATCH EXPLAINABILITY  (Scope 04)
// =========================================================
// The assignment itself lives on Booking. This table is the audit of every
// Pro the engine evaluated on each attempt, and why they won or lost —
// and, with no Assignment table, the only record of prior attempts.

AssignmentCandidate [icon: list, color: red] {
  id string pk
  bookingId string fk
  attemptNumber int // ties the row to one dispatch run
  proId string fk
  isWinner boolean // the Pro this attempt was assigned to
  windowStart datetime // free window computed from committed Bookings
  windowEnd datetime
  originType string // current_location | last_job_location | home_base
  originLat decimal // travel-origin logic input
  originLng decimal
  rank int
  distanceKm decimal // rule 2
  travelTimeMinutes int // rule 2
  rotationScore decimal // rule 3 — from the Booking-derived rotation lookup
  durationFitScore decimal // rule 4
  ratingScore decimal // rule 4 — SMOOTHED rating, snapshotted at scoring time
  offersToday int // rule 4 tie-break: load spread across equally-rated Pros
  finalRankScore decimal
  excludedReason string // unavailable | out_of_range | rotation_cooldown | already_tried
  evaluatedAt datetime
}

// =========================================================
// 07 · COMMISSION — the only Pro pay this system computes  (Scope 03-D)
// =========================================================
// One rate per Service. No tiers, no duration bands, no per-city config.
// PAYMENT MODE IS NOT AN INPUT. A cash job and an online job of the same
// service pay exactly the same, and collected cash is never netted off a
// payout — it is handed back to the platform in full, separately.

BookingCommission [icon: dollar-sign, color: gold] {
  id string pk
  bookingId string fk unique // one completed job = one commission row
  proId string fk
  customerFlatAmount decimal // what the customer paid
  actualDurationMinutes int // recorded for reporting, no longer sets the rate
  commissionType string // percent | flat — SNAPSHOT from Service
  commissionValue decimal // SNAPSHOT — survives later Service edits
  commissionAmount decimal // what the Pro earns for this job
  platformAmount decimal // customerFlatAmount - commissionAmount
  incentiveAmount decimal
  deductionAmount decimal
  netPayable decimal
  status string // pending | approved | paid | reversed
  computedAt datetime // real-time as the job completes
  payoutId string fk // the disbursement that cleared it
}

CommissionPayout [icon: upload, color: gold] {
  id string pk
  proId string fk
  bankAccountId string fk
  periodStart date
  periodEnd date
  commissionAmount decimal // sum of BookingCommission in this period
  incentiveAmount decimal
  deductionAmount decimal // reversals land here — never a bank debit
  netAmount decimal // commission + incentive - deduction. NO cash offset.
  status string // draft | approved | paid | failed
  approvedByAdminId string fk
  approvedAt datetime
  paidAt datetime
  payoutReference string // razorpayx payout id
}

Incentive [icon: award, color: gold] {
  id string pk
  name string
  incentiveType string // jobs_count | streak | rating | surge_slot
  criteriaJson json
  rewardAmount decimal
  cityId string fk
  validFrom datetime
  validTo datetime
  isActive boolean
}

ProIncentiveProgress [icon: trending-up, color: gold] {
  id string pk
  proId string fk
  incentiveId string fk
  progressValue decimal
  targetValue decimal
  achievedAt datetime
  rewardCredited boolean
  commissionId string fk // the job row the reward was credited against
}

// =========================================================
// 08 · TRAINING & REVIEWS  (Scope 03-E, 03-G)
// =========================================================

TrainingModule [icon: book-open, color: teal] {
  id string pk
  categoryId string fk // trade-level; derived via ProService -> Service
  title string
  contentType string // video | doc | checklist | quiz
  contentUrl string
  durationMinutes int
  isMandatory boolean
  sortOrder int
  isActive boolean
}

ProTrainingProgress [icon: check-square, color: teal] {
  id string pk
  proId string fk
  moduleId string fk
  status string // not_started | in_progress | completed
  percentComplete int
  quizScore decimal
  startedAt datetime
  completedAt datetime
}

OfflineTrainingSession [icon: users, color: teal] {
  id string pk
  categoryId string fk
  title string
  venue string
  scheduledAt datetime // client-run classroom / field training
  durationMinutes int
  trainerName string
  capacity int
  status string // scheduled | held | cancelled
}

OfflineTrainingAttendance [icon: check-circle, color: teal] {
  id string pk
  sessionId string fk
  proId string fk
  enrolledAt datetime
  attended boolean
  markedByAdminId string fk
  completionNotes string
}

Review [icon: star, color: teal] {
  id string pk
  bookingId string fk unique
  customerId string fk
  proId string fk
  rating int // source for Pro.ratingSum / ratingCount — the ONLY signal
             // that changes how much work a Pro gets
  comment string
  photoUrls json // optional customer photos, max from PlatformSetting
  tags json
  isHidden boolean // moderation: abusive text or a photo exposing the home
  hiddenReason string
  hiddenByAdminId string fk
  createdAt datetime
}

// =========================================================
// 09 · SAFETY & SUPPORT  (Scope 02-E, 03-F, 05-D, 06)
// =========================================================

SosAlert [icon: shield, color: pink] {
  id string pk
  raisedByType string // customer | pro
  customerId string fk
  proId string fk
  bookingId string fk
  lat decimal
  lng decimal
  raisedAt datetime
  contextSnapshot json // full booking context to ops
  acknowledgedByAdminId string fk
  acknowledgedAt datetime
  status string // open | acknowledged | resolved | false_alarm
  resolutionNotes string
}

SupportTicket [icon: life-buoy, color: pink] {
  id string pk
  raisedByType string // customer | pro | system
  customerId string fk
  proId string fk
  bookingId string fk
  category string // billing | quality | dispute | app_issue | no_start
  subject string
  priority string
  status string // open | in_progress | escalated | resolved | closed
  isInternal boolean // true = ops-only, never surfaced to customer or Pro
  contextJson json // system-raised detail, e.g. the grace window applied
  assignedAdminId string fk
  resolutionNotes string
  actionTaken string // none | warning | retraining | service_suspended | suspended
  createdAt datetime
  resolvedAt datetime
}

TicketMessage [icon: message-square, color: pink] {
  id string pk
  ticketId string fk
  senderType string // customer | pro | admin
  senderId string
  body string
  attachmentUrl string
  isInternalNote boolean
  sentAt datetime
}

// =========================================================
// 10 · ADMIN, RBAC, CONFIG & OPS  (Scope 05-A, 05-D, 05-F)
// =========================================================

AdminUser [icon: user-check, color: gray] {
  id string pk
  phone string unique // auth key, OTP only
  fullName string
  email string // optional, notifications only
  roleId string fk
  cityScopeJson json
  pushToken string // FCM / APNs registration — one device per user
  pushPlatform string // ios | android | web
  pushTokenUpdatedAt datetime
  isActive boolean
  lastLoginAt datetime
}

Role [icon: shield, color: gray] {
  id string pk
  name string unique // ops | support | finance | super_admin
  description string
  permissionCodes json // ["dispatch.override", "finance.payout.approve", ...]
  isSystemRole boolean
}

PlatformSetting [icon: sliders, color: gray] {
  id string pk
  key string // no_start.graceWindowMinutes | assignment.ackWindowSeconds
             // | rotation.cooldownJobs | dispatch.candidatePoolSize
             // | dispatch.maxAttempts | review.maxPhotos
             // | dispatch.ratingPriorMean | dispatch.ratingPriorWeight
             //   (the last two define the smoothed ranking score — changing
             //    them redistributes work across a whole city)
  cityId string fk // null = global default; a city row overrides it
  value string
  description string
  updatedByAdminId string fk
  updatedAt datetime
}

AdminAuditLog [icon: eye, color: gray] {
  id string pk
  adminUserId string fk
  action string // includes every Pro.isAvailable toggle
  entityType string
  entityId string
  beforeJson json
  afterJson json
  ipAddress string
  createdAt datetime
}

AdminJob [icon: edit, color: gray] {
  id string pk
  adminUserId string fk
  jobType string // bulk_update | report_export
  targetEntity string // bookings | pros | customers | commissions
  filterJson json // by pro, city, service, segment, date range
  changesJson json // bulk_update only — e.g. bulk availability on/off
  format string // report_export only: csv | xlsx | pdf
  recordCount int
  resultFileUrl string // export file or bulk error log
  status string // queued | running | completed | partial | failed
  startedAt datetime
  completedAt datetime
}

// IMPLEMENTATION NOTE (2026-08-13): Module 15 now persists this entity as
// `admin_jobs`. The implementation adds createdAt/updatedAt, progress counters,
// requesterIp, failureReason, and stores `resultFileKey` rather than a signed
// URL; download URLs are generated with a 15-minute expiry. `AdminAuditLog`
// remains deliberately deferred by CONFLICTS_AND_DECISIONS #2/#63.

// =========================================================
// 11 · LEDGER & RECONCILIATION  (Scope 05-G)
// =========================================================

LedgerEntry [icon: database, color: red] {
  id string pk
  entryDate datetime
  txnType string // charge | refund | platform_revenue | pro_commission | deduction | incentive
  debitAccount string // for a cash charge this is cash_in_hand:<proId>, not a bank account
  creditAccount string
  amount decimal
  currency string
  bookingId string fk
  orderId string fk // null for cash bookings — there is no Order
  razorpayPaymentId string // gateway reference, not a local FK
  payoutId string fk
  proId string fk
  customerId string fk
  prevHash string // append-only immutability chain
  entryHash string
  createdAt datetime
}

ReconciliationRun [icon: refresh-cw, color: red] {
  id string pk
  runDate date
  scope string // money | counters | cash | both
  startedAt datetime // nightly automated job
  completedAt datetime
  status string // running | completed | failed
  entriesScanned int
  bookingsScanned int
  countersRebuilt int
  discrepancyCount int
  totalVarianceAmount decimal
  triggeredBy string // scheduler | admin
}

ReconciliationDiscrepancy [icon: alert-triangle, color: red] {
  id string pk
  runId string fk
  entityType string // booking | order | commission | payout | counter
  entityId string
  discrepancyType string // missing_ledger | amount_mismatch | orphan_txn | counter_drift | unsettled_refund | uncollected_cash
  expectedAmount decimal
  actualAmount decimal
  varianceAmount decimal
  resolvedByAdminId string fk
  resolvedAt datetime
  notes string
}

// =========================================================
// 12 · PLATFORM: SERVER-DRIVEN UI & NOTIFICATIONS  (Scope 07)
// =========================================================

UiConfig [icon: smartphone, color: yellow] {
  id string pk
  appType string // customer | pro
  screenKey string // home | category | banner_tray
  version int
  jsonTree json // component-based layout served via CDN
  userSegment string // loads per user context
  cityId string fk
  minAppVersion string
  cdnUrl string
  isPublished boolean
  publishedByAdminId string fk
  publishedAt datetime
  cacheInvalidatedAt datetime
}

NotificationLog [icon: bell, color: yellow] {
  id string pk
  customerId string fk // exactly one recipient FK is set
  proId string fk
  adminUserId string fk
  channel string // push | whatsapp | sms
  templateKey string
  payloadJson json
  bookingId string fk
  providerReference string
  status string // queued | sent | delivered | failed | read
  sentAt datetime
  deliveredAt datetime
}

// =========================================================
// RELATIONSHIPS
// =========================================================

// -- Customer & geo
Customer.id < CustomerAddress.customerId
City.id < CustomerAddress.cityId
City.id < Pro.cityId

// -- Service areas (added 2026-08-11, not in Eraser v10 — see #42)
// Note there is deliberately NO CustomerAddress.areaId: it would be a cache
// nothing maintains, and Booking re-resolves from the pin anyway.
City.id < Area.cityId
Area.id < AreaService.areaId
Service.id < AreaService.serviceId
Area.id < ProArea.areaId
Pro.id < ProArea.proId
Area.id < Booking.areaId

// -- Catalog & skill matching
ServiceCategory.id < ServiceCategory.parentCategoryId
ServiceCategory.id < Service.categoryId
Service.id < ProService.serviceId
Pro.id < ProService.proId

// -- Booking lifecycle & assignment
Customer.id < Booking.customerId
Service.id < Booking.serviceId
CustomerAddress.id < Booking.addressId
RecurringPlan.id < Booking.recurringPlanId
Booking.id < Booking.rebookedFromBookingId
Customer.id < RecurringPlan.customerId
Service.id < RecurringPlan.serviceId
CustomerAddress.id < RecurringPlan.addressId
Pro.id < Booking.proId
Pro.id < Booking.startOtpVerifiedByProId
AdminUser.id < Booking.overriddenByAdminId
Booking.id < BookingStatusEvent.bookingId
Booking.id < ChatMessage.bookingId
Booking.id < JobPhotoProof.bookingId
Pro.id < JobPhotoProof.proId

// -- Dispatch explainability
Booking.id < AssignmentCandidate.bookingId
Pro.id < AssignmentCandidate.proId

// -- Razorpay orders (online bookings only)
Booking.id < Order.bookingId
Customer.id < Order.customerId

// -- Pro onboarding
Pro.id < ProApplication.proId
ProApplication.id < Pro.approvedApplicationId
Pro.id < ProBankAccount.proId

// -- Commission
Booking.id - BookingCommission.bookingId
Pro.id < BookingCommission.proId
CommissionPayout.id < BookingCommission.payoutId
Pro.id < CommissionPayout.proId
ProBankAccount.id < CommissionPayout.bankAccountId
AdminUser.id < CommissionPayout.approvedByAdminId
Pro.id < ProIncentiveProgress.proId
Incentive.id < ProIncentiveProgress.incentiveId
BookingCommission.id < ProIncentiveProgress.commissionId
City.id < Incentive.cityId

// -- Training & reviews
ServiceCategory.id < TrainingModule.categoryId
Pro.id < ProTrainingProgress.proId
TrainingModule.id < ProTrainingProgress.moduleId
ServiceCategory.id < OfflineTrainingSession.categoryId
OfflineTrainingSession.id < OfflineTrainingAttendance.sessionId
Pro.id < OfflineTrainingAttendance.proId
Booking.id - Review.bookingId
Customer.id < Review.customerId
Pro.id < Review.proId
AdminUser.id < Review.hiddenByAdminId

// -- Safety & support
Customer.id < SosAlert.customerId
Pro.id < SosAlert.proId
Booking.id < SosAlert.bookingId
AdminUser.id < SosAlert.acknowledgedByAdminId
Customer.id < SupportTicket.customerId
Pro.id < SupportTicket.proId
Booking.id < SupportTicket.bookingId
AdminUser.id < SupportTicket.assignedAdminId
SupportTicket.id < TicketMessage.ticketId

// -- Admin, RBAC & config
Role.id < AdminUser.roleId
City.id < PlatformSetting.cityId
AdminUser.id < PlatformSetting.updatedByAdminId
AdminUser.id < AdminAuditLog.adminUserId
AdminUser.id < AdminJob.adminUserId
AdminUser.id < ProApplication.reviewedByAdminId
AdminUser.id < ProApplication.aadhaarVerifiedByAdminId
AdminUser.id < ProApplication.panVerifiedByAdminId
AdminUser.id < OfflineTrainingAttendance.markedByAdminId

// -- Ledger & reconciliation
Booking.id < LedgerEntry.bookingId
Order.id < LedgerEntry.orderId
CommissionPayout.id < LedgerEntry.payoutId
Pro.id < LedgerEntry.proId
Customer.id < LedgerEntry.customerId
ReconciliationRun.id < ReconciliationDiscrepancy.runId
AdminUser.id < ReconciliationDiscrepancy.resolvedByAdminId

// -- Platform
City.id < UiConfig.cityId
AdminUser.id < UiConfig.publishedByAdminId
Customer.id < NotificationLog.customerId
Pro.id < NotificationLog.proId
AdminUser.id < NotificationLog.adminUserId
Booking.id < NotificationLog.bookingId
```

---

## Deviations the implementation deliberately carries

Not every difference between this diagram and `prisma/schema.prisma` is a bug.
These are decided, and each has a numbered entry in
[`CONFLICTS_AND_DECISIONS.md`](CONFLICTS_AND_DECISIONS.md):

| ERD says                                       | Implementation                                  | Decision |
| ---------------------------------------------- | ----------------------------------------------- | -------- |
| `AdminAuditLog` is a table                     | Dropped                                         | #2       |
| Admin login is phone OTP only                  | Firebase password/Google token exchange         | #64      |
| `AdminJob.resultFileUrl` is stored             | Private S3 key stored; URL minted per download  | #63      |
| `ProApplication.digilocker*`, `*Source`        | DigiLocker path not implemented or accepted     | #3       |
| `CustomerAddress` has no delivery-notes column | Matches — the column was reverted               | #1       |
| `Service` has no `allowsCash`                  | Matches — the ground rule's column is not added | #13      |
| `Service`/`ServiceCategory` have no editor FK  | Matches — no `updatedByAdminId` added           | #14      |

Everything else in modules 1, 2, 3 and 6 matches this diagram field-for-field.
Modules 4, 5, 7–15 are unbuilt; their tables exist in `schema.prisma` only as
the minimum stubs the built modules needed as foreign keys or counter sources.
