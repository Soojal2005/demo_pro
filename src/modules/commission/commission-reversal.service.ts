import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { BookingCommission } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  CommissionReversalPort,
  RefundReversalNotice,
} from '../payments/ports/commission-reversal.port';
import { sumRupees } from './commission-calculator';
import { CommissionService } from './commission.service';
import {
  incentiveUnwindDedupeKey,
  reversalDedupeKey,
} from './commission.types';
import { DeductionsService } from './deductions.service';
import { IncentiveEvaluationService } from './incentive-evaluation.service';
import {
  COMMISSION_LEDGER_PORT,
  type CommissionLedgerPort,
} from './ports/commission-ledger.port';

export interface ReversalOutcome {
  commissionId: string;
  /** `dropped` — it never reached a payout. `deducted` — the money had gone. */
  effect: 'dropped' | 'deducted';
  /** Total raised as a deduction, including any unwound bonus. */
  deductedAmount: string;
  /** Bonus schemes that lost their reward as a result. */
  unwoundIncentives: string[];
}

/**
 * Feature 13 — commission reversal on a refunded or disputed job.
 *
 * The whole subtlety is *when* the reversal arrives relative to the payout:
 *
 * | Status when reversed | What happens                                    |
 * | -------------------- | ----------------------------------------------- |
 * | `pending`/`approved` | Mark reversed. It simply never enters a payout. |
 * | `paid`               | Leave it paid — it **was** paid — and raise a   |
 * |                      | deduction against the next payout.              |
 *
 * The second row is the one that goes wrong in every system that tracks debt as
 * a number on the Pro rather than as rows: it cannot say what the money was
 * for, it double-applies on a retry, and nobody can audit it.
 */
@Injectable()
export class CommissionReversalService implements CommissionReversalPort {
  private readonly logger = new Logger(CommissionReversalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deductions: DeductionsService,
    private readonly incentives: IncentiveEvaluationService,
    private readonly commissions: CommissionService,
    @Inject(COMMISSION_LEDGER_PORT)
    private readonly ledger: CommissionLedgerPort,
  ) {}

  /**
   * Module 7's refund path, arriving through the port it owns.
   *
   * **Only a full refund reverses automatically.** A partial refund is
   * discretionary — ops returning ₹100 on a ₹1,000 job the Pro did properly —
   * and taking the Pro's whole pay for it would punish them for a decision
   * somebody else made. The partial is logged; ops reverses by hand when the
   * Pro genuinely is at fault.
   */
  async onRefund(notice: RefundReversalNotice): Promise<void> {
    const commission = await this.prisma.bookingCommission.findUnique({
      where: { bookingId: notice.bookingId },
    });
    if (!commission) return;

    if (!notice.isFullRefund) {
      this.logger.log(
        `Booking ${notice.bookingId} partially refunded ${notice.amount}; ` +
          `commission ${commission.id} left standing. Reverse it by hand if the Pro is at fault.`,
      );
      return;
    }

    await this.reverse(
      commission.id,
      notice.reason ?? `Full refund on booking ${notice.bookingId}`,
      notice.adminId ?? null,
    );
  }

  /**
   * Reverse one commission. Safe to call twice.
   *
   * Idempotency comes from two independent places, so neither has to be
   * perfect: `reversedAt` short-circuits the second call, and every deduction
   * it raises carries a unique `dedupeKey` — so even a call that races past
   * the first check cannot charge the same money twice.
   */
  async reverse(
    commissionId: string,
    reason: string,
    adminId: string | null,
  ): Promise<ReversalOutcome> {
    const commission = await this.prisma.bookingCommission.findUnique({
      where: { id: commissionId },
    });
    if (!commission) {
      throw apiError('Commission not found', HttpStatus.NOT_FOUND);
    }

    // Guarded on `reversedAt`, NOT on `status === 'reversed'`. A row that was
    // already paid keeps `paid` after being reversed, so the status is exactly
    // the wrong thing to ask — checking it would let a second call reverse an
    // already-reversed paid job and raise the deduction over again.
    if (commission.reversedAt) {
      // Not an error. A retried webhook, a double-clicked admin button and a
      // manual reversal after an automatic one all land here, and all three
      // want the same answer.
      return this.describeExisting(commission);
    }

    const wasPaid = commission.status === 'paid';

    // Unwind the bonuses first. Their reward has to be recovered too, and
    // whether it becomes a deduction depends on the same "has the money gone"
    // question as the commission itself.
    const unwound = await this.incentives.unwindForCommission(commissionId);

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`commission:${commission.bookingId}`}, 0))`;

      await tx.bookingCommission.update({
        where: { id: commissionId },
        data: {
          // A paid row KEEPS `paid`. It was paid; saying otherwise would make
          // the payout it sat in stop adding up.
          status: wasPaid ? 'paid' : 'reversed',
          reversedAt: new Date(),
          reversalReason: reason,
          reversedByAdminId: adminId,
          // A draft batch must let go of it immediately, or the batch pays for
          // a job that has just been cancelled.
          ...(wasPaid ? {} : { payoutId: null, incentiveAmount: '0' }),
        },
      });
    });

    let deductedAmount = '0.00';

    if (wasPaid) {
      const commissionDeduction = await this.deductions.raise({
        proId: commission.proId,
        amount: commission.commissionAmount.toString(),
        kind: 'commission_reversal',
        reason: `Reversal of commission on booking ${commission.bookingId}: ${reason}`,
        sourceCommissionId: commissionId,
        dedupeKey: reversalDedupeKey(commissionId),
        raisedByAdminId: adminId,
      });

      const parts: string[] = commissionDeduction
        ? [commission.commissionAmount.toString()]
        : [];

      for (const bonus of unwound) {
        const raised = await this.deductions.raise({
          proId: commission.proId,
          amount: bonus.rewardAmount,
          kind: 'incentive_unwind',
          reason: `Bonus "${bonus.incentiveName}" unwound with booking ${commission.bookingId}`,
          sourceCommissionId: commissionId,
          dedupeKey: incentiveUnwindDedupeKey(bonus.progressId),
          raisedByAdminId: adminId,
        });
        if (raised) parts.push(bonus.rewardAmount);
      }

      deductedAmount = sumRupees(parts);
    }

    await this.commissions.refreshTotals(commissionId);

    await this.ledger.recordReversal({
      commissionId,
      proId: commission.proId,
      amount: commission.commissionAmount.toString(),
      // The bonus that was riding on this job. Booked against a different
      // expense account, so the ledger needs it as its own figure rather than
      // folded into the commission amount.
      incentiveAmount: commission.incentiveAmount.toString(),
      alreadyPaid: wasPaid,
      reason,
    });

    this.logger.warn(
      `Commission ${commissionId} reversed (${reason}). ` +
        (wasPaid
          ? `Already paid — ${deductedAmount} carried as a deduction on the next payout.`
          : 'Not yet paid — dropped before it reached one.'),
    );

    return {
      commissionId,
      effect: wasPaid ? 'deducted' : 'dropped',
      deductedAmount,
      unwoundIncentives: unwound.map((bonus) => bonus.incentiveName),
    };
  }

  /** The answer a repeat call gets, read back off the rows the first one wrote. */
  private async describeExisting(
    commission: BookingCommission,
  ): Promise<ReversalOutcome> {
    const raised = await this.prisma.payoutDeduction.findMany({
      // Narrowed to the two kinds a reversal itself raises. `sourceCommissionId`
      // alone is too wide: an admin raising a manual deduction against the same
      // job also stamps it, and counting that here makes a repeat call report
      // money this reversal never charged — `dropped` reads back as `deducted`,
      // and `deductedAmount` reads back as the manual figure.
      where: {
        sourceCommissionId: commission.id,
        kind: { in: ['commission_reversal', 'incentive_unwind'] },
      },
    });
    return {
      commissionId: commission.id,
      effect: raised.length > 0 ? 'deducted' : 'dropped',
      deductedAmount: sumRupees(raised.map((row) => row.amount.toString())),
      unwoundIncentives: raised
        .filter((row) => row.kind === 'incentive_unwind')
        .map((row) => row.reason),
    };
  }
}
