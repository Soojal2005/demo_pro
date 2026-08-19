import { Injectable, Logger } from '@nestjs/common';
import { toPaise } from '../payments/payments.money';
import type {
  CommissionAccrualEntry,
  CommissionLedgerPort,
  CommissionReversalEntry,
  DeductionRecoveredEntry,
  IncentiveCreditEntry,
  PayoutDisbursementEntry,
} from '../commission/ports/commission-ledger.port';
import type {
  CaptureEntry,
  CashCollectionEntry,
  HandoverEntry,
  LedgerPort,
  RefundEntry,
} from '../payments/ports/ledger.port';
import { LedgerService } from './ledger.service';
import {
  ACCOUNT,
  cashInHandAccount,
  payableToProAccount,
  sourceRef,
} from './ledger.types';

/**
 * The eight events that move money, expressed as account pairs.
 *
 * This class is the whole of module 9's "business logic", and it is a
 * translation table rather than a decision-maker: modules 7 and 8 already
 * decided what happened, and every method here says only which two accounts it
 * happened between.
 *
 * ## The accounts, and how they net to zero
 *
 * | Event              | Debit                    | Credit                   |
 * | ------------------ | ------------------------ | ------------------------ |
 * | Online capture     | `gateway:razorpay`       | `revenue:bookings`       |
 * | Cash collected     | `cash_in_hand:<pro>`     | `revenue:bookings`       |
 * | Handover confirmed | `bank:platform`          | `cash_in_hand:<pro>`     |
 * | Refund settled     | `revenue:bookings`       | `gateway:razorpay`       |
 * | Commission accrued | `expense:pro_commission` | `payable:pro:<pro>`      |
 * | Incentive credited | `expense:incentives`     | `payable:pro:<pro>`      |
 * | Reversal (unpaid)  | `payable:pro:<pro>`      | `expense:pro_commission` |
 * | Deduction recovered| `payable:pro:<pro>`      | `revenue:recoveries`     |
 * | Payout confirmed   | `payable:pro:<pro>`      | `bank:platform`          |
 *
 * `cash_in_hand:<pro>` goes up when a Pro takes banknotes and back to zero when
 * they hand them over — so it is the account `Pro.cashInHand` is a cache of,
 * which makes "do the two agree" a real reconciliation check.
 *
 * `payable:pro:<pro>` goes up as work is done and back to zero at settlement:
 * accruals and incentives credit it by the gross, and settlement debits it by
 * the net plus every deduction recovered. If it does not return to zero after a
 * paid payout, something is missing — which is the third ledger-scope check.
 *
 * ## Every method here is non-fatal at its call site
 *
 * By the time any of these runs the money has already moved. A missing entry is
 * recoverable — the entire ledger is rebuildable from `Order`, `Booking`,
 * `CashHandover`, `BookingCommission` and `CommissionPayout`, which is exactly
 * what reconciliation checks — whereas refusing a cash collection because a
 * bookkeeping row failed would strand a Pro at a customer's door.
 */
@Injectable()
export class LedgerAdapterService implements LedgerPort, CommissionLedgerPort {
  private readonly logger = new Logger(LedgerAdapterService.name);

  constructor(private readonly ledger: LedgerService) {}

  // ------------------------------------------------------------------
  // Module 7 · money in
  // ------------------------------------------------------------------

  async recordCapture(entry: CaptureEntry): Promise<void> {
    await this.ledger.append({
      txnType: 'charge',
      debitAccount: ACCOUNT.GATEWAY,
      // A subscription is income the platform keeps whole — no Pro worked for
      // it and no commission comes out of it — so it is credited to its own
      // account rather than to gross booking takings.
      creditAccount: entry.subscriptionId
        ? ACCOUNT.REVENUE_SUBSCRIPTIONS
        : ACCOUNT.REVENUE_BOOKINGS,
      amount: entry.amount,
      sourceRef: sourceRef.capture(entry.orderId),
      bookingId: entry.bookingId,
      orderId: entry.orderId,
      customerId: entry.customerId,
      razorpayPaymentId: entry.razorpayPaymentId,
    });
  }

  /**
   * Cash never touches the gateway or the bank — the Pro is holding it. The
   * debit is to their own cash account, and it stays there until a handover
   * clears it.
   */
  async recordCashCollection(entry: CashCollectionEntry): Promise<void> {
    await this.ledger.append({
      txnType: 'charge',
      debitAccount: cashInHandAccount(entry.proId),
      creditAccount: ACCOUNT.REVENUE_BOOKINGS,
      amount: entry.amount,
      sourceRef: sourceRef.cashCollection(entry.bookingId),
      bookingId: entry.bookingId,
      proId: entry.proId,
      customerId: entry.customerId,
    });
  }

  /**
   * The banknotes reach the platform. Not revenue — that was already booked at
   * collection; this only moves the same money from the Pro's pocket to the
   * bank.
   */
  async recordHandover(entry: HandoverEntry): Promise<void> {
    await this.ledger.append({
      txnType: 'charge',
      debitAccount: ACCOUNT.BANK,
      creditAccount: cashInHandAccount(entry.proId),
      amount: entry.amount,
      sourceRef: sourceRef.handover(entry.handoverId),
      proId: entry.proId,
    });
  }

  /**
   * A refund debits revenue rather than crediting an expense.
   *
   * The money is leaving the same account it arrived in, so the honest record
   * is that the sale partly un-happened — not that the platform incurred a
   * cost. It also keeps `revenue:bookings` equal to what customers actually
   * kept paying, which is the figure the dashboard reports.
   */
  async recordRefund(entry: RefundEntry): Promise<void> {
    await this.ledger.append({
      txnType: 'refund',
      debitAccount: ACCOUNT.REVENUE_BOOKINGS,
      creditAccount: ACCOUNT.GATEWAY,
      amount: entry.amount,
      sourceRef: sourceRef.refund(entry.razorpayRefundId),
      bookingId: entry.bookingId,
      orderId: entry.orderId,
      customerId: entry.customerId,
      razorpayPaymentId: entry.razorpayPaymentId,
    });
  }

  // ------------------------------------------------------------------
  // Module 8 · money out
  // ------------------------------------------------------------------

  /**
   * Only the Pro's share is booked.
   *
   * `platformAmount` gets no entry of its own: it is already implied by
   * `revenue:bookings` less `expense:pro_commission`, and booking it separately
   * would double-count the same rupees under two names.
   */
  async recordAccrual(entry: CommissionAccrualEntry): Promise<void> {
    await this.ledger.append({
      txnType: 'pro_commission',
      debitAccount: ACCOUNT.EXPENSE_COMMISSION,
      creditAccount: payableToProAccount(entry.proId),
      amount: entry.commissionAmount,
      sourceRef: sourceRef.accrual(entry.commissionId),
      bookingId: entry.bookingId,
      proId: entry.proId,
    });
  }

  async recordIncentiveCredit(entry: IncentiveCreditEntry): Promise<void> {
    await this.ledger.append({
      txnType: 'incentive',
      debitAccount: ACCOUNT.EXPENSE_INCENTIVES,
      creditAccount: payableToProAccount(entry.proId),
      amount: entry.amount,
      sourceRef: sourceRef.incentive(entry.incentiveId, entry.commissionId),
      proId: entry.proId,
    });
  }

  /**
   * Reversal, and the one branch worth reading twice.
   *
   * **Not yet paid** — the accrual is undone. `payable:pro` still carries the
   * amount, so it is debited straight back out and the expense is credited. The
   * books end up as though the job never earned anything, which is true.
   *
   * **Already paid** — **no entry at all.** `payable:pro` is already zero and
   * the money is in the Pro's bank; nothing has moved and an append-only table
   * must not claim otherwise. What the platform now holds is a *claim*, which
   * lives in `PayoutDeduction`, and it becomes a ledger entry only when it is
   * actually recovered out of a later payout.
   *
   * Booking a movement here would show the money coming back before it has,
   * and there would be no way to take the entry out again.
   */
  async recordReversal(entry: CommissionReversalEntry): Promise<void> {
    if (entry.alreadyPaid) {
      this.logger.log(
        `Commission ${entry.commissionId} reversed after payment — no ledger entry. ` +
          'The recovery is booked when a later payout actually consumes the deduction.',
      );
      return;
    }

    await this.ledger.append({
      txnType: 'pro_commission',
      debitAccount: payableToProAccount(entry.proId),
      creditAccount: ACCOUNT.EXPENSE_COMMISSION,
      amount: entry.amount,
      sourceRef: sourceRef.reversal(entry.commissionId),
      proId: entry.proId,
    });

    // The bonus rode on the same job and came out of a different expense
    // account, so it needs its own leg rather than being folded in.
    if (toPaise(entry.incentiveAmount) > 0) {
      await this.ledger.append({
        txnType: 'incentive',
        debitAccount: payableToProAccount(entry.proId),
        creditAccount: ACCOUNT.EXPENSE_INCENTIVES,
        amount: entry.incentiveAmount,
        sourceRef: sourceRef.incentiveReversal(entry.commissionId),
        proId: entry.proId,
      });
    }
  }

  /** Money the Pro owed, taken out of a payout that has actually been paid. */
  async recordDeductionRecovered(
    entry: DeductionRecoveredEntry,
  ): Promise<void> {
    await this.ledger.append({
      txnType: 'deduction',
      debitAccount: payableToProAccount(entry.proId),
      creditAccount: ACCOUNT.REVENUE_RECOVERIES,
      amount: entry.amount,
      sourceRef: sourceRef.deductionRecovered(entry.deductionId),
      payoutId: entry.payoutId,
      proId: entry.proId,
    });
  }

  /**
   * The transfer itself. Written only from `settle`, so this entry existing is
   * the same statement as "the bank confirmed it".
   */
  async recordDisbursement(entry: PayoutDisbursementEntry): Promise<void> {
    await this.ledger.append({
      txnType: 'pro_commission',
      debitAccount: payableToProAccount(entry.proId),
      creditAccount: ACCOUNT.BANK,
      amount: entry.netAmount,
      sourceRef: sourceRef.disbursement(entry.payoutId),
      payoutId: entry.payoutId,
      proId: entry.proId,
    });
  }
}
