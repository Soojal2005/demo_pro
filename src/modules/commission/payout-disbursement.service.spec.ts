import { HttpException, HttpStatus } from '@nestjs/common';
import { PayoutDisbursementService } from './payout-disbursement.service';
import { RazorpayXError } from './razorpayx.client';

const decimal = (value: string) => ({ toString: () => value });

function buildDeps() {
  const tx = {
    commissionPayout: { update: jest.fn().mockResolvedValue({}) },
    bookingCommission: {
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
  };

  const prisma = {
    commissionPayout: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'payout-1' }),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockResolvedValue({}),
    },
    pro: { update: jest.fn().mockResolvedValue({}) },
    proBankAccount: { update: jest.fn().mockResolvedValue({}) },
    payoutDeduction: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };

  const razorpayx = {
    isConfigured: true,
    createContact: jest.fn().mockResolvedValue({ id: 'cont_1' }),
    createFundAccount: jest.fn().mockResolvedValue({ id: 'fa_1' }),
    createPayout: jest
      .fn()
      .mockResolvedValue({ id: 'pout_1', status: 'queued', utr: null }),
  };

  const ledger = {
    recordDisbursement: jest.fn().mockResolvedValue(undefined),
    recordDeductionRecovered: jest.fn().mockResolvedValue(undefined),
  };

  return { prisma, tx, razorpayx, ledger };
}

function build(deps: ReturnType<typeof buildDeps>): PayoutDisbursementService {
  return new PayoutDisbursementService(
    deps.prisma as never,
    deps.razorpayx as never,
    deps.ledger as never,
  );
}

function anApprovedPayout(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payout-1',
    proId: 'pro-1',
    status: 'approved',
    netAmount: decimal('14500.00'),
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    pro: {
      id: 'pro-1',
      fullName: 'Anita Rao',
      phone: '+919000000001',
      razorpayxContactId: null,
    },
    bankAccount: {
      id: 'bank-1',
      accountHolderName: 'Anita Rao',
      accountNumberMasked: 'XXXXXX4321',
      upiId: 'anita@upi',
      razorpayxFundAccountId: null,
      razorpayxFundAccountType: null,
    },
    ...overrides,
  };
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
  return 200;
}

describe('disburse', () => {
  /** US-8.11, and the worst failure in the module if it regresses. */
  it('does not mark anything paid on submission', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findUnique.mockResolvedValue(
      anApprovedPayout(),
    );

    await build(deps).disburse('payout-1', 'admin-1');

    const [transition] = deps.prisma.commissionPayout.updateMany.mock.calls;
    expect(transition[0].data.status).toBe('processing');
    expect(deps.tx.bookingCommission.updateMany).not.toHaveBeenCalled();
    expect(deps.ledger.recordDisbursement).not.toHaveBeenCalled();
  });

  it('moves approved → processing conditionally, so a double-click sends once', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findUnique.mockResolvedValue(
      anApprovedPayout(),
    );
    deps.prisma.commissionPayout.updateMany.mockResolvedValue({ count: 0 });

    expect(await statusOf(build(deps).disburse('payout-1', 'admin-1'))).toBe(
      HttpStatus.CONFLICT,
    );
    expect(deps.razorpayx.createPayout).not.toHaveBeenCalled();
  });

  it('sends a fresh idempotency key and captures the reference', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findUnique.mockResolvedValue(
      anApprovedPayout(),
    );

    await build(deps).disburse('payout-1', 'admin-1');

    const sent = deps.razorpayx.createPayout.mock.calls[0][0];
    expect(sent.amountPaise).toBe(1_450_000);
    expect(sent.idempotencyKey).toEqual(expect.any(String));
    expect(sent.mode).toBe('UPI');
    expect(deps.prisma.commissionPayout.update).toHaveBeenCalledWith({
      where: { id: 'payout-1' },
      data: { payoutReference: 'pout_1' },
    });
  });

  it('creates the contact and fund account once and remembers both', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findUnique.mockResolvedValue(
      anApprovedPayout(),
    );

    await build(deps).disburse('payout-1', 'admin-1');

    expect(deps.prisma.pro.update).toHaveBeenCalledWith({
      where: { id: 'pro-1' },
      data: { razorpayxContactId: 'cont_1' },
    });
    expect(deps.prisma.proBankAccount.update).toHaveBeenCalledWith({
      where: { id: 'bank-1' },
      data: {
        razorpayxFundAccountId: 'fa_1',
        razorpayxFundAccountType: 'vpa',
      },
    });
  });

  it('reuses a fund account it already has', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findUnique.mockResolvedValue(
      anApprovedPayout({
        bankAccount: {
          id: 'bank-1',
          accountHolderName: 'Anita Rao',
          accountNumberMasked: 'XXXXXX4321',
          upiId: 'anita@upi',
          razorpayxFundAccountId: 'fa_existing',
          razorpayxFundAccountType: 'vpa',
        },
      }),
    );

    await build(deps).disburse('payout-1', 'admin-1');

    expect(deps.razorpayx.createFundAccount).not.toHaveBeenCalled();
    expect(deps.razorpayx.createPayout.mock.calls[0][0].fundAccountId).toBe(
      'fa_existing',
    );
  });

  /**
   * CONFLICTS_AND_DECISIONS #51 — the bank number is stored masked, so UPI is
   * the only rail this module can build a destination from today.
   */
  it('refuses with a name, not a gateway error, when there is nowhere to pay', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findUnique.mockResolvedValue(
      anApprovedPayout({
        bankAccount: {
          id: 'bank-1',
          accountHolderName: 'Anita Rao',
          accountNumberMasked: 'XXXXXX4321',
          upiId: null,
          razorpayxFundAccountId: null,
          razorpayxFundAccountType: null,
        },
      }),
    );

    expect(await statusOf(build(deps).disburse('payout-1', 'admin-1'))).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  });

  it('refuses a payout that has not been approved', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findUnique.mockResolvedValue(
      anApprovedPayout({ status: 'draft' }),
    );

    expect(await statusOf(build(deps).disburse('payout-1', 'admin-1'))).toBe(
      HttpStatus.CONFLICT,
    );
  });

  it('refuses a zero payout rather than sending nothing to a bank', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findUnique.mockResolvedValue(
      anApprovedPayout({ netAmount: decimal('0.00') }),
    );

    expect(await statusOf(build(deps).disburse('payout-1', 'admin-1'))).toBe(
      HttpStatus.CONFLICT,
    );
  });

  it('answers honestly when RazorpayX is not configured', async () => {
    const deps = buildDeps();
    deps.razorpayx.isConfigured = false;
    deps.prisma.commissionPayout.findUnique.mockResolvedValue(
      anApprovedPayout(),
    );

    expect(await statusOf(build(deps).disburse('payout-1', 'admin-1'))).toBe(
      HttpStatus.NOT_IMPLEMENTED,
    );
  });

  it('returns not found before checking deployment gateway configuration', async () => {
    const deps = buildDeps();
    deps.razorpayx.isConfigured = false;
    deps.prisma.commissionPayout.findUnique.mockResolvedValue(null);

    expect(await statusOf(build(deps).disburse('missing', 'admin-1'))).toBe(
      HttpStatus.NOT_FOUND,
    );
  });

  it('marks a refused transfer failed', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findUnique.mockResolvedValue(
      anApprovedPayout(),
    );
    deps.razorpayx.createPayout.mockRejectedValue(
      new RazorpayXError('bad ifsc', 400, 'BAD_REQUEST_ERROR', 'Invalid IFSC'),
    );

    expect(await statusOf(build(deps).disburse('payout-1', 'admin-1'))).toBe(
      HttpStatus.BAD_GATEWAY,
    );
    const last = deps.prisma.commissionPayout.update.mock.calls.at(-1)![0];
    expect(last.data.status).toBe('failed');
    expect(last.data.failureReason).toBe('Invalid IFSC');
  });

  /**
   * An unreachable gateway is not a failure. The request may have arrived and
   * the money may be moving; calling it failed invites a retry that pays twice.
   */
  it('leaves an unanswered submission in processing, not failed', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findUnique.mockResolvedValue(
      anApprovedPayout(),
    );
    deps.razorpayx.createPayout.mockRejectedValue(
      new RazorpayXError('timeout', 0, 'PAYOUT_GATEWAY_UNREACHABLE'),
    );

    expect(await statusOf(build(deps).disburse('payout-1', 'admin-1'))).toBe(
      HttpStatus.ACCEPTED,
    );
    const last = deps.prisma.commissionPayout.update.mock.calls.at(-1)![0];
    expect(last.data.status).toBe('processing');
  });
});

describe('settle', () => {
  it('is the only thing that marks a payout and its jobs paid', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findFirst.mockResolvedValue({
      id: 'payout-1',
      proId: 'pro-1',
      status: 'processing',
      paidAt: null,
      netAmount: decimal('14500.00'),
    });

    await build(deps).settle('pout_1', 'UTR123');

    expect(deps.tx.commissionPayout.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ status: 'paid', payoutReference: 'UTR123' }),
    );
    // Only the approved rows — a second delivery finds nothing left to move.
    expect(deps.tx.bookingCommission.updateMany).toHaveBeenCalledWith({
      where: { payoutId: 'payout-1', status: 'approved' },
      data: { status: 'paid' },
    });
  });

  /**
   * Deductions become ledger entries here, not when the batch claimed them.
   * A claimed deduction on a draft batch is a claim, and rejecting the batch
   * gives it back — booking it earlier would put a movement that never
   * happened into an append-only table.
   */
  it('books each recovered deduction once the money has actually moved', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findFirst.mockResolvedValue({
      id: 'payout-1',
      proId: 'pro-1',
      status: 'processing',
      paidAt: null,
      netAmount: decimal('14500.00'),
    });
    deps.prisma.payoutDeduction.findMany.mockResolvedValue([
      {
        id: 'ded-1',
        consumedAmount: decimal('300.00'),
        reason: 'Reversal of booking HMG-000644',
      },
    ]);

    await build(deps).settle('pout_1', 'UTR123');

    expect(deps.ledger.recordDeductionRecovered).toHaveBeenCalledWith({
      deductionId: 'ded-1',
      proId: 'pro-1',
      payoutId: 'payout-1',
      amount: '300.00',
      reason: 'Reversal of booking HMG-000644',
    });
  });

  it('does nothing on a redelivery', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findFirst.mockResolvedValue({
      id: 'payout-1',
      status: 'paid',
      paidAt: new Date(),
      netAmount: decimal('14500.00'),
    });

    await build(deps).settle('pout_1', 'UTR123');

    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ignores a confirmation for a payout that is not ours', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findFirst.mockResolvedValue(null);

    await expect(build(deps).settle('pout_x', 'UTR')).resolves.toBeUndefined();
  });
});

describe('markFailed', () => {
  it('leaves the commissions unpaid, because nothing moved', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findFirst.mockResolvedValue({
      id: 'payout-1',
      status: 'processing',
    });

    await build(deps).markFailed('pout_1', 'Beneficiary account closed');

    expect(deps.prisma.commissionPayout.update.mock.calls[0][0].data).toEqual({
      status: 'failed',
      failureReason: 'Beneficiary account closed',
    });
    expect(deps.tx.bookingCommission.updateMany).not.toHaveBeenCalled();
  });

  it('will not un-pay a payout that already settled', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findFirst.mockResolvedValue({
      id: 'payout-1',
      status: 'paid',
    });

    await build(deps).markFailed('pout_1', 'late failure event');

    expect(deps.prisma.commissionPayout.update).not.toHaveBeenCalled();
  });
});

describe('retry', () => {
  it('only works from failed', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.updateMany.mockResolvedValue({ count: 0 });
    deps.prisma.commissionPayout.findUnique.mockResolvedValue({
      id: 'payout-1',
      status: 'processing',
    });

    expect(await statusOf(build(deps).retry('payout-1', 'admin-1'))).toBe(
      HttpStatus.CONFLICT,
    );
    expect(deps.razorpayx.createPayout).not.toHaveBeenCalled();
  });

  it('resubmits a failed batch', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.updateMany.mockResolvedValue({ count: 1 });
    deps.prisma.commissionPayout.findUnique.mockResolvedValue(
      anApprovedPayout(),
    );

    await build(deps).retry('payout-1', 'admin-1');

    expect(deps.razorpayx.createPayout).toHaveBeenCalled();
  });
});
