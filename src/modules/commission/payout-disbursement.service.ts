import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { apiError } from '../../common/utils';
import type {
  CommissionPayout,
  Pro,
  ProBankAccount,
} from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toPaise } from '../payments/payments.money';
import {
  COMMISSION_LEDGER_PORT,
  type CommissionLedgerPort,
} from './ports/commission-ledger.port';
import { RazorpayXClient, RazorpayXError } from './razorpayx.client';

/**
 * Feature 12 — RazorpayX disbursement, with reference capture.
 *
 * ## The rule this service exists to enforce
 *
 * **Nothing is marked paid on submission.** Submitting a payout moves it to
 * `processing`; only the webhook — or a deliberate reconciliation read — moves
 * it to `paid`, and the commission rows inside it are marked paid at that same
 * moment. US-8.11 is explicit, and the failure it prevents is the worst one in
 * the module: a Pro recorded as paid, with nothing in their account, and no row
 * anywhere that disagrees.
 */
@Injectable()
export class PayoutDisbursementService {
  private readonly logger = new Logger(PayoutDisbursementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpayx: RazorpayXClient,
    @Inject(COMMISSION_LEDGER_PORT)
    private readonly ledger: CommissionLedgerPort,
  ) {}

  /**
   * Send an approved batch.
   *
   * The status moves `approved → processing` through a **conditional update**
   * before anything is sent. Two admins pressing the button at once, or one
   * pressing it twice, resolve at the database: the loser's `updateMany`
   * matches nothing and it stops there, having submitted nothing.
   */
  async disburse(payoutId: string, adminId: string): Promise<CommissionPayout> {
    const payout = await this.prisma.commissionPayout.findUnique({
      where: { id: payoutId },
      include: { pro: true, bankAccount: true },
    });
    if (!payout) throw apiError('Payout not found', HttpStatus.NOT_FOUND);

    if (!this.razorpayx.isConfigured) {
      throw apiError(
        'Payouts are not available on this deployment',
        HttpStatus.NOT_IMPLEMENTED,
        [
          {
            field: 'payoutId',
            message:
              'RazorpayX is not configured. Approval still works; the transfer cannot be made.',
            code: 'PAYOUT_GATEWAY_NOT_CONFIGURED',
          },
        ],
      );
    }

    if (payout.status !== 'approved') {
      throw apiError(
        'Only an approved payout can be disbursed',
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message: `This payout is ${payout.status}`,
            code: 'PAYOUT_NOT_APPROVED',
          },
        ],
      );
    }

    if (toPaise(payout.netAmount.toString()) === 0) {
      throw apiError(
        'This payout is for zero and has nothing to send',
        HttpStatus.CONFLICT,
        [
          {
            field: 'netAmount',
            message:
              'Deductions consumed the whole period. Reject the batch instead — the earnings roll forward.',
            code: 'PAYOUT_ZERO_NET',
          },
        ],
      );
    }

    const destination = await this.resolveDestination(
      payout.pro,
      payout.bankAccount,
    );

    // A fresh key per attempt. Reusing the previous one would make RazorpayX
    // replay the earlier response rather than try again, so a retry after a
    // genuine failure would report the failure forever.
    const idempotencyKey = randomUUID();

    const { count } = await this.prisma.commissionPayout.updateMany({
      where: { id: payoutId, status: 'approved' },
      data: {
        status: 'processing',
        idempotencyKey,
        payoutMode: destination.accountType,
        disbursedByAdminId: adminId,
        disbursedAt: new Date(),
        attemptCount: { increment: 1 },
        failureReason: null,
      },
    });
    if (count === 0) {
      throw apiError('This payout is already being sent', HttpStatus.CONFLICT, [
        {
          field: 'status',
          message: 'Another request moved it to processing first',
          code: 'PAYOUT_ALREADY_PROCESSING',
        },
      ]);
    }

    try {
      const sent = await this.razorpayx.createPayout({
        fundAccountId: destination.fundAccountId,
        amountPaise: toPaise(payout.netAmount.toString()),
        mode: destination.accountType === 'vpa' ? 'UPI' : 'IMPS',
        referenceId: payout.id,
        narration: `Homingo ${payout.periodStart.toISOString().slice(0, 7)}`,
        idempotencyKey,
        notes: { payoutId: payout.id, proId: payout.proId },
      });

      // The reference is captured whatever the reported status: it is the only
      // handle anybody has on this transfer in RazorpayX's dashboard, and a
      // failure with no reference is a failure nobody can investigate.
      await this.prisma.commissionPayout.update({
        where: { id: payoutId },
        data: { payoutReference: sent.id },
      });

      this.logger.log(
        `Payout ${payoutId} submitted to RazorpayX as ${sent.id} (${sent.status}). ` +
          'Nothing is marked paid until the webhook confirms.',
      );

      // Some modes settle inside the request. Route it through the same
      // settlement path the webhook uses so there is exactly one place that
      // marks money as arrived.
      if (sent.status === 'processed') {
        await this.settle(sent.id, sent.utr ?? sent.id);
      }

      return this.prisma.commissionPayout.findUniqueOrThrow({
        where: { id: payoutId },
      });
    } catch (error) {
      const failure =
        error instanceof RazorpayXError
          ? (error.description ?? error.message)
          : 'Unknown error while submitting the payout';

      /**
       * An unreachable gateway is **not** a failure. The request may have
       * arrived and the money may already be moving; calling it failed would
       * invite a retry that pays twice — which the idempotency key would only
       * prevent inside RazorpayX's own window.
       *
       * So it stays `processing` with the reason recorded, and reconciliation
       * against the gateway resolves it. Only a definite refusal becomes
       * `failed`.
       */
      const unknown = error instanceof RazorpayXError && error.status === 0;

      await this.prisma.commissionPayout.update({
        where: { id: payoutId },
        data: {
          status: unknown ? 'processing' : 'failed',
          failureReason: failure,
        },
      });

      this.logger.error(
        `Payout ${payoutId} ${unknown ? 'may or may not have been submitted' : 'was refused'}: ${failure}`,
      );

      throw apiError(
        unknown
          ? 'The payout was submitted but the gateway did not answer. It is being tracked — do not resend.'
          : 'The payout was refused by the bank',
        unknown ? HttpStatus.ACCEPTED : HttpStatus.BAD_GATEWAY,
        [{ field: 'payoutId', message: failure, code: 'PAYOUT_SUBMIT_FAILED' }],
      );
    }
  }

  /**
   * Try a failed batch again.
   *
   * Only from `failed` — a definite refusal. A `processing` payout is not
   * retryable by design: nobody knows whether the first attempt moved money,
   * and the answer comes from the gateway, not from pressing the button again.
   */
  async retry(payoutId: string, adminId: string): Promise<CommissionPayout> {
    const { count } = await this.prisma.commissionPayout.updateMany({
      where: { id: payoutId, status: 'failed' },
      data: { status: 'approved', failureReason: null },
    });

    if (count === 0) {
      const payout = await this.prisma.commissionPayout.findUnique({
        where: { id: payoutId },
      });
      if (!payout) throw apiError('Payout not found', HttpStatus.NOT_FOUND);

      throw apiError(
        'Only a failed payout can be retried',
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message:
              payout.status === 'processing'
                ? 'This payout may already have moved money. Reconcile it against RazorpayX before retrying.'
                : `This payout is ${payout.status}`,
            code: 'PAYOUT_NOT_RETRYABLE',
          },
        ],
      );
    }

    return this.disburse(payoutId, adminId);
  }

  /**
   * The money arrived. The **only** place anything becomes `paid`.
   *
   * Convergent rather than incremental: a redelivered webhook reads the
   * timestamp already on the row instead of moving it, and the commission
   * update is filtered on `status: 'approved'` so a second delivery touches
   * nothing.
   */
  async settle(payoutReference: string, utr: string): Promise<void> {
    const payout = await this.prisma.commissionPayout.findFirst({
      where: { payoutReference },
    });
    if (!payout) {
      this.logger.warn(
        `RazorpayX confirmed payout ${payoutReference}, which matches no batch here.`,
      );
      return;
    }
    if (payout.status === 'paid') return;

    const paidAt = payout.paidAt ?? new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.commissionPayout.update({
        where: { id: payout.id },
        data: {
          status: 'paid',
          paidAt,
          payoutReference: utr,
          failureReason: null,
        },
      });

      await tx.bookingCommission.updateMany({
        where: { payoutId: payout.id, status: 'approved' },
        data: { status: 'paid' },
      });
    });

    await this.ledger.recordDisbursement({
      payoutId: payout.id,
      proId: payout.proId,
      netAmount: payout.netAmount.toString(),
      payoutReference: utr,
    });

    /**
     * Deductions become real here, not when the batch claimed them.
     *
     * A claimed deduction on a draft batch is a claim, and `reject` gives it
     * back. Booking it at claim time would leave an entry in an append-only
     * table describing money that never moved — and the table is append-only,
     * so there would be no way to take it back out.
     */
    const recovered = await this.prisma.payoutDeduction.findMany({
      where: { consumedByPayoutId: payout.id },
    });
    for (const deduction of recovered) {
      await this.ledger.recordDeductionRecovered({
        deductionId: deduction.id,
        proId: payout.proId,
        payoutId: payout.id,
        amount: deduction.consumedAmount.toString(),
        reason: deduction.reason,
      });
    }

    this.logger.log(
      `Payout ${payout.id} confirmed paid (${utr}). Its commissions are now paid.`,
    );
  }

  /**
   * The transfer failed at the bank.
   *
   * The commissions inside it stay `approved` and unpaid, deliberately: the
   * work still earned that money and the next batch — or a retry — must still
   * pay it. The deductions stay consumed, because the batch still exists and
   * still holds them; rejecting it is what gives them back.
   */
  async markFailed(payoutReference: string, reason: string): Promise<void> {
    const payout = await this.prisma.commissionPayout.findFirst({
      where: { payoutReference },
    });
    if (!payout || payout.status === 'paid') return;

    await this.prisma.commissionPayout.update({
      where: { id: payout.id },
      data: { status: 'failed', failureReason: reason },
    });

    this.logger.error(
      `Payout ${payout.id} failed at the bank: ${reason}. ` +
        'Its commissions remain unpaid, which is correct — nothing has moved.',
    );
  }

  /**
   * Find or create the RazorpayX destination for a Pro.
   *
   * **UPI only, for now, and the reason is a real gap rather than a
   * preference.** `ProBankAccount.accountNumberMasked` is masked and module 2
   * enforces that it stays masked, so there is no unmasked number here to build
   * a bank fund account from. `upiId` is the one instrument stored in full.
   *
   * `razorpayxFundAccountId` is the seam for the bank route: module 2's
   * verification step is where an unmasked number exists, and once it fills
   * that column this method uses it without further change. Until then a Pro
   * with no UPI id gets a sentence naming them, rather than a gateway error
   * naming a field. See CONFLICTS_AND_DECISIONS #51.
   */
  private async resolveDestination(
    pro: Pro,
    bankAccount: ProBankAccount,
  ): Promise<{ fundAccountId: string; accountType: 'vpa' | 'bank_account' }> {
    if (bankAccount.razorpayxFundAccountId) {
      return {
        fundAccountId: bankAccount.razorpayxFundAccountId,
        accountType:
          (bankAccount.razorpayxFundAccountType as 'vpa' | 'bank_account') ??
          'bank_account',
      };
    }

    // `Pro.fullName` is nullable — it is copied from the approved KYC
    // application and a Pro cannot set it themselves. The name on the bank
    // account is not, and is the better one to send anyway: a transfer whose
    // beneficiary name does not match the account is exactly what banks reject.
    const payeeName = bankAccount.accountHolderName;

    if (!bankAccount.upiId) {
      throw apiError(
        `${payeeName} has no UPI id, and their bank account number is stored masked`,
        HttpStatus.UNPROCESSABLE_ENTITY,
        [
          {
            field: 'bankAccount.upiId',
            message:
              'Add a UPI id to this bank account, or have module 2 register a RazorpayX fund account for it.',
            code: 'NO_PAYABLE_DESTINATION',
          },
        ],
      );
    }

    let contactId = pro.razorpayxContactId;
    if (!contactId) {
      const contact = await this.razorpayx.createContact({
        name: payeeName,
        contact: pro.phone,
        referenceId: pro.id,
      });
      contactId = contact.id;
      await this.prisma.pro.update({
        where: { id: pro.id },
        data: { razorpayxContactId: contactId },
      });
    }

    const fundAccount = await this.razorpayx.createFundAccount({
      contactId,
      vpa: { address: bankAccount.upiId },
    });

    await this.prisma.proBankAccount.update({
      where: { id: bankAccount.id },
      data: {
        razorpayxFundAccountId: fundAccount.id,
        razorpayxFundAccountType: 'vpa',
      },
    });

    return { fundAccountId: fundAccount.id, accountType: 'vpa' };
  }
}
