import { fromPaise, toPaise } from '../payments/payments.money';

/**
 * The vocabulary of module 16, and every piece of arithmetic that decides what
 * a customer earns or saves.
 *
 * All of it is pure and integer-only. Coins are whole numbers and money is
 * paise, for the reason `payments.money.ts` already states at length: a
 * discount computed on a float is a customer charged the wrong amount, and
 * unlike a rounding error in a report, this one is on their card.
 */

// ---------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------

/**
 * `WalletTransaction.type`. Mirrored by a CHECK constraint, and by a second
 * one that fixes each type's **sign** — an `earn` that debits is the kind of
 * error that quietly mints currency.
 */
export const WALLET_TXN_TYPES = [
  'earn',
  'redeem',
  'redeem_reversal',
  'referral',
  'signup_bonus',
  'subscription_bonus',
  'expire',
  'adjustment',
] as const;
export type WalletTxnType = (typeof WALLET_TXN_TYPES)[number];

/** Credit types. The database enforces this split; this is its readable half. */
export const CREDIT_TXN_TYPES: WalletTxnType[] = [
  'earn',
  'referral',
  'signup_bonus',
  'subscription_bonus',
  'redeem_reversal',
];

/**
 * The four earn tiers, worst to best. Ordered, and the order matters — the
 * tier a customer is in is the last threshold they have passed.
 */
export const WALLET_TIERS = ['bronze', 'silver', 'gold', 'platinum'] as const;
export type WalletTier = (typeof WALLET_TIERS)[number];

/** `SubscriptionPlan.tier`. Deliberately not the same list as `WalletTier`. */
export const SUBSCRIPTION_TIERS = ['silver', 'gold', 'platinum'] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

export const SUBSCRIPTION_STATUSES = [
  'pending_payment',
  'active',
  'expired',
  'cancelled',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const SUBSCRIPTION_PAYMENT_MODES = [
  'online',
  'cash',
  'complimentary',
] as const;
export type SubscriptionPaymentMode =
  (typeof SUBSCRIPTION_PAYMENT_MODES)[number];

export const REFERRAL_STATUSES = [
  'pending',
  'qualified',
  'rewarded',
  'expired',
  'rejected',
] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/**
 * Exactly-once keys, built the same way and for the same reason as
 * `sourceRef` in module 9: `WalletTransaction.sourceRef` is unique, so these
 * functions **are** the guarantee that a retried completion, a re-run sweeper
 * or a double-tapped button credits once. Every one is derived from the id of
 * the thing that happened, never from a timestamp or a counter.
 */
export const walletSourceRef = {
  earn: (bookingId: string) => `earn:${bookingId}`,
  redeem: (bookingId: string) => `redeem:${bookingId}`,
  redeemReversal: (bookingId: string) => `redeem-reversal:${bookingId}`,
  referrerReward: (referralId: string) => `referral:${referralId}:referrer`,
  refereeReward: (referralId: string) => `referral:${referralId}:referee`,
  subscriptionBonus: (subscriptionId: string) =>
    `subscription-bonus:${subscriptionId}`,
  /**
   * Keyed by the credit being consumed, not by the sweep run: one credit
   * expires exactly once however many times the sweep passes over it.
   */
  expiry: (creditTransactionId: string) => `expire:${creditTransactionId}`,
  /**
   * The one key not derived from a domain event, because an adjustment *is*
   * the event. The caller supplies a unique id per adjustment.
   */
  adjustment: (adjustmentId: string) => `adjustment:${adjustmentId}`,
} as const;

/** Every `PlatformSetting` key this module reads, with its code fallback. */
export const LOYALTY_SETTINGS = {
  coinValueRupees: { key: 'wallet.coinValueRupees', fallback: 1 },
  maxRedemptionPercent: { key: 'wallet.maxRedemptionPercent', fallback: 20 },
  coinExpiryDays: { key: 'wallet.coinExpiryDays', fallback: 365 },
  referrerCoins: { key: 'referral.referrerCoins', fallback: 200 },
  refereeCoins: { key: 'referral.refereeCoins', fallback: 100 },
  qualifyWindowDays: { key: 'referral.qualifyWindowDays', fallback: 60 },
  maxPerReferrer: { key: 'referral.maxPerReferrer', fallback: 50 },
} as const;

/** Per-tier earn rate and the completed-job count that unlocks the tier. */
export const TIER_SETTINGS: Record<
  WalletTier,
  {
    rateKey: string;
    rateFallback: number;
    thresholdKey: string | null;
    thresholdFallback: number;
  }
> = {
  bronze: {
    rateKey: 'wallet.earnRatePercent.bronze',
    rateFallback: 3,
    thresholdKey: null,
    thresholdFallback: 0,
  },
  silver: {
    rateKey: 'wallet.earnRatePercent.silver',
    rateFallback: 5,
    thresholdKey: 'wallet.tierThreshold.silver',
    thresholdFallback: 5,
  },
  gold: {
    rateKey: 'wallet.earnRatePercent.gold',
    rateFallback: 7,
    thresholdKey: 'wallet.tierThreshold.gold',
    thresholdFallback: 15,
  },
  platinum: {
    rateKey: 'wallet.earnRatePercent.platinum',
    rateFallback: 10,
    thresholdKey: 'wallet.tierThreshold.platinum',
    thresholdFallback: 40,
  },
};

// ---------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------

/**
 * Which tier a customer has reached, from the number of jobs they have
 * actually had done.
 *
 * **Completed bookings, not money spent.** The user-facing promise is "the
 * more services you book, the more you earn back", and counting jobs keeps
 * that promise legible: a customer can see why they moved up. Counting spend
 * would tier by wallet size instead of by loyalty, and a household booking one
 * expensive job a year would outrank a weekly regular.
 */
export function tierForCompletedBookings(
  completedBookings: number,
  thresholds: Record<Exclude<WalletTier, 'bronze'>, number>,
): WalletTier {
  if (completedBookings >= thresholds.platinum) return 'platinum';
  if (completedBookings >= thresholds.gold) return 'gold';
  if (completedBookings >= thresholds.silver) return 'silver';
  return 'bronze';
}

/**
 * Coins earned by one completed booking.
 *
 * Earned on **`payableAmount`, not `flatPrice`** — a customer who paid ₹400
 * of a ₹500 job with coins earns on the ₹400. Earning on the list price would
 * let a subscriber with a large balance recycle the same coins upward every
 * booking, which is a loop that pays itself.
 *
 * `multiplier` is the active subscription's `coinEarnMultiplier`, 1 when there
 * is none. Rounds **down**: the platform never grants a fraction of a coin it
 * did not intend to.
 */
export function coinsEarnedFor(input: {
  payableAmount: string;
  earnRatePercent: number;
  multiplier: number;
  coinValueRupees: number;
}): number {
  const payablePaise = toPaise(input.payableAmount);
  const coinValuePaise = Math.round(input.coinValueRupees * 100);

  if (
    payablePaise <= 0 ||
    input.earnRatePercent <= 0 ||
    input.multiplier <= 0 ||
    coinValuePaise <= 0
  ) {
    return 0;
  }

  // Value returned to the customer, in paise, before converting to coins.
  const rewardPaise =
    (payablePaise * input.earnRatePercent * input.multiplier) / 100;

  return Math.floor(rewardPaise / coinValuePaise);
}

/** What a whole number of coins is worth, as a rupee string. */
export function coinsToRupees(coins: number, coinValueRupees: number): string {
  const coinValuePaise = Math.round(coinValueRupees * 100);
  return fromPaise(Math.max(0, coins) * coinValuePaise);
}

export interface DiscountInput {
  /** The service's frozen list price. */
  flatPrice: string;
  /** How many coins the customer asked to spend. */
  coinsRequested: number;
  /** What they actually hold. */
  coinBalance: number;
  coinValueRupees: number;
  /** Ceiling on the share of a booking coins may pay for. */
  maxRedemptionPercent: number;
  /** The active subscription's frozen percentage, or 0. */
  subscriptionDiscountPercent: number;
  /** The plan's per-booking cap, as a rupee string, or null for uncapped. */
  subscriptionMaxDiscount: string | null;
}

export interface DiscountBreakdown {
  flatPrice: string;
  subscriptionDiscountAmount: string;
  coinsRedeemed: number;
  walletDiscountAmount: string;
  discountAmount: string;
  payableAmount: string;
  /** The most coins this booking could have absorbed, for the app to show. */
  maxRedeemableCoins: number;
}

/**
 * The whole pricing decision, in one pure function.
 *
 * Order matters and is deliberate: **the subscription discount applies first,
 * and coins fill what is left.** A subscriber is entitled to their percentage
 * whether or not they have coins, and computing it on an already-discounted
 * amount would silently shrink the benefit they paid for. Coins then cap
 * against the *list* price, so the redemption ceiling means the same thing to
 * every customer.
 *
 * Nothing here can produce a negative payable or spend a coin the customer
 * does not hold — the two conditions the CHECK constraints also refuse.
 */
export function computeDiscounts(input: DiscountInput): DiscountBreakdown {
  const flatPaise = toPaise(input.flatPrice);
  const coinValuePaise = Math.round(input.coinValueRupees * 100);

  // --- 1 · subscription -------------------------------------------------
  let subscriptionPaise = 0;
  if (input.subscriptionDiscountPercent > 0 && flatPaise > 0) {
    subscriptionPaise = Math.floor(
      (flatPaise * input.subscriptionDiscountPercent) / 100,
    );
    if (input.subscriptionMaxDiscount !== null) {
      subscriptionPaise = Math.min(
        subscriptionPaise,
        toPaise(input.subscriptionMaxDiscount),
      );
    }
    subscriptionPaise = Math.min(subscriptionPaise, flatPaise);
  }

  // --- 2 · coins --------------------------------------------------------
  const remainingPaise = flatPaise - subscriptionPaise;
  const ceilingPaise = Math.min(
    Math.floor((flatPaise * input.maxRedemptionPercent) / 100),
    remainingPaise,
  );

  const maxRedeemableCoins =
    coinValuePaise > 0 ? Math.floor(ceilingPaise / coinValuePaise) : 0;

  const coinsRedeemed = Math.max(
    0,
    Math.min(input.coinsRequested, input.coinBalance, maxRedeemableCoins),
  );
  const walletPaise = coinsRedeemed * coinValuePaise;

  // --- 3 · totals -------------------------------------------------------
  const discountPaise = subscriptionPaise + walletPaise;

  return {
    flatPrice: fromPaise(flatPaise),
    subscriptionDiscountAmount: fromPaise(subscriptionPaise),
    coinsRedeemed,
    walletDiscountAmount: fromPaise(walletPaise),
    discountAmount: fromPaise(discountPaise),
    payableAmount: fromPaise(flatPaise - discountPaise),
    maxRedeemableCoins: Math.max(0, maxRedeemableCoins),
  };
}

/**
 * A referral code: six characters, upper-case, from an alphabet with no `0/O`
 * and no `1/I/L`.
 *
 * The alphabet is the point. This code is read aloud across a kitchen table
 * and typed by someone who has had the app for four minutes, and a support
 * ticket that turns out to be a zero typed as an O is a real cost. Enforced
 * again by a CHECK constraint, because a second generator written later must
 * not be able to reintroduce the ambiguity.
 */
export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function isWellFormedReferralCode(code: string): boolean {
  return /^[A-Z0-9]{6,12}$/.test(code);
}

/** Normalises whatever the customer typed into what is stored. */
export function normaliseReferralCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]/g, '');
}
