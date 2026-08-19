# Module 16 · Loyalty — Wallet, Subscriptions, Referrals, and the Cancellation Policy

**Date:** 2026-08-19
**Branch:** `soojal-1`
**Scope:** four features requested together, because they turn out to be one
feature: Homingo Coins, subscription plans, Refer & Earn, and a
cancellation/reschedule policy with a real clock in it.

**Companion documents:**

- [`CONFLICTS_AND_DECISIONS.md`](CONFLICTS_AND_DECISIONS.md) §67–§74 — every
  contradiction this module ran into and how it was settled.
- [`MODULE_STATUS_REPORT.md`](MODULE_STATUS_REPORT.md) §16 — feature-by-feature
  status and known gaps.
- [`Modules_and_Features 1.md`](Modules_and_Features%201.md) → **Cancellation &
  Refund Flow** — the six windows this policy extends rather than replaces.

---

## 1 · Why these four are one module

They were asked for as four things. They are one, and the join is a single
column: **`Booking.payableAmount`**.

A coin redemption, a subscription discount, a referral bonus spent on a job and
a cancellation refund are all statements about _what this customer actually
owes for this booking_ — a number that did not previously exist, because
`flatPrice` was both the list price and the charge. Splitting them apart would
have produced four features each with its own idea of what a booking costs, and
the first cancellation of a discounted booking would have refunded the wrong
amount.

So the module adds one column and makes every money path read it.

```
flatPrice            the catalogue price, frozen at creation — unchanged
  − subscriptionDiscountAmount    the plan's percentage, capped
  − walletDiscountAmount          coins × coin value
  = payableAmount                 what the gateway charges, what the Pro collects,
                                  what a refund returns, what coins are earned on
```

Two CHECK constraints enforce that arithmetic in the database, because a
booking whose parts do not add up is money that has gone somewhere nobody can
name.

---

## 2 · The rule the whole module is built around

> **Nothing pays out for an intention. Everything pays out for a completed
> job.**

- Coins are earned on **completion**, not on booking.
- A referral rewards when the referee's **first job finishes**, not when they
  sign up.
- A subscription is worth nothing until its **payment is confirmed**.

Each is the cheapest available defence against the same attack. A signup, a
booking and a checkout intent all cost an attacker nothing. A completed job
costs them a real payment at a real address that a real Pro visited.

Everything else in the referral design — the unique index on `refereeId`, the
self-referral CHECK, the per-referrer cap, the qualifying window — exists to
keep that one rule from being routed around.

---

## 3 · Data model

Seven new tables. Full comments live in `prisma/schema.prisma` §16.

| Table                    | Holds                                         | The decision worth knowing                                                                                         |
| ------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `customer_wallets`       | One balance per customer                      | `balanceCoins` is a **cache**; the log is the truth. Same relationship as `Pro.cashInHand` to the ledger           |
| `wallet_transactions`    | Every coin movement, append-only              | Modelled on `LedgerEntry`, **not in** the money ledger — coins are an entitlement, not currency (§68)              |
| `subscription_plans`     | The catalogue marketing edits                 | A row, not code. Marketing changes what a plan gives away far more often than engineering deploys                  |
| `customer_subscriptions` | One purchase                                  | Every perk **frozen at purchase**, exactly as `Booking.flatPrice` is frozen from `Service`                         |
| `referral_codes`         | One shareable code per customer               | Separate from `Referral` so "what is my code" is not a scan of everyone you ever referred                          |
| `referrals`              | One referrer → one referee, and what happened | `refereeId` is **unique** — a customer can be referred once, ever. That constraint is the whole anti-farming story |
| `booking_reschedules`    | Every slot move                               | Append-only like `BookingStatusEvent`. A reschedule is an event with a before and an after, not an edit            |

New columns on `Booking`: `coinsRedeemed`, `walletDiscountAmount`,
`subscriptionDiscountAmount`, `discountAmount`, `payableAmount`,
`subscriptionId`, `rescheduleCount`, `originalSlotStartAt`.

### The constraints that carry rules

Fifteen CHECK constraints and three partial/unique indexes. The ones that are
load-bearing rather than defensive:

| Constraint                                        | Refuses                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `bookings_discount_parts_check`                   | A booking whose discount does not equal its parts                                               |
| `bookings_payable_check`                          | A payable that is not price less discount                                                       |
| `wallet_transactions_direction_check`             | An `earn` that debits, a `redeem` that credits — the sign error that mints currency             |
| `wallet_transactions_adjustment_attributed_check` | An admin adjustment with no admin on it                                                         |
| `customer_wallets_balance_non_negative_check`     | An overdraft. Coins are not credit                                                              |
| `customer_subscriptions_one_active_per_customer`  | Two live plans, **including under concurrency** — a partial unique index, not a read-then-write |
| `referrals_refereeId_key`                         | Being referred twice, ever                                                                      |
| `referrals_no_self_referral_check`                | Referring yourself                                                                              |
| `referrals_qualifyingBookingId_key`               | One job paying two referral rewards                                                             |
| `booking_reschedules_requested_by_check`          | A Pro moving a job — principle 2, applied to the other half of the decision                     |

The whole migration was **applied against the live RDS schema** inside a
`BEGIN … ROLLBACK`, per the technique in `MODULE_11_SAFETY_SUPPORT_PLAN.md`
§14.1 — so every constraint definition above is known to be accepted by the
deployed database. Seven of them were then **probed with a row that should be
refused**, and all seven refused it. The remaining eight are asserted by the
service-layer tests but have not been individually probed at the database. See
§9.

---

## 4 · Homingo Coins

### Earning

The rate rises with how many jobs the customer has had done — which is the
literal request, "discount on the basis of how much services they've booked".

| Tier     | Completed jobs | Earn rate |
| -------- | -------------- | --------- |
| bronze   | 0–4            | 3%        |
| silver   | 5–14           | 5%        |
| gold     | 15–39          | 7%        |
| platinum | 40+            | 10%       |

Every number is a `PlatformSetting`, seeded by the migration.

Three decisions inside that table:

1. **Completed bookings, not money spent.** Counting spend would tier by wallet
   size instead of by loyalty, and a household booking one expensive job a year
   would outrank a weekly regular. Counting jobs also keeps the promise legible
   — a customer can see why they moved up.
2. **The completing job counts.** A customer's fifth booking earns at the
   silver rate, not the bronze one. Rewarding the fifth at the fourth's rate is
   exactly the off-by-one that generates support tickets.
3. **Earned on `payableAmount`, not `flatPrice`.** Otherwise a subscriber with
   a large balance recycles the same coins upward every booking — a loop that
   pays itself.

### Spending

- 1 coin = ₹1 by default (`wallet.coinValueRupees`).
- At most 20% of a booking (`wallet.maxRedemptionPercent`).
- The request is **clamped, never rejected**. Asking to spend more than you
  hold spends what you have. Refusing would make the coin slider an error state
  instead of a control.

### The order the two discounts apply

**Subscription first; coins fill what is left.** A subscriber is entitled to
their percentage whether or not they have coins, and computing it on an
already-discounted amount would silently shrink the benefit they paid for.
Coins then cap against the **list** price, so the 20% ceiling means the same
thing to every customer.

### Expiry

Credits carry their own `expiresAt`, set from the setting **at the moment of
credit** — so changing `wallet.coinExpiryDays` cannot retroactively expire
coins already granted. The sweep expires **credit by credit**, not by balance,
and writes a debit naming the grant that lapsed, so the statement explains the
loss rather than showing a balance that fell for no visible reason.

Admin adjustments never expire. An adjustment is usually an apology, and an
apology with a 12-month fuse on it is a second complaint waiting.

### Concurrency

`WalletService.move` is the only writer. It takes `SELECT … FOR UPDATE` on the
one wallet row — per customer, unlike the ledger's platform-wide chain lock,
because a wallet balance is a single row and a chain is not. Every movement
carries a `sourceRef`, unique-indexed, which is what makes a retried completion
or a double-tapped button credit once.

---

## 5 · Subscriptions

Purchase is **two calls**, deliberately:

```
POST /customers/me/subscriptions   → status = pending_payment   (entitles nothing)
POST /admin/loyalty/subscriptions/:id/activate  → status = active
```

An entitlement created in the same call that takes the money would be live
before the money arrived, and a failed checkout would leave a customer
discounted for free.

Everything the plan gives is **copied onto the subscription** at purchase. A
customer who bought 10% off keeps 10% off for the whole cycle, whatever
marketing does to the plan next week. `PATCH /admin/loyalty/plans/:id` changes
what new buyers get and nothing else.

`findActive` lapses a subscription in passing: a row whose `expiresAt` has gone
by is treated as gone from that moment, and the hourly sweep that writes the
status down is a tidy-up rather than the authority. Reading a stale `active`
row as live would discount a booking against a plan that ended last night.

An **exhausted `includedBookings` allowance is not an expired plan**: the coin
multiplier, the fee waiver and the extra reschedules all still apply. Only the
per-booking percentage stops.

Seeded plans (`prisma/seed.ts`, upserted by `code`, never overwriting a
repricing):

| Plan             | Price  | Cycle    | Off | Coins | Waives fee | Extra reschedules |
| ---------------- | ------ | -------- | --- | ----- | ---------- | ----------------- |
| Homingo Silver   | ₹299   | 90 days  | 5%  | 1.5×  | no         | 1                 |
| Homingo Gold     | ₹699   | 180 days | 10% | 2×    | yes        | 2                 |
| Homingo Platinum | ₹1,499 | 365 days | 15% | 3×    | yes        | 4                 |

---

## 6 · Refer & Earn

```
referee enters code   → Referral(pending), nothing credited
referee's first job completes → qualified → both sides credited → rewarded
window closes with no job     → expired
```

**Everything that can be refused is refused at attribution**, not at reward
time: unknown code, own code, blocked code, capped code, an account that has
already completed a booking, an account that has already used a code. Telling
somebody their code was no good _after_ they completed a booking and expected
coins is a support ticket; telling them as they type it is a validation
message.

The "already a customer" check counts **completed** jobs, not any booking, so a
cancelled first attempt does not cost someone their referral.

The two credits are separate movements with separate `sourceRef`s, and the
status only moves to `rewarded` once both have landed — which is what makes the
sweep's blind retry safe. A referral stuck at `qualified` is genuinely earned
and genuinely owed; the sweep finds it every hour until it pays.

Codes are six characters from an alphabet with **no `0`/`O` and no `1`/`I`/`L`**,
generated with `crypto.randomInt` rather than `Math.random`. The alphabet is
the point: this code is read aloud across a kitchen table and typed by someone
who has had the app for four minutes. A CHECK constraint enforces the format so
a second generator written later cannot reintroduce the ambiguity.

Ops has an abuse brake (`isBlocked` on one code) that does **not** touch
referrals already earned — a reward fairly won is not clawed back by a later
suspicion — and `reject` refuses outright once a referral has been paid.
Reversing credited coins is a wallet adjustment, so it appears in the
customer's statement with a reason rather than vanishing.

---

## 7 · Cancellation & reschedule

### What already existed

`booking.types.ts` answered "which of the six windows is this booking in", from
its **status** alone. `BookingCancellationService` executed it. Both are
unchanged.

### What was missing

That was always only half the question. A booking sitting in `assigned` for a
slot three days out and a booking sitting in `assigned` for a slot in forty
minutes are the same window and are not remotely the same decision: in the
first, nobody has organised their day around it; in the second, a Pro's
afternoon is already committed to an address they can no longer fill.

So `cancellation-policy.ts` adds the second axis — **how long until the Pro was
due** — and the two together decide the fee. The status windows keep deciding
the refund mechanics, the assignment teardown and whether ops must be involved.

### The rules, in the order they apply

1. **Only a customer pays.** An ops or system cancellation is the platform's
   own failure (US-4.22).
2. **A subscriber whose plan waives the fee pays nothing.** The headline perk,
   so it beats every rule below it.
3. **More than 6 hours before the slot is free** — whatever the window,
   including window D. A Pro marked en route six hours early has not lost the
   afternoon. `booking.freeCancellationHours`.
4. **Inside the cutoff, 25% of `payableAmount` is retained.** A percentage, not
   a flat fee: retaining ₹100 on a ₹300 job and on a ₹3,000 job are different
   decisions. `booking.lateCancellationFeePercent`.
5. **Window D inside the cutoff takes whichever is greater** — the percentage
   or the flat window-D fee. Someone is standing at the door; that is the one
   case where the platform's floor applies.
6. **Window A is always free**, and a fee **never exceeds what the customer
   owes**. A cancellation must not turn into a debt.

Window E is absent on purpose: "partial, at ops discretion" is a judgement, and
routing it to a formula is what US-4.21 warns against.

**Coins come back regardless of the fee.** The fee is money and the coins are
an entitlement; retaining both would charge the customer twice for one
cancellation.

`GET /bookings/:id/cancellation-policy` renders the confirm screen from **the
same function that executes the cancellation**. A preview that can disagree
with the action is worse than no preview: the customer agrees to one number and
is charged another. It returns `freeUntil` — the instant after which it stops
being free — which is the one number a customer actually wants.

### Rescheduling

A reschedule is the outcome the platform actually wants from "I can't make it":
the job survives, the customer keeps their money and the Pro keeps a filled
slot, where a cancellation loses all three. So it is deliberately cheaper than
cancelling — free inside the allowance (two moves, plus whatever the plan
adds).

**It is refused rather than charged inside the cutoff.** Six hours out, the
Pro's day is already built around this address; moving it then is not a smaller
version of cancelling, it is the same disruption with the platform still on the
hook for the new slot. The customer is told to cancel, where the fee is at
least honest about what happened. The new slot must clear the cutoff too, or a
customer could move a job to two hours from now and land in exactly the state
the rule prevents.

A booking that already had a Pro returns to `assigning`, the assignment is
closed, and dispatch re-runs against the new time.

Ops **bypasses the allowance** — a customer out of moves can still be helped by
a human — but **not the cutoff**. The cutoff exists because of what a Pro's
committed afternoon costs, and that cost does not change because an admin is
the one clicking.

---

## 8 · What changed outside this module's folder

Confined and listed, because two developers share this codebase and a shared
file is a coordination event.

| File                                       | Change                                                     | Why it is not optional                                                   |
| ------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `payments/orders.service.ts`               | Gateway order amount `flatPrice` → `payableAmount`         | Charging the list price to a customer quoted a discounted one            |
| `payments/cash-collection.service.ts`      | Cash collected `flatPrice` → `payableAmount`               | A Pro insisting on ₹500 for a job the customer part-paid in coins        |
| `payments/reconciliation.service.ts`       | Uncollected-cash variance reads `payableAmount`            | Every discounted cash job would report as a variance                     |
| `bookings/booking-lifecycle.service.ts`    | Invoice built on `payableAmount`; completion calls loyalty | An invoice must show what the customer was billed                        |
| `bookings/bookings.service.ts`             | Quote + freeze discounts at creation; order for payable    | Where the price is decided                                               |
| `bookings/booking-cancellation.service.ts` | Time-aware fee; refund on `payableAmount`; returns coins   | Refunding the list price hands back money that never changed hands       |
| `identity/constants/permission-code.ts`    | Four new codes                                             | New guarded admin endpoints                                              |
| `app.module.ts`                            | `LoyaltyModule` registered after `SupportModule`           | Must construct after `BookingsModule` to register into its port delegate |

**Commission was deliberately left on `flatPrice`** — see
`CONFLICTS_AND_DECISIONS.md` §71. A Pro did the same work whether or not
marketing discounted the job; the discount is a platform marketing cost, not a
pay cut.

### How the module attaches

One port, `LOYALTY_PORT`, which **module 4 owns** — the same shape as
`COMMISSION_PORT` and for the same reason. Module 16 imports `BookingsModule`;
module 4 knows nothing about module 16. That direction is forced: the discount
must be computed before the booking row is written, and module 16 reads module
4's `PlatformSettingsService` for its own tunables.

Bound to a no-op inside `BookingsModule`, so a deployment without this module
prices every booking at its flat price, earns nothing, and cancels under the
plain policy — exactly how the platform behaved before module 16 existed. That
is what makes the module removable.

---

## 9 · Verification

| Check                            | Result                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `npm run typecheck`              | clean                                                                             |
| `npm run lint`                   | clean                                                                             |
| `npx jest`                       | **1,242 / 1,242** across 99 suites (was 1,085 / 1,085 across 93)                  |
| `npm run test:e2e`               | **181 / 181** across 8 suites                                                     |
| `module-graph.e2e-spec.ts`       | the real `AppModule` graph resolves with `LoyaltyModule` in it                    |
| `http-routes.e2e-spec.ts`        | Fastify registers every route with no collision                                   |
| Route probe against a booted app | all 33 new routes registered                                                      |
| Migration against live RDS       | applied cleanly inside `BEGIN … ROLLBACK`; **7 constraints probed, all enforced** |

### The migration was verified without being applied

`prisma migrate status` shows the standing drift condition recorded in the RDS
notes: `20260815100000_start_otp_minted_in_house` is applied on the shared
database and exists in no local branch. So `migrate deploy` and `migrate dev`
were both **not run** — that is a coordination event with the teammate, not
something to resolve unilaterally.

Instead the migration SQL was executed against the live schema inside a single
transaction and rolled back. Postgres has transactional DDL, so the whole file
plus every CHECK constraint was exercised against the real deployed schema with
zero net effect. Seven probe statements were then run inside the same
transaction to prove the constraints actually bite:

```
MIGRATION APPLIED CLEANLY
enforced  bookings_payable_check
enforced  referrals_no_self_referral_check
enforced  wallet_transactions_direction_check
enforced  subscription_plans_discount_percent_check
enforced  customer_subscriptions_one_active_per_customer
enforced  referral_codes_code_format_check
enforced  booking_reschedules_requested_by_check
rolled back — the database is untouched
```

### New test coverage

| Suite                           | Tests | Covers                                                               |
| ------------------------------- | ----- | -------------------------------------------------------------------- |
| `loyalty.types.spec.ts`         | 27    | tier ladder, earn arithmetic, the discount order, code normalisation |
| `wallet.service.spec.ts`        | 26    | movement, overdraft, idempotency, expiry, cache-vs-log rebuild       |
| `referrals.service.spec.ts`     | 22    | attribution refusals, the completion reward, the stuck-payment retry |
| `subscriptions.service.spec.ts` | 19    | two-step purchase, frozen perks, lapse-on-read, allowance exhaustion |
| `cancellation-policy.spec.ts`   | 35    | the six-hour cutoff on both axes, reschedule refusals                |
| `booking-reschedule.service`    | 15    | the move end to end: slot, audit row, Pro release, ops bypass        |
| `booking-cancellation.service`  | +13   | the time-aware fee end to end, coins returned, the confirm screen    |

---

## 10 · Known gaps

Stated rather than discovered.

1. ~~**Online subscription checkout is not wired to Razorpay.**~~ **Closed
   2026-08-19** — see §11. `Order.bookingId` is now nullable with a
   `subscriptionId` beside it and a CHECK requiring exactly one, so a customer
   buys a plan through the same Razorpay flow a booking uses
   (`POST /customers/me/subscriptions/:id/checkout`). Decision #75.
2. **`priorityDispatch` is stored and read by nothing.** Module 5 ranks
   candidates by travel time and rotation; adding a subscriber tiebreak is a
   dispatch change, and shipping the column without the behaviour is honest
   only because this list says so.
3. **No notifications.** Nothing tells a customer their coins are about to
   expire, their plan is about to lapse, or their referral just paid. All three
   are `NotificationTemplate` rows plus an `enqueue` call — small, and
   deliberately out of this pass rather than half-done.
4. **The nightly reconciliation does not rebuild wallet balances.**
   `rebuildBalance` exists and is exposed at
   `POST /admin/loyalty/customers/:id/wallet/rebuild`, but module 9's counter
   rebuild does not call it yet, so drift self-heals only when someone asks.
5. **Referral-code counters are incremented on write and never rebuilt.** Same
   shape as every other counter here; `Referral` is the source, and nothing
   recomputes from it on a schedule.
6. **Returned coins get a fresh expiry window**, because nothing records which
   credits a redemption consumed — the coins spent on one booking may have come
   from several credits with different dates. Reconstructing that would mean a
   FIFO lot ledger for a discount entitlement. What it concedes: booking and
   cancelling pushes an expiring balance out by another window. It costs the
   customer a booking they did not want and gains them nothing they did not
   already own, so it is cheap to leave open and expensive to close.

---

## 11 · Online plan checkout — closed 2026-08-19

The gap #72 deferred is now closed. A customer buys a plan through the same
Razorpay flow a booking uses.

```
POST /customers/me/subscriptions            → pending_payment, entitles nothing
POST /customers/me/subscriptions/:id/checkout → gateway order + Razorpay handoff
   … customer pays …
payment.captured (webhook, or verify racing it) → plan activates, coins granted
```

### What made it possible

`Order` stopped meaning "the gateway side of a booking" and started meaning
**"the gateway side of one thing the customer is buying"** — which is now
either a booking or a subscription. `bookingId` is nullable, `subscriptionId`
sits beside it, and `orders_exactly_one_subject_check` requires exactly one.
Full reasoning, and why a parallel `SubscriptionOrder` table was rejected, in
`CONFLICTS_AND_DECISIONS.md` #75.

### How the two modules reach each other

A second port, `SUBSCRIPTION_PORT`, which **module 7 owns** — mirroring
`SUPPORT_PORT` exactly. Module 16 already imported `BookingsModule`; it now
imports `PaymentsModule` too and registers into the delegate at boot. Module 7
still knows nothing about module 16, so there is no cycle:

```
LoyaltyModule ──imports──> PaymentsModule ──imports──> BookingsModule
      │                          ▲
      └──registers into──────────┘  (SUBSCRIPTION_PORT)
```

The stub is the one in this codebase that **throws on its read half**.
`getPurchasable` runs before any money moves, so refusing costs a customer a
retryable checkout screen; returning a fake price would take a real payment for
a plan nothing can grant. `activateFromPayment` runs after, so it cannot refuse
— it is instead the loudest log in module 7, because a charged customer with no
plan is a support call, not a statistic.

### Where each rule is enforced

**Everything that can refuse the purchase happens before the gateway order
exists**, so nothing has to refuse after a card has been charged:

| Checked in `getPurchasable`      | Refuses                                                  |
| -------------------------------- | -------------------------------------------------------- |
| ownership, in the `where` clause | somebody else's subscription — same 404 as a missing one |
| `status = pending_payment`       | a plan already active, expired or cancelled              |
| `paymentMode = online`           | a cash or complimentary plan — there is nothing to pay   |
| `findActive(customerId)`         | a customer who already has a live plan                   |

That last one matters more than it looks: a customer can create a pending plan,
buy a different one, then come back to pay for the first. Charging them for a
plan the database would then refuse to activate is the worst possible order of
events.

### On capture

`onFirstCapture` splits on which subject the order has — a total branch, not a
guard, because the CHECK constraint guarantees exactly one. The subscription
half keeps the booking half's ordering rule for the same reason: the customer
gets what they paid for **before** the ledger entry, because a plan that took
money and never activated is customer-visible while a missing ledger row is
rebuildable.

Activation is non-fatal there. The money is already captured, and throwing
would make Razorpay retry a webhook that has already done its real work.
Activation is idempotent on module 16's side, so the webhook, the verify call
racing it, and an ops re-run from the admin route all converge on one live plan
and one grant of welcome coins.

### Verification

| Check                              | Result                                                                                                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `npx jest`                         | **1,255 / 1,255** across 100 suites                                                                   |
| `npm run test:e2e`                 | **181 / 181** — including the module graph, which proves the two-way port wiring builds with no cycle |
| Migration against live RDS         | both files applied inside `BEGIN … ROLLBACK`, then rolled back                                        |
| `orders_exactly_one_subject_check` | refused an order with neither subject, and one with both                                              |
| `orders_one_paid_per_subscription` | refused a second paid order; **still allowed an unpaid reissue**                                      |
| a legitimate subscription order    | accepted                                                                                              |

13 new tests: 7 on the port adapter's refusals, 6 on the orders path — the
amount coming from the subscription rather than the caller, the order belonging
to no booking, activation on capture, and the money still being booked when
activation fails.

### What is still deferred

**A refund of a part-used plan.** `RefundsService.initiate` is entered by
`bookingId` and always will be, so a subscription refund has no route. That is
deliberate and consistent with §5: what a part-used plan is worth back is an
ops judgement, not a formula. The plumbing underneath it is now ready — a
subscription order settles, books to the ledger and skips the booking write
correctly — so adding the route is a decision about policy, not about code.
