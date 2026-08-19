# Module 16 · Loyalty — Homingo Coins, subscriptions, referrals, and a cancellation policy with a clock in it

> PR body for `soojal-1` → `main`. Written to be pasted into the GitHub PR
> description; kept in the repo so the reasoning survives the merge.

## What this is

Four features that were asked for separately and turn out to be one, joined by
a column that did not exist: **`Booking.payableAmount`**.

`flatPrice` was both the list price _and_ the amount charged. A coin
redemption, a plan discount and a cancellation refund all need the same new
number, and building them apart would have given each its own idea of what a
booking costs — the first cancellation of a discounted booking would have
refunded the list price and given money away.

```
flatPrice                       ₹500   the catalogue price (unchanged, still frozen)
  − subscriptionDiscountAmount  ₹50    10% off, Homingo Gold
  − walletDiscountAmount        ₹100   100 coins spent
  = payableAmount               ₹350   ← what the gateway charges, what a Pro
                                         collects, what a refund returns, and
                                         what coins are earned on
```

## The rule the module is built around

> **Nothing pays out for an intention. Everything pays out for a completed job.**

Coins are earned on completion, not on booking. A referral rewards when the
referee's first job _finishes_, not when they sign up. A subscription is worth
nothing until its payment is confirmed.

Each is the cheapest defence against the same attack: a signup, a booking and a
checkout intent all cost an attacker nothing, while a completed job costs them a
real payment at a real address a real Pro visited.

---

## The four features

### 1 · Homingo Coins

Earn rate rises with jobs completed — the literal ask, "discount on the basis of
how much services they've booked":

| Completed jobs | Tier     | Earn rate |
| -------------- | -------- | --------- |
| 0–4            | bronze   | 3%        |
| 5–14           | silver   | 5%        |
| 15–39          | gold     | 7%        |
| 40+            | platinum | 10%       |

Three details that are easy to get wrong and are tested:

- **The completing job counts.** A customer's 5th booking earns at the silver
  rate, not bronze. Rewarding the 5th at the 4th's rate is the off-by-one that
  generates support tickets.
- **Earned on `payableAmount`, not `flatPrice`.** Otherwise a large balance
  recycles itself upward every booking — a loop that pays itself.
- **Redemption is clamped, never rejected.** Asking to spend more than you hold
  spends what you have; refusing would make the coin slider an error state
  instead of a control.

Expiry runs **credit by credit**, not by balance, and writes a debit naming the
grant that lapsed — so the statement explains a falling balance instead of
showing one that dropped for no visible reason.

### 2 · Subscription plans

| Plan     | Price  | Cycle    | Off | Coins | Waives fee | Extra reschedules |
| -------- | ------ | -------- | --- | ----- | ---------- | ----------------- |
| Silver   | ₹299   | 90 days  | 5%  | 1.5×  | no         | 1                 |
| Gold     | ₹699   | 180 days | 10% | 2×    | yes        | 2                 |
| Platinum | ₹1,499 | 365 days | 15% | 3×    | yes        | 4                 |

Every perk is **copied onto the customer's row at purchase**. Repricing a plan
changes what new buyers get and nothing else — same principle as freezing a
booking's price.

Purchase is two steps on purpose: `pending_payment` entitles nothing, and the
plan activates when money actually arrives. Online checkout goes through the
same Razorpay flow a booking uses.

### 3 · Refer & Earn

```
friend enters code       → pending, nothing credited
friend's FIRST job done  → referrer +200 coins, referee +100
60 days, no booking      → expired
```

**Every refusal happens at attribution**, never at reward time — unknown code,
own code, blocked or capped code, an account that already completed a booking,
an account already referred. Telling someone their code was invalid _after_ they
completed a booking expecting coins is a support ticket; telling them as they
type it is a form error.

Codes are 6 characters with no `0`/`O` and no `1`/`I`/`L`, generated with
`crypto.randomInt` — this code is read aloud across a kitchen table.

### 4 · Cancellation and reschedule

The six status windows (A–F) are **unchanged** and keep deciding refund
mechanics, assignment teardown and whether ops must be involved. A second axis —
**hours until the slot** — now decides the fee, because `assigned` for a slot
three days out and `assigned` for a slot in forty minutes are the same window and
not remotely the same decision.

- More than **6 hours** before the slot → **free, whatever the window, including
  window D**. A Pro marked en route six hours early has not lost the afternoon.
- Inside it → 25% of `payableAmount` retained. A percentage, not a flat fee.
- Pro at the door inside the window → whichever is greater, the percentage or
  the flat travel fee.
- Ops/system cancellation, or a plan that waives fees → free.
- A fee **never exceeds what the customer owes**. Cancelling must not become a
  debt.

**Coins come back regardless of the fee.** The fee is money and the coins are an
entitlement; keeping both charges the customer twice for one cancellation.

`GET /bookings/:id/cancellation-policy` renders the confirm screen from **the
same function that executes the cancellation**, so it cannot quote one number and
charge another. It returns `freeUntil` — the instant after which it stops being
free.

Rescheduling is **refused rather than charged** inside the cutoff: at that point
the move is the same disruption as a cancellation, with the platform still owing
a new slot. Ops bypasses the _allowance_ but not the _cutoff_.

---

## Schema

Nine new tables, eight new `Booking` columns, fifteen CHECK constraints and three
partial/unique indexes. The constraints carry rules that must hold even if future
code forgets them:

| Constraint                                       | Refuses                                             |
| ------------------------------------------------ | --------------------------------------------------- |
| `bookings_payable_check`                         | a payable that is not price less discount           |
| `wallet_transactions_direction_check`            | an `earn` that debits — the sign error that mints   |
| `customer_wallets_balance_non_negative_check`    | an overdraft; coins are not credit                  |
| `customer_subscriptions_one_active_per_customer` | two live plans, **including under concurrency**     |
| `referrals_refereeId_key`                        | being referred twice, ever                          |
| `referrals_qualifyingBookingId_key`              | one job paying two referral rewards                 |
| `orders_exactly_one_subject_check`               | an order belonging to neither subject, or to both   |
| `orders_one_paid_per_subscription`               | a second paid order — a double charge for one cycle |

### `Order` became polymorphic

It stopped meaning "the gateway side of a booking" and now means **"the gateway
side of one thing the customer is buying"** — a booking or a subscription.
`bookingId` is nullable, `subscriptionId` sits beside it, and a CHECK requires
exactly one.

A parallel `SubscriptionOrder` table was rejected: it would have duplicated every
column, both webhook paths, the refund state machine, reconciliation and the
ledger call. A fake booking behind each plan was rejected too — it would have
polluted booking counts, dispatch queues and every analytics figure with work
nobody did.

Making the column nullable **broke six call sites** that assumed a booking, which
is the argument _for_ the change rather than against it. Each is now explicit.

---

## Three decisions worth arguing with

Full write-ups in `CONFLICTS_AND_DECISIONS.md` #67–#75.

1. **Commission stays on `flatPrice` (#71).** The Pro did the same work whether
   or not marketing discounted the job. **Consequence: the platform's margin
   absorbs the entire discount**, and on a deep enough discount a booking can pay
   out more commission than it took in. That is a constraint on how aggressively
   plans are priced, and it is why the plan discount is capped at 100%.
2. **Coins are not in the ledger (#68).** They are a discount entitlement, not
   currency; nothing external settles against them, and hash-chaining them would
   put entries in the chain no external record can reconcile. Reopen this if
   coins ever become refundable.
3. **Window D no longer always charges (#69).** The scope document implies it
   does. A Pro marked en route six hours early has lost nothing, and the clock is
   the better authority.

---

## How it attaches

Two ports, each **owned by the module being depended on**, so no dependency
inverts:

```
BookingsModule ◄── LOYALTY_PORT ──────── LoyaltyModule
PaymentsModule ◄── SUBSCRIPTION_PORT ─── LoyaltyModule
```

Both are bound to no-ops. **A deployment without module 16 prices every booking
at its flat price, earns nothing, and cancels under the plain policy** — exactly
how the platform behaved before. That is what makes the module removable.

---

## Verification

| Check                        | Result                                                                     |
| ---------------------------- | -------------------------------------------------------------------------- |
| `npm run typecheck` / `lint` | clean (`--max-warnings=0`)                                                 |
| `npx jest`                   | **1,255 / 1,255** across 100 suites (was 1,085 / 1,085 across 93)          |
| `npm run test:e2e`           | **181 / 181** across 8 suites                                              |
| `module-graph.e2e-spec.ts`   | the real `AppModule` graph resolves — proves no port cycle                 |
| `http-routes.e2e-spec.ts`    | Fastify registers every route, no collision                                |
| Route probe on a booted app  | all 34 new routes registered                                               |
| Migrations against live RDS  | applied inside `BEGIN … ROLLBACK`; **11 constraints probed, all enforced** |

170 new tests: 27 on the pure arithmetic, 26 on the wallet, 22 on referrals, 19
on subscriptions, 35 on the cancellation and reschedule policy, 15 on the
reschedule service, 13 on online plan checkout, and 13 added to the existing
cancellation suite.

---

## This branch is already merged with `main`

`main` moved 10 commits ahead while this was being built — the admin dashboard,
the end-to-end booking-flow fixes, the customer and Pro booking view layers, and
two migrations that had until then existed only on the shared database.
`origin/main` was merged in, so this branch is **0 behind**.

**Reviewers: the interesting part of that merge is not the conflict.** Git found
exactly one, a duplicate import. The work was in the six files it merged
_cleanly and wrongly_.

`flatPrice` and `payableAmount` were the same number until this module, and are
not any more. Main's new code was written before that distinction existed and
reads `flatPrice` in places that mean "money". Each of these compiled, passed
every existing test, and was wrong:

| File                         | What it would have shipped                                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `customer-booking.view.ts`   | ₹500 on the card for a booking the customer paid ₹350 for                                                         |
| `pro-booking.view.ts`        | A comment telling the Pro app `flatPrice` is "the exact sum to collect" — a Pro demanding ₹500 where ₹350 is owed |
| `admin-analytics.service.ts` | Commission subtracted from `flatPrice`, overstating the platform margin on every discounted booking               |
| booking CSV export           | One column named `amount` holding the pre-discount price                                                          |
| `BookingDto`                 | Support unable to see what a discounted booking actually charged                                                  |

Three regression tests were added for these, because **the entire existing suite
was blind to all of them**.

### Where this PR changes code owned by someone else

The corrections above touch files from `main`. Two calls worth reviewing
explicitly rather than skimming:

- **GMV deliberately stays gross** (`flatPrice`). It is the catalogue value of
  what was sold, and keeping it comparable across months is the point of the
  acronym. `discountGiven` and `netRevenue` were added as the bridge, so the gap
  between GMV and platform revenue is a reported figure rather than something
  finance has to chase.
- **The commission report's `grossPrice` was left on `flatPrice`**, because
  commission _is_ computed against the list price (decision #71) and that column
  sits beside `proAmount`. `chargedAmount` was added next to it so the real take
  is not left to be inferred.

Where the two sides disagreed on style rather than correctness, **main won**: the
reschedule route now returns `CustomerBookingDetailDto` and re-reads through
`viewOf`, matching every other customer route.

### A side effect worth knowing

Main brought `start_otp_minted_in_house` and `admin_firebase_identity_required`
into git, which **cuts the untracked drift on the shared database from three
migrations to one**. Only `20260819120000_pro_job_notes_and_aadhaar_back` is
still on RDS and in no branch.

---

## Applied and verified against the real database

Both migrations are **applied** to the shared RDS instance, and the schema was
checked afterwards rather than assumed:

```
tables created:            7/7
booking columns:           5/5
backfill:                  16/16 rows, 0 nulls, 0 inconsistent
loyalty settings seeded:   18/18
orders.bookingId nullable: YES
key constraints live:      4/4
```

The three subscription plans are seeded, so the plans endpoint returns a
catalogue rather than an empty list.

### The live pass — 22/22

Every e2e suite in this repository mocks Prisma. 1,375 green unit tests
therefore prove the logic and prove **nothing** about the schema. So this
branch adds `test/manual/run-loyalty-live.ts`, which writes real rows and
asserts the database refuses the ones it should — the standard the earlier
modules met with their cURL runs.

```
NODE_ENV=local npx tsx test/manual/run-loyalty-live.ts
→ 22 passed, 0 failed        leftover LIVE-CHECK rows: 0
```

It covers the overdraft floor, the sign constraint that stops an `earn` from
debiting, `sourceRef` exactly-once, an unattributed adjustment, all three
booking arithmetic constraints, self-referral and referred-twice,
one-live-plan-per-customer, an order belonging to neither subject or to both,
and a Pro trying to move a job. It also confirms every pre-existing booking
satisfies `payableAmount = flatPrice − discountAmount`.

Every row it writes is marked `LIVE-CHECK` and deleted in the cleanup block,
whether the run passes or throws.

---

## ⚠️ Before merging — three things

### 1 · Razorpay has not been exercised

`createForSubscription` calls the real gateway and has never hit the sandbox.
It reuses module 7's existing `RazorpayClient`, so the transport is proven by
the booking checkout that already ships — but the subscription path itself is
unverified against Razorpay. Worth a sandbox run in staging before real cards
touch it.

### 2 · One migration is still untracked, and no longer warns

`20260819120000_pro_job_notes_and_aadhaar_back` is applied on RDS and exists in
no branch. Merging `main` brought two of the previous three into git, so the
drift is down from three to one.

**The remaining one is now invisible:** `prisma migrate status` reports
"Database schema is up to date!" because Prisma stops listing database-only
migrations once nothing local is pending. `schema.prisma` still does not
describe the database — it simply no longer says so. Whoever owns that
migration should push it.

This branch's own migration was renumbered to `20260819140000` because the
drifted one shared its timestamp, so ordering stays unambiguous.

### 3 · Known gaps, stated rather than discovered

1. **Refunding a part-used plan has no route.** Deliberate, and consistent with
   window-E booking refunds: what a part-used plan is worth back is an ops
   judgement, not a formula. The plumbing beneath it is ready.
2. **`priorityDispatch` is stored and read by nothing.** Shipping the column
   without the behaviour is honest only because this line exists.
3. **No notifications** for expiring coins, lapsing plans or paid referrals.
   Three template rows and an `enqueue` call — deliberately out of this pass
   rather than half-done.
4. **`admin-analytics.service.ts` still sums `flatPrice` for GMV.** Arguably
   right for _gross_ merchandise value and arguably not; left alone rather than
   changed without asking.
5. **Nightly reconciliation does not rebuild wallet balances.** `rebuildBalance`
   exists as an admin route; module 9's counter rebuild does not call it yet.

---

## Not included

`eslint.config.mjs`, `package.json`, `docker-compose.yml` and
`scripts/write-docker-env.mjs` were already modified in the working tree when
this work started — a self-contained docker-setup change belonging to someone
else. They were deliberately left uncommitted.
