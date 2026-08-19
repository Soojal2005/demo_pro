-- Module 16 · Loyalty — Homingo Coins, subscription plans, referrals, and the
-- discount/reschedule columns module 4 needs to honour them.
--
-- The CHECK constraints below are the point of this file, not decoration. Three
-- of them carry rules the service layer also enforces, repeated here for the
-- reason the rest of this schema repeats them: a future code path that has not
-- been written yet must not be able to write a booking whose parts do not add
-- up, or a wallet row that credits coins nobody can account for.

-- ---------------------------------------------------------------------
-- Booking — what the customer actually pays
-- ---------------------------------------------------------------------
--
-- Three-step add for "payableAmount": nullable, backfill, then NOT NULL. Every
-- booking predating this migration was charged its full flat price, which is
-- exactly what the backfill says.

ALTER TABLE "bookings"
  ADD COLUMN "coinsRedeemed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "walletDiscountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "subscriptionDiscountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "discountAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "payableAmount" DECIMAL(12,2),
  ADD COLUMN "subscriptionId" UUID,
  ADD COLUMN "rescheduleCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "originalSlotStartAt" TIMESTAMP(3);

UPDATE "bookings" SET "payableAmount" = "flatPrice" WHERE "payableAmount" IS NULL;

ALTER TABLE "bookings" ALTER COLUMN "payableAmount" SET NOT NULL;

-- The arithmetic, enforced. A booking whose discount does not equal its parts,
-- or whose payable does not equal price less discount, is money that has gone
-- somewhere nobody can name.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_discount_parts_check" CHECK (
    "discountAmount" = "walletDiscountAmount" + "subscriptionDiscountAmount"
  ),
  ADD CONSTRAINT "bookings_payable_check" CHECK (
    "payableAmount" = "flatPrice" - "discountAmount"
  ),
  -- A discount may take a booking to zero. It may never take it below.
  ADD CONSTRAINT "bookings_payable_non_negative_check" CHECK ("payableAmount" >= 0),
  ADD CONSTRAINT "bookings_discount_non_negative_check" CHECK (
    "walletDiscountAmount" >= 0 AND "subscriptionDiscountAmount" >= 0
  ),
  -- Coins and their rupee value move together or not at all: a redemption
  -- worth nothing, or a value with no coins behind it, is a bug either way.
  ADD CONSTRAINT "bookings_coins_match_value_check" CHECK (
    ("coinsRedeemed" = 0 AND "walletDiscountAmount" = 0)
    OR ("coinsRedeemed" > 0 AND "walletDiscountAmount" > 0)
  ),
  ADD CONSTRAINT "bookings_reschedule_count_check" CHECK ("rescheduleCount" >= 0);

-- ---------------------------------------------------------------------
-- Wallet
-- ---------------------------------------------------------------------

CREATE TABLE "customer_wallets" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "customerId" UUID NOT NULL,
  "balanceCoins" INTEGER NOT NULL DEFAULT 0,
  "lifetimeEarnedCoins" INTEGER NOT NULL DEFAULT 0,
  "lifetimeRedeemedCoins" INTEGER NOT NULL DEFAULT 0,
  "lifetimeExpiredCoins" INTEGER NOT NULL DEFAULT 0,
  "tier" TEXT NOT NULL DEFAULT 'bronze',
  CONSTRAINT "customer_wallets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_wallets_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE,
  -- A negative balance is an overdraft, and coins are not credit.
  CONSTRAINT "customer_wallets_balance_non_negative_check" CHECK ("balanceCoins" >= 0),
  CONSTRAINT "customer_wallets_lifetime_non_negative_check" CHECK (
    "lifetimeEarnedCoins" >= 0
    AND "lifetimeRedeemedCoins" >= 0
    AND "lifetimeExpiredCoins" >= 0
  ),
  CONSTRAINT "customer_wallets_tier_check" CHECK ("tier" IN ('bronze', 'silver', 'gold', 'platinum'))
);
CREATE UNIQUE INDEX "customer_wallets_customerId_key" ON "customer_wallets"("customerId");

CREATE TABLE "wallet_transactions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "walletId" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "type" TEXT NOT NULL,
  "coins" INTEGER NOT NULL,
  "balanceAfter" INTEGER NOT NULL,
  "rupeeValue" DECIMAL(12,2) NOT NULL,
  "bookingId" UUID,
  "referralId" UUID,
  "subscriptionId" UUID,
  "adjustedByAdminId" UUID,
  "reason" TEXT NOT NULL,
  "sourceRef" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "expiredAt" TIMESTAMP(3),
  CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "wallet_transactions_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "customer_wallets"("id") ON DELETE CASCADE,
  CONSTRAINT "wallet_transactions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "wallet_transactions_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE SET NULL,
  CONSTRAINT "wallet_transactions_adjustedByAdminId_fkey" FOREIGN KEY ("adjustedByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL,
  CONSTRAINT "wallet_transactions_type_check" CHECK ("type" IN (
    'earn', 'redeem', 'redeem_reversal', 'referral', 'signup_bonus',
    'subscription_bonus', 'expire', 'adjustment'
  )),
  -- A movement of nothing is not a movement. Zero rows would make
  -- `balanceAfter` ambiguous when two land in the same millisecond.
  CONSTRAINT "wallet_transactions_coins_non_zero_check" CHECK ("coins" <> 0),
  CONSTRAINT "wallet_transactions_balance_after_non_negative_check" CHECK ("balanceAfter" >= 0),
  CONSTRAINT "wallet_transactions_rupee_value_non_negative_check" CHECK ("rupeeValue" >= 0),
  -- Direction is not free-form: an 'earn' that debits, or a 'redeem' that
  -- credits, is the kind of sign error that quietly mints currency.
  CONSTRAINT "wallet_transactions_direction_check" CHECK (
    ("type" IN ('earn', 'referral', 'signup_bonus', 'subscription_bonus', 'redeem_reversal') AND "coins" > 0)
    OR ("type" IN ('redeem', 'expire') AND "coins" < 0)
    OR "type" = 'adjustment'
  ),
  -- Only an admin adjusts a balance by hand, and every adjustment carries the
  -- name of whoever did it.
  CONSTRAINT "wallet_transactions_adjustment_attributed_check" CHECK (
    "type" <> 'adjustment' OR "adjustedByAdminId" IS NOT NULL
  ),
  -- Only a credit can expire, and only a credit can be dated to.
  CONSTRAINT "wallet_transactions_expiry_on_credit_check" CHECK (
    "expiresAt" IS NULL OR "coins" > 0
  )
);
CREATE UNIQUE INDEX "wallet_transactions_sourceRef_key" ON "wallet_transactions"("sourceRef");
CREATE INDEX "wallet_transactions_customerId_createdAt_idx" ON "wallet_transactions"("customerId", "createdAt");
CREATE INDEX "wallet_transactions_walletId_createdAt_idx" ON "wallet_transactions"("walletId", "createdAt");
CREATE INDEX "wallet_transactions_bookingId_idx" ON "wallet_transactions"("bookingId");
CREATE INDEX "wallet_transactions_expiresAt_expiredAt_idx" ON "wallet_transactions"("expiresAt", "expiredAt");

-- ---------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------

CREATE TABLE "subscription_plans" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "tier" TEXT NOT NULL,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "priceAmount" DECIMAL(12,2) NOT NULL,
  "durationDays" INTEGER NOT NULL,
  "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "maxDiscountAmount" DECIMAL(12,2),
  "coinEarnMultiplier" DECIMAL(5,2) NOT NULL DEFAULT 1,
  "bonusCoins" INTEGER NOT NULL DEFAULT 0,
  "waivesCancellationFee" BOOLEAN NOT NULL DEFAULT false,
  "extraReschedules" INTEGER NOT NULL DEFAULT 0,
  "priorityDispatch" BOOLEAN NOT NULL DEFAULT false,
  "includedBookings" INTEGER,
  "cityId" UUID,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subscription_plans_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE RESTRICT,
  CONSTRAINT "subscription_plans_tier_check" CHECK ("tier" IN ('silver', 'gold', 'platinum')),
  CONSTRAINT "subscription_plans_duration_check" CHECK ("durationDays" > 0),
  CONSTRAINT "subscription_plans_price_check" CHECK ("priceAmount" >= 0),
  -- 100% off is a giveaway, not a plan. Anything above it is arithmetic that
  -- pays the customer to book.
  CONSTRAINT "subscription_plans_discount_percent_check" CHECK (
    "discountPercent" >= 0 AND "discountPercent" <= 100
  ),
  CONSTRAINT "subscription_plans_multiplier_check" CHECK ("coinEarnMultiplier" >= 0),
  CONSTRAINT "subscription_plans_bonus_coins_check" CHECK ("bonusCoins" >= 0),
  CONSTRAINT "subscription_plans_extra_reschedules_check" CHECK ("extraReschedules" >= 0),
  CONSTRAINT "subscription_plans_included_bookings_check" CHECK (
    "includedBookings" IS NULL OR "includedBookings" > 0
  )
);
CREATE UNIQUE INDEX "subscription_plans_code_key" ON "subscription_plans"("code");
CREATE INDEX "subscription_plans_isActive_sortOrder_idx" ON "subscription_plans"("isActive", "sortOrder");
CREATE INDEX "subscription_plans_cityId_isActive_idx" ON "subscription_plans"("cityId", "isActive");

CREATE TABLE "customer_subscriptions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "customerId" UUID NOT NULL,
  "planId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending_payment',
  "pricePaid" DECIMAL(12,2) NOT NULL,
  "paymentMode" TEXT NOT NULL DEFAULT 'online',
  "paymentReference" TEXT,
  "activatedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "discountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
  "maxDiscountAmount" DECIMAL(12,2),
  "coinEarnMultiplier" DECIMAL(5,2) NOT NULL DEFAULT 1,
  "waivesCancellationFee" BOOLEAN NOT NULL DEFAULT false,
  "extraReschedules" INTEGER NOT NULL DEFAULT 0,
  "includedBookings" INTEGER,
  "bookingsUsed" INTEGER NOT NULL DEFAULT 0,
  "autoRenew" BOOLEAN NOT NULL DEFAULT false,
  "cancelledAt" TIMESTAMP(3),
  "cancelReason" TEXT,
  "cancelledByAdminId" UUID,
  CONSTRAINT "customer_subscriptions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "customer_subscriptions_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "customer_subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT,
  CONSTRAINT "customer_subscriptions_cancelledByAdminId_fkey" FOREIGN KEY ("cancelledByAdminId") REFERENCES "admin_users"("id") ON DELETE SET NULL,
  CONSTRAINT "customer_subscriptions_status_check" CHECK (
    "status" IN ('pending_payment', 'active', 'expired', 'cancelled')
  ),
  CONSTRAINT "customer_subscriptions_payment_mode_check" CHECK (
    "paymentMode" IN ('online', 'cash', 'complimentary')
  ),
  -- An active subscription claims a window. That claim carries both ends or it
  -- is not made — a null expiry on an active row is a plan that never lapses.
  CONSTRAINT "customer_subscriptions_active_window_check" CHECK (
    "status" = 'pending_payment'
    OR ("activatedAt" IS NOT NULL AND "expiresAt" IS NOT NULL)
  ),
  CONSTRAINT "customer_subscriptions_window_ordered_check" CHECK (
    "activatedAt" IS NULL OR "expiresAt" IS NULL OR "expiresAt" > "activatedAt"
  ),
  CONSTRAINT "customer_subscriptions_cancelled_complete_check" CHECK (
    "status" <> 'cancelled' OR "cancelledAt" IS NOT NULL
  ),
  CONSTRAINT "customer_subscriptions_discount_percent_check" CHECK (
    "discountPercent" >= 0 AND "discountPercent" <= 100
  ),
  CONSTRAINT "customer_subscriptions_bookings_used_check" CHECK ("bookingsUsed" >= 0)
);
CREATE INDEX "customer_subscriptions_customerId_status_idx" ON "customer_subscriptions"("customerId", "status");
CREATE INDEX "customer_subscriptions_status_expiresAt_idx" ON "customer_subscriptions"("status", "expiresAt");
CREATE INDEX "customer_subscriptions_planId_status_idx" ON "customer_subscriptions"("planId", "status");

-- One live subscription per customer, enforced by the database rather than by
-- a read-then-write in the service. A partial unique index is the only version
-- of this guarantee that survives two concurrent purchases — the same
-- technique `customer_addresses` uses for its single default.
CREATE UNIQUE INDEX "customer_subscriptions_one_active_per_customer"
  ON "customer_subscriptions"("customerId")
  WHERE "status" = 'active';

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "customer_subscriptions"("id") ON DELETE SET NULL;
CREATE INDEX "bookings_subscriptionId_idx" ON "bookings"("subscriptionId");

ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_subscriptionId_fkey"
  FOREIGN KEY ("subscriptionId") REFERENCES "customer_subscriptions"("id") ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Referrals
-- ---------------------------------------------------------------------

CREATE TABLE "referral_codes" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "customerId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "totalReferrals" INTEGER NOT NULL DEFAULT 0,
  "qualifiedCount" INTEGER NOT NULL DEFAULT 0,
  "totalCoinsEarned" INTEGER NOT NULL DEFAULT 0,
  "isBlocked" BOOLEAN NOT NULL DEFAULT false,
  "blockedReason" TEXT,
  CONSTRAINT "referral_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referral_codes_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE,
  -- Upper-case and unambiguous. The alphabet is enforced here as well as in
  -- the generator, because a code is read aloud and typed by a stranger.
  CONSTRAINT "referral_codes_code_format_check" CHECK ("code" ~ '^[A-Z0-9]{6,12}$'),
  CONSTRAINT "referral_codes_counters_check" CHECK (
    "totalReferrals" >= 0 AND "qualifiedCount" >= 0 AND "totalCoinsEarned" >= 0
  )
);
CREATE UNIQUE INDEX "referral_codes_customerId_key" ON "referral_codes"("customerId");
CREATE UNIQUE INDEX "referral_codes_code_key" ON "referral_codes"("code");

CREATE TABLE "referrals" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "referrerId" UUID NOT NULL,
  "refereeId" UUID NOT NULL,
  "code" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "qualifyingBookingId" UUID,
  "referrerCoins" INTEGER NOT NULL DEFAULT 0,
  "refereeCoins" INTEGER NOT NULL DEFAULT 0,
  "qualifiedAt" TIMESTAMP(3),
  "rewardedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "rejectedReason" TEXT,
  CONSTRAINT "referrals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "referrals_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "referrals_refereeId_fkey" FOREIGN KEY ("refereeId") REFERENCES "customers"("id") ON DELETE CASCADE,
  CONSTRAINT "referrals_qualifyingBookingId_fkey" FOREIGN KEY ("qualifyingBookingId") REFERENCES "bookings"("id") ON DELETE SET NULL,
  CONSTRAINT "referrals_status_check" CHECK (
    "status" IN ('pending', 'qualified', 'rewarded', 'expired', 'rejected')
  ),
  -- Referring yourself is the cheapest attack there is, and the only one the
  -- database can refuse outright.
  CONSTRAINT "referrals_no_self_referral_check" CHECK ("referrerId" <> "refereeId"),
  -- A reward that was paid names the job that earned it. Without this, a
  -- 'rewarded' row is a coin grant with no evidence behind it.
  CONSTRAINT "referrals_rewarded_complete_check" CHECK (
    "status" <> 'rewarded'
    OR ("rewardedAt" IS NOT NULL AND "qualifyingBookingId" IS NOT NULL)
  ),
  CONSTRAINT "referrals_qualified_complete_check" CHECK (
    "status" NOT IN ('qualified', 'rewarded')
    OR ("qualifiedAt" IS NOT NULL AND "qualifyingBookingId" IS NOT NULL)
  ),
  CONSTRAINT "referrals_rejected_complete_check" CHECK (
    "status" <> 'rejected' OR "rejectedReason" IS NOT NULL
  ),
  CONSTRAINT "referrals_coins_non_negative_check" CHECK (
    "referrerCoins" >= 0 AND "refereeCoins" >= 0
  )
);
-- Referred exactly once, ever. This constraint is the whole anti-farming
-- story: without it, the same person re-signing up is an income stream.
CREATE UNIQUE INDEX "referrals_refereeId_key" ON "referrals"("refereeId");
-- One completed job can never pay two referral rewards.
CREATE UNIQUE INDEX "referrals_qualifyingBookingId_key" ON "referrals"("qualifyingBookingId");
CREATE INDEX "referrals_referrerId_status_idx" ON "referrals"("referrerId", "status");
CREATE INDEX "referrals_status_expiresAt_idx" ON "referrals"("status", "expiresAt");

ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_referralId_fkey"
  FOREIGN KEY ("referralId") REFERENCES "referrals"("id") ON DELETE SET NULL;

-- ---------------------------------------------------------------------
-- Reschedules
-- ---------------------------------------------------------------------

CREATE TABLE "booking_reschedules" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "bookingId" UUID NOT NULL,
  "fromSlotStartAt" TIMESTAMP(3) NOT NULL,
  "toSlotStartAt" TIMESTAMP(3) NOT NULL,
  "toSlotEndAt" TIMESTAMP(3) NOT NULL,
  "hoursBeforeSlot" DECIMAL(8,2) NOT NULL,
  "requestedByType" TEXT NOT NULL,
  "requestedById" TEXT,
  "reason" TEXT,
  "feeAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  CONSTRAINT "booking_reschedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "booking_reschedules_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "bookings"("id") ON DELETE CASCADE,
  -- A Pro can no more move a job than cancel one — principle 2 of the
  -- cancellation flow, applied to the other half of the same decision.
  CONSTRAINT "booking_reschedules_requested_by_check" CHECK (
    "requestedByType" IN ('customer', 'ops')
  ),
  CONSTRAINT "booking_reschedules_slot_ordered_check" CHECK ("toSlotEndAt" > "toSlotStartAt"),
  CONSTRAINT "booking_reschedules_moved_check" CHECK ("toSlotStartAt" <> "fromSlotStartAt"),
  CONSTRAINT "booking_reschedules_fee_non_negative_check" CHECK ("feeAmount" >= 0)
);
CREATE INDEX "booking_reschedules_bookingId_createdAt_idx" ON "booking_reschedules"("bookingId", "createdAt");

-- ---------------------------------------------------------------------
-- Settings — no magic numbers, per the cross-cutting rule
-- ---------------------------------------------------------------------
--
-- Seeded here rather than in seed.ts because module 4's cancellation path
-- reads them on a request a customer is waiting on: a missing row falls back
-- to the code default silently, and the ops team would have no row to edit.

INSERT INTO "platform_settings" ("id", "createdAt", "updatedAt", "key", "cityId", "value", "description") VALUES
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'wallet.coinValueRupees', NULL, '1.00', 'Rupee value of one Homingo Coin at redemption.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'wallet.maxRedemptionPercent', NULL, '20', 'Ceiling on how much of a booking coins may pay for.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'wallet.coinExpiryDays', NULL, '365', 'Days a credit stays spendable. 0 disables expiry.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'wallet.earnRatePercent.bronze', NULL, '3', 'Percent of payable value returned as coins, 0-4 completed jobs.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'wallet.earnRatePercent.silver', NULL, '5', 'Percent of payable value returned as coins, 5-14 completed jobs.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'wallet.earnRatePercent.gold', NULL, '7', 'Percent of payable value returned as coins, 15-39 completed jobs.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'wallet.earnRatePercent.platinum', NULL, '10', 'Percent of payable value returned as coins, 40+ completed jobs.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'wallet.tierThreshold.silver', NULL, '5', 'Completed bookings required to reach silver.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'wallet.tierThreshold.gold', NULL, '15', 'Completed bookings required to reach gold.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'wallet.tierThreshold.platinum', NULL, '40', 'Completed bookings required to reach platinum.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'referral.referrerCoins', NULL, '200', 'Coins to the referrer when a referral qualifies.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'referral.refereeCoins', NULL, '100', 'Coins to the new customer when their referral qualifies.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'referral.qualifyWindowDays', NULL, '60', 'Days a pending referral has to complete its first job.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'referral.maxPerReferrer', NULL, '50', 'Lifetime cap on rewarded referrals for one account.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'booking.freeCancellationHours', NULL, '6', 'Hours before the slot inside which a cancellation stops being free.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'booking.lateCancellationFeePercent', NULL, '25', 'Percent of the payable amount retained on a late cancellation.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'booking.freeRescheduleHours', NULL, '6', 'Hours before the slot inside which a reschedule is refused.'),
  (gen_random_uuid(), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'booking.maxReschedules', NULL, '2', 'Free slot moves per booking, before any subscription bonus.')
ON CONFLICT ("key", "cityId") DO NOTHING;
