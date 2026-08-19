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

## ⚠️ Before merging — two things

### 1 · The migrations have **not** been applied

`prisma migrate status` reports three migrations on the shared RDS instance that
exist in **no branch**:

```
20260815100000_start_otp_minted_in_house
20260817100000_admin_firebase_identity_required
20260819120000_pro_job_notes_and_aadhaar_back
```

That is a coordination event, not something to resolve unilaterally, so
`migrate deploy` was deliberately not run. The two migrations in this PR were
instead executed against the live schema inside a transaction and rolled back,
which proves they apply and that their constraints bite, with zero effect on
data.

The third of those drifted migrations shares a timestamp with this branch's
first one, so ours was renumbered to `20260819140000` to keep ordering
unambiguous.

**To deploy:** `NODE_ENV=local npx prisma migrate deploy` — `NODE_ENV=local`
matters, because `.env.production` has an empty `DATABASE_URL`.

### 2 · Known gaps, stated rather than discovered

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
