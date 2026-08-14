# Homingo — API Inventory

**Date:** 12 August 2026
**Purpose:** one list of every API that exists, and every API still missing, so we do not build something twice.

Generated from the backend source, not from memory — every path below was read out of a controller file.

**Totals:** 231 endpoints built.

| Who calls it               | Built |
| -------------------------- | ----- |
| Customer app               | 33    |
| Pro app                    | 50    |
| Admin panel                | 133   |
| Auth (shared by all three) | 7     |
| Public, no login           | 6     |
| Razorpay webhooks          | 2     |

**Base URL:** every path is prefixed with `/api/v1`.

---

## How to read this

- **Section 1** — what already exists. Do not rebuild any of it.
- **Section 2** — what does not exist yet, and who it is for.
- **Section 3** — decisions we need from you.

The **Permission** column applies to admin endpoints only. It is the grant an admin's role must carry. Customer and Pro endpoints are scoped to the logged-in user instead — a customer can only ever read their own bookings.

---

# Section 1 — Already built

### Customer app — 33 endpoints

#### Bookings

| Method | Path                             | What it does                             | Permission |
| ------ | -------------------------------- | ---------------------------------------- | ---------- |
| POST   | `/bookings`                      | Book a service                           | —          |
| POST   | `/bookings/:id/rebook`           | Repeat a past booking                    | —          |
| GET    | `/bookings`                      | My booking history                       | —          |
| GET    | `/bookings/live`                 | My live orders                           | —          |
| GET    | `/bookings/recurring-plans`      | My recurring plans                       | —          |
| POST   | `/bookings/recurring-plans`      | Set up a recurring plan                  | —          |
| PATCH  | `/bookings/recurring-plans/:id`  | Pause, resume or adjust a recurring plan | —          |
| GET    | `/bookings/:id`                  | Get one of my bookings                   | —          |
| POST   | `/bookings/:id/cancel`           | Cancel a booking                         | —          |
| POST   | `/bookings/:id/start-otp/resend` | Resend the start code                    | —          |
| GET    | `/bookings/:id/tracking`         | Where is my Pro?                         | —          |
| GET    | `/bookings/:id/messages`         | Read the chat thread                     | —          |
| POST   | `/bookings/:id/messages`         | Message the Pro                          | —          |

#### Profile & addresses

| Method | Path                                      | What it does                                         | Permission |
| ------ | ----------------------------------------- | ---------------------------------------------------- | ---------- |
| GET    | `/customers/me/addresses/reverse-geocode` | Reverse geocode a map pin and resolve serviceability | —          |
| GET    | `/customers/me`                           | Get my profile                                       | —          |
| PATCH  | `/customers/me`                           | Update my profile                                    | —          |
| GET    | `/customers/me/addresses`                 | List my saved addresses                              | —          |
| POST   | `/customers/me/addresses`                 | Add a saved address                                  | —          |
| PATCH  | `/customers/me/addresses/:id`             | Update a saved address                               | —          |
| DELETE | `/customers/me/addresses/:id`             | Delete a saved address                               | —          |
| PATCH  | `/customers/me/addresses/:id/default`     | Mark an address as the default                       | —          |
| GET    | `/customers/me/serviceability`            | Check whether a city is currently serviceable        | —          |

#### Location & serviceability

| Method | Path                             | What it does                                   | Permission |
| ------ | -------------------------------- | ---------------------------------------------- | ---------- |
| GET    | `/geo/my-location`               | Where do you already think I am?               | —          |
| GET    | `/geo/reverse-geocode`           | Turn a pin into a human-readable address       | —          |
| GET    | `/geo/catalog`                   | What can I book at this pin?                   | —          |
| GET    | `/geo/serviceability`            | Can we serve this pin, and this service at it? | —          |
| GET    | `/geo/services/:serviceId/areas` | Everywhere a service is live                   | —          |

#### Payments

| Method | Path                           | What it does                | Permission |
| ------ | ------------------------------ | --------------------------- | ---------- |
| POST   | `/bookings/:id/payment/order`  | Open checkout for a booking | —          |
| POST   | `/bookings/:id/payment/verify` | Verify a completed checkout | —          |
| GET    | `/bookings/:id/payment`        | Payment status of a booking | —          |

#### Reviews

| Method | Path                                            | What it does                                   | Permission |
| ------ | ----------------------------------------------- | ---------------------------------------------- | ---------- |
| POST   | `/bookings/:bookingId/review`                   | Review the Pro who did this job                | —          |
| GET    | `/bookings/:bookingId/review`                   | My review of this job                          | —          |
| POST   | `/bookings/:bookingId/review/photos/upload-url` | Presigned URL for a photo of the finished work | —          |

### Pro app — 50 endpoints

#### Bookings

| Method | Path                                      | What it does                        | Permission |
| ------ | ----------------------------------------- | ----------------------------------- | ---------- |
| GET    | `/pros/me/bookings`                       | My assigned jobs                    | —          |
| GET    | `/pros/me/bookings/:id`                   | Get one assigned job                | —          |
| POST   | `/pros/me/bookings/:id/en-route`          | Mark en route                       | —          |
| POST   | `/pros/me/bookings/:id/arrived`           | Mark arrival                        | —          |
| POST   | `/pros/me/bookings/:id/verify-otp`        | Enter the customer’s start code     | —          |
| POST   | `/pros/me/bookings/:id/photos/upload-url` | Get a presigned URL for a job photo | —          |
| POST   | `/pros/me/bookings/:id/photos`            | Attach an uploaded photo to the job | —          |
| GET    | `/pros/me/bookings/:id/photos`            | Photos already attached to this job | —          |
| POST   | `/pros/me/bookings/:id/complete`          | Complete the job                    | —          |
| GET    | `/pros/me/bookings/:id/messages`          | Read the chat thread                | —          |
| POST   | `/pros/me/bookings/:id/messages`          | Message the customer                | —          |

#### Earnings & payouts

| Method | Path                                | What it does                                     | Permission |
| ------ | ----------------------------------- | ------------------------------------------------ | ---------- |
| GET    | `/pros/me/earnings/summary`         | My earnings today, this period and lifetime      | —          |
| GET    | `/pros/me/earnings/commissions`     | Job-by-job earnings                              | —          |
| GET    | `/pros/me/earnings/commissions/:id` | What one job paid, and why                       | —          |
| GET    | `/pros/me/incentives`               | Bonus schemes open to me, and how far along I am | —          |
| GET    | `/pros/me/deductions`               | What is being held back, and why                 | —          |
| GET    | `/pros/me/payouts`                  | My payout history                                | —          |
| GET    | `/pros/me/payouts/:id`              | One payout                                       | —          |
| GET    | `/pros/me/payouts/:id/commissions`  | What this payout covered                         | —          |

#### Dispatch

| Method | Path                                | What it does              | Permission |
| ------ | ----------------------------------- | ------------------------- | ---------- |
| POST   | `/pros/me/bookings/:id/acknowledge` | Acknowledge an assignment | —          |

#### Payments

| Method | Path                                            | What it does                           | Permission |
| ------ | ----------------------------------------------- | -------------------------------------- | ---------- |
| POST   | `/pros/me/bookings/:id/cash-collection`         | Record cash collected at the door      | —          |
| POST   | `/pros/me/bookings/:id/cash-collection/decline` | Report that the customer would not pay | —          |
| GET    | `/pros/me/cash-balance`                         | What you are carrying                  | —          |
| POST   | `/pros/me/cash-handovers`                       | Declare a handover                     | —          |
| GET    | `/pros/me/cash-handovers`                       | Your handover history                  | —          |

#### Profile, KYC & bank

| Method | Path                                | What it does                                                                                             | Permission |
| ------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------- |
| GET    | `/pros/me`                          | Get my profile                                                                                           | —          |
| PATCH  | `/pros/me`                          | Update my profile                                                                                        | —          |
| POST   | `/pros/me/profile-photo/upload-url` | Get a private S3 upload URL for my profile photo                                                         | —          |
| PATCH  | `/pros/me/profile-photo`            | Attach an issued private S3 photo key to my profile                                                      | —          |
| GET    | `/pros/me/standing`                 | My standing; rating affects dispatch, acceptance does not                                                | —          |
| GET    | `/pros/me/jobs`                     | My paginated job history                                                                                 | —          |
| GET    | `/pros/me/ratings`                  | Ratings I have received                                                                                  | —          |
| GET    | `/pros/me/earnings`                 | Commission-only earnings summary                                                                         | —          |
| GET    | `/pros/me/commissions`              | My commission history                                                                                    | —          |
| POST   | `/pros/me/location`                 | Push my live GPS position (Redis GEO — this is not stored history)                                       | —          |
| GET    | `/pros/me/applications`             | List my onboarding applications                                                                          | —          |
| POST   | `/pros/me/applications`             | Submit (or re-submit) an onboarding application                                                          | —          |
| POST   | `/pros/me/kyc/upload-url`           | Get a presigned S3 PUT URL — PUT the file bytes there, then submit the returned key as aadhaarUrl/panUrl | —          |
| GET    | `/pros/me/bank-accounts`            | List my bank accounts                                                                                    | —          |
| POST   | `/pros/me/bank-accounts`            | Add a bank account                                                                                       | —          |
| PATCH  | `/pros/me/bank-accounts/:id`        | Update a bank account                                                                                    | —          |

#### Reviews

| Method | Path                                             | What it does                             | Permission |
| ------ | ------------------------------------------------ | ---------------------------------------- | ---------- |
| POST   | `/pros/me/bookings/:bookingId/review`            | Rate this customer                       | —          |
| GET    | `/pros/me/bookings/:bookingId/review`            | My rating of this customer               | —          |
| GET    | `/pros/me/bookings/:bookingId/customer-advisory` | What previous Pros found at this address | —          |

#### Training

| Method | Path                                   | What it does                         | Permission |
| ------ | -------------------------------------- | ------------------------------------ | ---------- |
| GET    | `/pros/me/training`                    | What I need to learn                 | —          |
| GET    | `/pros/me/training/manifest`           | Everything worth downloading on wifi | —          |
| GET    | `/pros/me/training/sessions`           | My classroom and field sessions      | —          |
| GET    | `/pros/me/training/:moduleId`          | Open a module                        | —          |
| PATCH  | `/pros/me/training/:moduleId/progress` | Save where I am                      | —          |
| POST   | `/pros/me/training/:moduleId/quiz`     | Submit a quiz attempt                | —          |

### Admin panel — 133 endpoints

#### Bookings

| Method | Path                                      | What it does                                    | Permission            |
| ------ | ----------------------------------------- | ----------------------------------------------- | --------------------- |
| GET    | `/admin/bookings`                         | List bookings                                   | `BOOKING_READ`        |
| GET    | `/admin/bookings/:id`                     | Reconstruct a job                               | `BOOKING_READ`        |
| GET    | `/admin/bookings/:id/cancellation-window` | Which cancellation window this booking is in    | `BOOKING_READ`        |
| POST   | `/admin/bookings/:id/assign`              | Assign a Pro by hand                            | `DISPATCH_OVERRIDE`   |
| POST   | `/admin/bookings/:id/force-start`         | Start a job without the customer’s code         | `BOOKING_FORCE_START` |
| POST   | `/admin/bookings/:id/cancel`              | Cancel a booking as ops                         | `BOOKING_CANCEL`      |
| POST   | `/admin/bookings/expire-unpaid`           | Cancel online bookings that were never paid for | `BOOKING_CANCEL`      |
| POST   | `/admin/bookings/recurring-plans/run`     | Generate any recurring occurrences now due      | `BOOKING_READ`        |

#### Catalogue

| Method | Path                                       | What it does                                         | Permission               |
| ------ | ------------------------------------------ | ---------------------------------------------------- | ------------------------ |
| GET    | `/admin/catalog/categories`                | List categories, including inactive ones             | `CATALOG_MANAGE`         |
| POST   | `/admin/catalog/categories`                | Create a category                                    | `CATALOG_MANAGE`         |
| PATCH  | `/admin/catalog/categories/:id`            | Update a category                                    | `CATALOG_MANAGE`         |
| PATCH  | `/admin/catalog/categories/:id/activation` | Activate or deactivate a category                    | `CATALOG_MANAGE`         |
| DELETE | `/admin/catalog/categories/:id`            | Delete an empty category                             | `CATALOG_MANAGE`         |
| GET    | `/admin/catalog/services`                  | List services, including drafts and deactivated ones | `CATALOG_MANAGE`         |
| POST   | `/admin/catalog/services`                  | Create a service                                     | `CATALOG_MANAGE`         |
| PATCH  | `/admin/catalog/services/:id`              | Update a service                                     | `CATALOG_MANAGE`         |
| PATCH  | `/admin/catalog/services/:id/commission`   | Set the commission rate for a service                | `CATALOG_COMMISSION_SET` |
| PATCH  | `/admin/catalog/services/:id/activation`   | Activate or deactivate a service                     | `CATALOG_MANAGE`         |
| GET    | `/admin/catalog/cities`                    | List cities, including unlaunched ones               | `CATALOG_CITY_MANAGE`    |
| POST   | `/admin/catalog/cities`                    | Add a city to the registry                           | `CATALOG_CITY_MANAGE`    |
| PATCH  | `/admin/catalog/cities/:id`                | Update a city                                        | `CATALOG_CITY_MANAGE`    |
| PATCH  | `/admin/catalog/cities/:id/activation`     | Launch or pause a city                               | `CATALOG_CITY_MANAGE`    |

#### Earnings & payouts

| Method | Path                                   | What it does                             | Permission               |
| ------ | -------------------------------------- | ---------------------------------------- | ------------------------ |
| GET    | `/admin/commissions`                   | List computed commissions                | `PAYOUT_READ`            |
| GET    | `/admin/commissions/:id`               | One commission in full                   | `PAYOUT_READ`            |
| POST   | `/admin/commissions/:id/reverse`       | Reverse a commission                     | `PAYOUT_ADJUST`          |
| POST   | `/admin/commissions/:id/deduction`     | Raise a deduction against one job        | `PAYOUT_ADJUST`          |
| POST   | `/admin/commissions/recompute-missing` | Run the missing-commission sweeper now   | `PAYOUT_ADJUST`          |
| GET    | `/admin/services/missing-commission`   | Services with no commission rate         | `CATALOG_COMMISSION_SET` |
| GET    | `/admin/pros/:id/deductions`           | Everything outstanding against one Pro   | `PAYOUT_READ`            |
| POST   | `/admin/deductions/:id/waive`          | Forgive what is left of a deduction      | `PAYOUT_ADJUST`          |
| GET    | `/admin/incentives`                    | List bonus schemes                       | `INCENTIVE_MANAGE`       |
| POST   | `/admin/incentives`                    | Create a bonus scheme                    | `INCENTIVE_MANAGE`       |
| GET    | `/admin/incentives/:id`                | One bonus scheme                         | `INCENTIVE_MANAGE`       |
| PATCH  | `/admin/incentives/:id`                | Edit a bonus scheme                      | `INCENTIVE_MANAGE`       |
| POST   | `/admin/incentives/:id/deactivate`     | Stop a scheme crediting anything further | `INCENTIVE_MANAGE`       |
| GET    | `/admin/incentives/:id/progress`       | Who has won this, and who is close       | `INCENTIVE_MANAGE`       |
| POST   | `/admin/payouts/generate`              | Build draft payouts for a period         | `PAYOUT_APPROVE`         |
| GET    | `/admin/payouts`                       | List payout batches                      | `PAYOUT_READ`            |
| GET    | `/admin/payouts/summary`               | Finance dashboard totals                 | `PAYOUT_READ`            |
| GET    | `/admin/payouts/:id`                   | One payout batch                         | `PAYOUT_READ`            |
| GET    | `/admin/payouts/:id/commissions`       | The line items behind a batch total      | `PAYOUT_READ`            |
| POST   | `/admin/payouts/:id/approve`           | Approve a batch for disbursement         | `PAYOUT_APPROVE`         |
| POST   | `/admin/payouts/:id/reject`            | Send a batch back                        | `PAYOUT_APPROVE`         |
| POST   | `/admin/payouts/:id/disburse`          | Send an approved batch to the bank       | `PAYOUT_DISBURSE`        |
| POST   | `/admin/payouts/:id/retry`             | Try a failed batch again                 | `PAYOUT_DISBURSE`        |

#### Profile & addresses

| Method | Path                           | What it does       | Permission |
| ------ | ------------------------------ | ------------------ | ---------- |
| GET    | `/admin/customers`             | List customers     | —          |
| GET    | `/admin/customers/:id`         | Customer 360       | —          |
| PATCH  | `/admin/customers/:id`         | Block a customer   | —          |
| PATCH  | `/admin/customers/:id/block`   | Block a customer   | —          |
| PATCH  | `/admin/customers/:id/unblock` | Unblock a customer | —          |

#### Dispatch

| Method | Path                                      | What it does                                      | Permission          |
| ------ | ----------------------------------------- | ------------------------------------------------- | ------------------- |
| GET    | `/admin/dispatch/queue`                   | How many bookings are waiting to be dispatched    | `DISPATCH_OVERRIDE` |
| POST   | `/admin/dispatch/drain`                   | Run the queue now                                 | `DISPATCH_OVERRIDE` |
| POST   | `/admin/dispatch/bookings/:id/run`        | Dispatch one booking now                          | `DISPATCH_OVERRIDE` |
| GET    | `/admin/dispatch/bookings/:id/candidates` | Why this Pro, and why not that one                | `DISPATCH_OVERRIDE` |
| GET    | `/admin/dispatch/unassignable`            | Bookings nobody could take                        | `DISPATCH_OVERRIDE` |
| POST   | `/admin/dispatch/expire-acknowledgements` | Close attempts nobody acknowledged and retry them | `DISPATCH_OVERRIDE` |

#### Location & serviceability

| Method | Path                                 | What it does                                               | Permission             |
| ------ | ------------------------------------ | ---------------------------------------------------------- | ---------------------- |
| POST   | `/admin/areas/bulk`                  | Draw several rectangles by hand                            | `CATALOG_CITY_MANAGE`  |
| POST   | `/admin/areas/generate-grid`         | Open a city — lay a gapless grid of cells over it          | `CATALOG_CITY_MANAGE`  |
| GET    | `/admin/areas/city-bounds`           | How big is this city, actually?                            | `CATALOG_CITY_MANAGE`  |
| POST   | `/admin/areas/preview-grid`          | See a grid before creating it                              | `CATALOG_CITY_MANAGE`  |
| POST   | `/admin/areas/generate-grid-for-box` | Lay a grid over a rectangle                                | `CATALOG_CITY_MANAGE`  |
| POST   | `/admin/areas/deactivate-outside`    | Drop every cell outside a boundary, in one call            | `CATALOG_CITY_MANAGE`  |
| POST   | `/admin/areas/regenerate`            | Replace a city map — the supported way to change cell size | `CATALOG_CITY_MANAGE`  |
| GET    | `/admin/areas/service-matrix`        | Every area in a city against every live service            | `CATALOG_CITY_MANAGE`  |
| POST   | `/admin/areas`                       | Draw one rectangle by hand                                 | `CATALOG_CITY_MANAGE`  |
| GET    | `/admin/areas`                       | Areas in a city, each ready to be recognised               | `CATALOG_CITY_MANAGE`  |
| POST   | `/admin/areas/suggest-names`         | Suggest a real name for every unnamed grid cell            | `CATALOG_CITY_MANAGE`  |
| GET    | `/admin/areas/naming-progress`       | How far the naming pass has got                            | `CATALOG_CITY_MANAGE`  |
| PATCH  | `/admin/areas/:id`                   | Rename, re-bound or deactivate an area                     | `CATALOG_CITY_MANAGE`  |
| GET    | `/admin/areas/:id/overlaps`          | Which neighbours this area genuinely overlaps              | `CATALOG_CITY_MANAGE`  |
| GET    | `/admin/areas/:id/services`          | Services listed for this area                              | `CATALOG_CITY_MANAGE`  |
| POST   | `/admin/areas/:id/services`          | Turn ONE service on or off in this area                    | `CATALOG_CITY_MANAGE`  |
| PUT    | `/admin/areas/:id/services`          | Replace this area’s entire service list                    | `CATALOG_CITY_MANAGE`  |
| POST   | `/admin/areas/:id/services/copy`     | Copy another area’s availability onto this one             | `CATALOG_CITY_MANAGE`  |
| POST   | `/admin/areas/by-service/:serviceId` | Turn one service on or off across many areas               | `CATALOG_CITY_MANAGE`  |
| POST   | `/admin/areas/:id/pros`              | Post a Pro to this area, or take them off it               | `PRO_AVAILABILITY_SET` |
| GET    | `/admin/areas/:id/pros`              | Pros posted to this area                                   | `PRO_AVAILABILITY_SET` |
| GET    | `/admin/areas/by-pro/:proId`         | Where one Pro is posted                                    | `PRO_AVAILABILITY_SET` |

#### Admin users & roles

| Method | Path                     | What it does                        | Permission          |
| ------ | ------------------------ | ----------------------------------- | ------------------- |
| GET    | `/admin/admin-users`     | List all admin users                | `ADMIN_USER_MANAGE` |
| POST   | `/admin/admin-users`     | Provision a new admin user          | `ADMIN_USER_MANAGE` |
| PATCH  | `/admin/admin-users/:id` | Update an admin user                | `ADMIN_USER_MANAGE` |
| GET    | `/admin/roles`           | List all roles                      | `ROLE_MANAGE`       |
| POST   | `/admin/roles`           | Create a role                       | `ROLE_MANAGE`       |
| PATCH  | `/admin/roles/:id`       | Update permissions for a fixed role | `ROLE_MANAGE`       |

#### Ledger

| Method | Path                                              | What it does                                            | Permission     |
| ------ | ------------------------------------------------- | ------------------------------------------------------- | -------------- |
| GET    | `/admin/ledger`                                   | Read the ledger                                         | `LEDGER_READ`  |
| GET    | `/admin/ledger/verify`                            | Verify the hash chain                                   | `LEDGER_READ`  |
| GET    | `/admin/ledger/balances`                          | Account balances                                        | `LEDGER_READ`  |
| GET    | `/admin/finance/dashboard`                        | What came in today, what is owed out, where the cash is | `LEDGER_READ`  |
| POST   | `/admin/reconciliation/run`                       | Run reconciliation now                                  | `LEDGER_AUDIT` |
| GET    | `/admin/reconciliation/runs`                      | Reconciliation history                                  | `LEDGER_READ`  |
| GET    | `/admin/reconciliation/discrepancies`             | Everything still unresolved                             | `LEDGER_READ`  |
| GET    | `/admin/reconciliation/runs/:id`                  | One run and everything it found                         | `LEDGER_READ`  |
| POST   | `/admin/reconciliation/discrepancies/:id/resolve` | Close a finding                                         | `LEDGER_AUDIT` |

#### Payments

| Method | Path                                | What it does                                              | Permission              |
| ------ | ----------------------------------- | --------------------------------------------------------- | ----------------------- |
| GET    | `/admin/orders`                     | List gateway orders                                       | `PAYMENT_READ`          |
| GET    | `/admin/orders/:id`                 | One order                                                 | `PAYMENT_READ`          |
| GET    | `/admin/orders/:id/attempts`        | Every attempt against an order                            | `PAYMENT_READ`          |
| POST   | `/admin/bookings/:id/refund`        | Refund a booking, fully or partly                         | `PAYMENT_REFUND`        |
| GET    | `/admin/cash-handovers`             | Handovers waiting to be counted                           | `CASH_HANDOVER_CONFIRM` |
| POST   | `/admin/cash-handovers/:id/confirm` | Confirm a handover you have counted                       | `CASH_HANDOVER_CONFIRM` |
| POST   | `/admin/cash-handovers/:id/reject`  | Reject a handover                                         | `CASH_HANDOVER_CONFIRM` |
| GET    | `/admin/payments/reconciliation`    | Cross-check our records against Razorpay and against cash | `PAYMENT_READ`          |

#### Profile, KYC & bank

| Method | Path                                                      | What it does                                               | Permission               |
| ------ | --------------------------------------------------------- | ---------------------------------------------------------- | ------------------------ |
| GET    | `/admin/pro-applications`                                 | List onboarding applications                               | `PRO_APPLICATION_REVIEW` |
| PATCH  | `/admin/pro-applications/:id/verify-document`             | Verify or reject one document (Aadhaar/PAN independently)  | `PRO_APPLICATION_REVIEW` |
| GET    | `/admin/pro-applications/:id/documents/:docType/view-url` | Get a short-lived presigned URL to view a KYC document     | `PRO_APPLICATION_REVIEW` |
| PATCH  | `/admin/pro-applications/:id/log-call`                    | Log a verification call against an application             | `PRO_APPLICATION_REVIEW` |
| PATCH  | `/admin/pro-applications/:id/decision`                    | Approve or reject an application                           | `PRO_APPLICATION_REVIEW` |
| GET    | `/admin/pros`                                             | List Pros (roster view)                                    | `PRO_MODERATE`           |
| PATCH  | `/admin/pros/:id/profile`                                 | Suspend a Pro                                              | `PRO_MODERATE`           |
| PATCH  | `/admin/pros/:id/suspend`                                 | Suspend a Pro                                              | `PRO_MODERATE`           |
| PATCH  | `/admin/pros/:id/reinstate`                               | Reinstate a suspended Pro                                  | `PRO_MODERATE`           |
| PATCH  | `/admin/pros/:id/availability`                            | Toggle a single Pro on/off duty                            | `PRO_AVAILABILITY_SET`   |
| PATCH  | `/admin/pros/availability/bulk`                           | Bulk toggle a set of Pros on/off duty                      | `PRO_AVAILABILITY_SET`   |
| GET    | `/admin/pros/:id/services`                                | Assign a Pro to a service                                  | `PRO_MODERATE`           |
| POST   | `/admin/pros/:id/services`                                | Assign a Pro to a service                                  | `PRO_MODERATE`           |
| PATCH  | `/admin/pros/:id/services/:serviceId`                     | Update a Pro-service assignment (e.g. suspend one service) | `PRO_MODERATE`           |
| GET    | `/admin/pros/:id/bank-accounts`                           | Vouch for (or withdraw) a payout destination               | `PRO_BANK_VERIFY`        |
| PATCH  | `/admin/pros/:id/bank-accounts/:accountId/verification`   | Vouch for (or withdraw) a payout destination               | `PRO_BANK_VERIFY`        |

#### Reviews

| Method | Path                            | What it does                                 | Permission        |
| ------ | ------------------------------- | -------------------------------------------- | ----------------- |
| GET    | `/admin/reviews`                | Browse reviews in both directions            | `REVIEW_MODERATE` |
| POST   | `/admin/reviews/:id/hide`       | Hide a review’s content                      | `REVIEW_MODERATE` |
| POST   | `/admin/reviews/:id/unhide`     | Restore a hidden review                      | `REVIEW_MODERATE` |
| GET    | `/admin/customers/:id/feedback` | What Pros have reported about this household | `REVIEW_MODERATE` |

#### Training

| Method | Path                                                       | What it does                          | Permission        |
| ------ | ---------------------------------------------------------- | ------------------------------------- | ----------------- |
| GET    | `/admin/training/modules`                                  | Browse training modules               | `TRAINING_MANAGE` |
| POST   | `/admin/training/modules`                                  | Create a training module              | `TRAINING_MANAGE` |
| POST   | `/admin/training/modules/upload-url`                       | Presigned URL for module content      | `TRAINING_MANAGE` |
| PATCH  | `/admin/training/modules/:id`                              | Edit a training module                | `TRAINING_MANAGE` |
| GET    | `/admin/training/pros/:proId`                              | One Pro’s training and eligibility    | `PRO_MODERATE`    |
| POST   | `/admin/training/pros/:proId/modules/:moduleId/reset-quiz` | Give a Pro their quiz attempts back   | `TRAINING_MANAGE` |
| GET    | `/admin/training/sessions`                                 | Browse offline training sessions      | `TRAINING_MANAGE` |
| POST   | `/admin/training/sessions`                                 | Schedule a classroom or field session | `TRAINING_MANAGE` |
| GET    | `/admin/training/sessions/:id`                             | One session and its attendee list     | `TRAINING_MANAGE` |
| PATCH  | `/admin/training/sessions/:id`                             | Reschedule, cancel or close a session | `TRAINING_MANAGE` |
| POST   | `/admin/training/sessions/:id/enrolments`                  | Enrol Pros                            | `TRAINING_MANAGE` |
| POST   | `/admin/training/sessions/:id/attendance`                  | Mark who turned up                    | `TRAINING_MANAGE` |

### Shared / no login — 15 endpoints

#### Auth (all three apps)

| Method | Path                         | What it does                                                  | Permission |
| ------ | ---------------------------- | ------------------------------------------------------------- | ---------- |
| POST   | `/auth/guest-session`        | Create/resume a guest customer session from a device id       | —          |
| POST   | `/auth/otp/request`          | Send a Slide OTP for a Customer, Pro, or existing Admin phone | —          |
| POST   | `/auth/otp/verify`           | Verify the OTP and receive an actor-scoped token pair         | —          |
| POST   | `/auth/admin/firebase-login` | Legacy login for Admin rows already linked to Firebase        | —          |
| POST   | `/auth/refresh`              | Rotate a refresh token for a new token pair                   | —          |
| POST   | `/auth/logout`               | Revoke the session tied to one refresh token                  | —          |
| POST   | `/auth/logout-all`           | Revoke every session for the current identity                 | —          |

#### Public browsing (no login)

| Method | Path                               | What it does                             | Permission |
| ------ | ---------------------------------- | ---------------------------------------- | ---------- |
| GET    | `/cities`                          | List active cities                       | —          |
| GET    | `/catalog/categories`              | Browse the category tree                 | —          |
| GET    | `/catalog/categories/:id/services` | List the active services in one category | —          |
| GET    | `/catalog/services`                | Search and filter bookable services      | —          |
| GET    | `/catalog/services/:id`            | Get one service by id                    | —          |
| GET    | `/pros/:proId/reviews`             | What customers said about this Pro       | —          |

#### Gateway webhooks (called by Razorpay, not by any app)

| Method | Path                         | What it does                      | Permission |
| ------ | ---------------------------- | --------------------------------- | ---------- |
| POST   | `/payouts/razorpayx/webhook` | RazorpayX payout webhook receiver | —          |
| POST   | `/payments/razorpay/webhook` | Razorpay webhook receiver         | —          |

---

# Section 2 — Not built yet

Four modules are missing entirely, plus two partial gaps. Feature lists below come from the project's own module document, not from us.

## 2.1 Safety & Support (Module 11) — nothing exists

Needed by **all three apps**.

**Customer app**

- Raise an SOS (one tap, sends live location + booking context)
- Raise a support ticket
- See my tickets and reply on the thread

**Pro app**

- Raise an SOS
- Raise a support ticket
- See my tickets and reply

**Admin panel**

- SOS alert queue — these must skip the normal ticket queue
- Acknowledge an SOS, then resolve or mark false alarm
- Ticket list with filters (billing, quality, dispute, app issue, no-start)
- Reply on a ticket, plus internal notes the raiser cannot see
- Set priority, escalate, assign to a support admin
- Close with a resolution note

**Also in this module:** automatic no-start detection — when a Pro marks arrival but never starts within the grace window, a ticket is raised for ops by itself. The Pro is never told.

## 2.2 Notifications (Module 12) — nothing exists

No app-facing endpoints. It is a service other modules call.

- Push via FCM (Android) and APNs (iOS)
- WhatsApp for OTP and transactional messages, SMS as fallback
- Templates with per-template channel routing
- Delivery status tracking
- Per-booking notification history, for support

**What this blocks today:** a Pro is assigned a booking and **is never told**. The system records when it should have notified them, but nothing sends. Right now a Pro has to open the app and look.

## 2.3 Config (Module 14) — model exists, no API

The `platform_settings` table holds ~20 numbers that control system behaviour, and each one can differ per city. **There is no way to read or change any of them except by editing the database directly.**

Needed:

- Admin: list settings for a city
- Admin: change one setting for a city
- Admin: reset a setting to its default

**What this blocks today — the important one:** `geo.enforceAreaServiceAvailability` ships **off**. The whole service-area system records which area a booking falls in, and logs that a booking _should_ have been refused, **but never actually refuses it**. Turning that gate on requires this API.

Other settings behind the same gap: dispatch pool size, acknowledgement window, travel-time target, cancellation fee, tax percent, commission auto-approve window.

**Also in Module 14:** `UiConfig` — server-driven home screen for the customer app, so the app's layout can change without an app-store release. Not built, and a bigger piece than settings.

## 2.4 Admin Console & Reporting (Module 15) — backend core built

The existing module-specific admin routes remain the operational source of
truth. Module 15 adds the cross-module aggregation and asynchronous surfaces:

| Method         | Path                                                         | Purpose                                                              |
| -------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| GET            | `/admin/me`                                                  | Current role, permission set and city scope                          |
| GET            | `/admin/dispatch/live-map`                                   | City-scoped polling snapshot of live bookings and Pros               |
| GET            | `/admin/customers/:id/360`                                   | Customer, bookings, orders, refunds and reviews in one read          |
| GET            | `/admin/pros/:id/360`                                        | Pro standing, raw acceptance counts, services, training and earnings |
| POST           | `/admin/bookings/:id/reassign`                               | Validated specific-Pro override or redispatch                        |
| GET/PUT/DELETE | `/admin/platform-settings`                                   | Effective settings and city overrides                                |
| POST           | `/admin/bulk-jobs`                                           | Async Pro availability or Pro-service activation job                 |
| POST           | `/admin/reports/exports`                                     | Async CSV/XLSX/PDF report export                                     |
| GET            | `/admin/jobs`, `/admin/jobs/:id`, `/admin/jobs/:id/download` | Progress and private artifact download                               |
| GET            | `/admin/analytics/overview`                                  | Bookings, GMV, platform revenue and dispatch outcomes                |
| GET            | `/admin/analytics/retention`                                 | 30/60/90-day repeat cohorts                                          |
| GET            | `/admin/analytics/cities`                                    | City performance aggregates                                          |

Explicitly deferred by conflict #63: general administrative audit storage and
admin WebSockets. Modules 11/12 are still required to populate ticket, SOS and
notification sections in the 360 views.

## 2.5 Two smaller gaps

**Service → Pro assignment (admin).** Today a Pro is assigned to services from the Pro's own screen. There is no way to open a service and add Pros to it. When a new service launches, an admin must open every Pro one at a time. The reverse direction already exists for areas (`POST /admin/areas/by-service/:serviceId`), so this would follow the same shape.

**Live dispatch map (admin).** Module 15 lists a live map of bookings and Pros. Live positions are already written and read; there is no endpoint that returns them for a map view.

---

# Section 3 — Decisions we need

**1. Which of the four missing modules comes next?**
Our suggested order, and why:

| Order | Module                    | Why                                                                                    |
| ----- | ------------------------- | -------------------------------------------------------------------------------------- |
| 1     | **Config (14)**           | Smallest, and it unblocks the service-area gate that is already built but switched off |
| 2     | **Notifications (12)**    | Pros are not being told about their assignments at all                                 |
| 3     | **Safety & Support (11)** | Needed before launch — SOS and disputes                                                |
| 4     | **Admin Console (15)**    | Reports and audit; useful, not blocking                                                |

**2. Who builds Config?**
It is a backend module, so it belongs with the backend developer. We are asking rather than starting, because a review module we built ourselves last week had to be deleted when the proper Module 10 landed and declared the same route. We would rather not repeat that.

**3. Customer app — which catalogue endpoint is it calling?**
There are two:

- `GET /geo/catalog?lat=&lng=` — area-aware. Marks each service available or not for that pin.
- `GET /catalog/services` — the plain list. **No location awareness at all.**

If the app is calling the second one, the entire service-area feature is invisible to customers. Worth confirming with the app team.

**4. Should unavailable services be hidden or shown greyed out?**
Currently they are **returned and flagged**, not hidden — the reasoning being that a thinly-mapped new area would otherwise look like an empty product. Confirm this is what you want.

---

## One thing that is built but switched off

The service-area system is complete: areas can be drawn on a map, named from Google, given their own service lists, and staffed with Pros. Bookings already record which area they fall into.

It just does not **stop** anything yet, because the switch that makes it enforce lives behind the missing Config API. That is one small API away from being live.
