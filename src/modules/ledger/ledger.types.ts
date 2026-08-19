/**
 * The vocabulary of the books.
 *
 * Account names are strings rather than a table, deliberately: two of them are
 * parameterised per Pro (`cash_in_hand:<proId>`, `payable:pro:<proId>`), so a
 * lookup table would need a row per Pro and a join on every balance query, to
 * enforce a set that changes about once a year. The builders below are the
 * enforcement instead — nothing constructs an account name by hand.
 */

/** `LedgerEntry.txnType`, exactly the six the ERD names. */
export const TXN_TYPES = [
  'charge',
  'refund',
  'platform_revenue',
  'pro_commission',
  'deduction',
  'incentive',
] as const;
export type TxnType = (typeof TXN_TYPES)[number];

/**
 * Fixed accounts.
 *
 * `revenue:bookings` is gross — everything a customer paid, before the Pro's
 * share is taken out of it. The platform's own revenue is that less
 * `expense:pro_commission`, computed rather than stored, which is why
 * `platform_revenue` is in the txnType vocabulary and nothing writes it.
 */
export const ACCOUNT = {
  /** Money sitting at Razorpay, not yet settled to the bank. */
  GATEWAY: 'gateway:razorpay',
  /** The platform's current account — where payouts leave from. */
  BANK: 'bank:platform',
  /** Gross takings. */
  REVENUE_BOOKINGS: 'revenue:bookings',
  /**
   * Subscription income — **deliberately not** `revenue:bookings`.
   *
   * The platform's own share is computed as `revenue:bookings` less
   * `expense:pro_commission`. Folding plan income into that would inflate the
   * figure by money no Pro ever worked for, and would make the margin
   * calculation quietly wrong in the direction that flatters it.
   */
  REVENUE_SUBSCRIPTIONS: 'revenue:subscriptions',
  /** Deductions recovered out of a payout. */
  REVENUE_RECOVERIES: 'revenue:recoveries',
  /** What Pros have earned, as it accrues. */
  EXPENSE_COMMISSION: 'expense:pro_commission',
  EXPENSE_INCENTIVES: 'expense:incentives',
} as const;

/**
 * Banknotes a Pro is carrying on the platform's behalf.
 *
 * Named by the ERD, and the account `Pro.cashInHand` is a cache of — which is
 * what makes "does the cached balance agree with the books" a real check rather
 * than a tautology.
 */
export function cashInHandAccount(proId: string): string {
  return `cash_in_hand:${proId}`;
}

/** What the platform owes one Pro. Zero between payouts. */
export function payableToProAccount(proId: string): string {
  return `payable:pro:${proId}`;
}

/**
 * Exactly-once keys.
 *
 * `LedgerEntry.sourceRef` is unique, so these functions *are* the guarantee
 * that a retried webhook, a re-run sweeper or a double-clicked admin button
 * appends one entry rather than two. Every one is derived from the id of the
 * thing that happened, never from a timestamp or a counter.
 */
export const sourceRef = {
  capture: (orderId: string) => `capture:${orderId}`,
  cashCollection: (bookingId: string) => `cash:${bookingId}`,
  handover: (handoverId: string) => `handover:${handoverId}`,
  refund: (razorpayRefundId: string) => `refund:${razorpayRefundId}`,
  accrual: (commissionId: string) => `accrual:${commissionId}`,
  /**
   * Keyed by scheme **and** job, not by progress row: a bonus unwound by a
   * reversal and later re-earned against a different job is a second, real
   * credit and must get a second entry.
   */
  incentive: (incentiveId: string, commissionId: string) =>
    `incentive:${incentiveId}:${commissionId}`,
  reversal: (commissionId: string) => `reversal:${commissionId}`,
  incentiveReversal: (commissionId: string) =>
    `reversal:incentive:${commissionId}`,
  disbursement: (payoutId: string) => `disbursement:${payoutId}`,
  deductionRecovered: (deductionId: string) => `recovery:${deductionId}`,
} as const;

/** `ReconciliationRun.scope`. */
export const RECONCILIATION_SCOPES = [
  'money',
  'cash',
  'ledger',
  'both',
  'all',
] as const;
export type ReconciliationScope = (typeof RECONCILIATION_SCOPES)[number];

/**
 * The four kinds this module adds to the six module 7 already detects.
 *
 * Not a database CHECK — the list grows every time a new class of mismatch is
 * found, and making that a migration would make adding one expensive enough to
 * discourage it.
 */
export const LEDGER_DISCREPANCY_KINDS = [
  'missing_ledger_entry',
  'ledger_amount_mismatch',
  'orphan_ledger_entry',
  'chain_broken',
] as const;
export type LedgerDiscrepancyKind = (typeof LEDGER_DISCREPANCY_KINDS)[number];
