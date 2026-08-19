-- Module 16 · online subscription checkout.
--
-- Makes `Order` the gateway side of **one thing the customer is buying**,
-- which is now either a booking or a subscription, rather than of a booking
-- specifically. The alternative was a second `SubscriptionOrder` table
-- duplicating every column, both webhook paths and the reconciliation loop —
-- the mistake CONFLICTS_AND_DECISIONS #1 and #13 record.
--
-- The CHECK below is what makes that safe. Without it, "nullable bookingId"
-- is an invitation to an order that belongs to nothing, and every reader would
-- need its own guard.

ALTER TABLE "orders"
  ALTER COLUMN "bookingId" DROP NOT NULL,
  ADD COLUMN "subscriptionId" UUID;

ALTER TABLE "orders"
  ADD CONSTRAINT "orders_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "customer_subscriptions"("id") ON DELETE RESTRICT,
  -- Exactly one. An order that belongs to neither is money with no purchase
  -- behind it; an order that belongs to both is a payment two things would
  -- each claim as theirs.
  ADD CONSTRAINT "orders_exactly_one_subject_check" CHECK (
    ("bookingId" IS NOT NULL AND "subscriptionId" IS NULL)
    OR ("bookingId" IS NULL AND "subscriptionId" IS NOT NULL)
  );

CREATE INDEX "orders_subscriptionId_createdAt_idx" ON "orders"("subscriptionId", "createdAt");

-- One paid order per subscription, enforced rather than assumed.
--
-- A subscription is bought once. Two paid orders against one would mean the
-- customer was charged twice for the same cycle, and the partial unique index
-- is the only version of that guarantee which survives two checkouts racing.
-- Bookings deliberately do NOT get this: an expired order there is reissued,
-- and the history has to stay readable by receipt.
CREATE UNIQUE INDEX "orders_one_paid_per_subscription"
  ON "orders"("subscriptionId")
  WHERE "subscriptionId" IS NOT NULL AND "status" = 'paid';

-- Subscription income is not booking revenue.
--
-- `revenue:bookings` is gross takings that the Pro's commission comes out of;
-- the dashboard computes the platform's own share as that less
-- `expense:pro_commission`. Folding subscription income into it would inflate
-- that figure by money no Pro ever worked for. It gets its own account, which
-- is a string in the ledger vocabulary and needs no schema change — this
-- comment is here so the reason is findable from the migration history.
