import { HttpException } from '@nestjs/common';
import { CommissionReversalService } from './commission-reversal.service';

const decimal = (value: string) => ({ toString: () => value });

function buildDeps() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    bookingCommission: { update: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    bookingCommission: { findUnique: jest.fn() },
    payoutDeduction: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((callback: (client: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
  };

  const raised: Record<string, unknown>[] = [];
  const deductions = {
    raise: jest.fn().mockImplementation((input: Record<string, unknown>) => {
      // Mirrors the real service: a repeat of the same dedupe key returns the
      // row that already exists rather than creating a second one.
      const existing = raised.find((row) => row.dedupeKey === input.dedupeKey);
      if (existing) return Promise.resolve(existing);
      raised.push(input);
      return Promise.resolve({ id: `ded-${raised.length}`, ...input });
    }),
  };

  const incentives = { unwindForCommission: jest.fn().mockResolvedValue([]) };
  const commissions = { refreshTotals: jest.fn().mockResolvedValue(undefined) };
  const ledger = { recordReversal: jest.fn().mockResolvedValue(undefined) };

  return { prisma, tx, deductions, incentives, commissions, ledger, raised };
}

function build(deps: ReturnType<typeof buildDeps>): CommissionReversalService {
  return new CommissionReversalService(
    deps.prisma as never,
    deps.deductions as never,
    deps.incentives as never,
    deps.commissions as never,
    deps.ledger as never,
  );
}

function aCommission(overrides: Record<string, unknown> = {}) {
  return {
    id: 'comm-1',
    bookingId: 'bk-1',
    proId: 'pro-1',
    status: 'approved',
    reversedAt: null,
    commissionAmount: decimal('300.00'),
    incentiveAmount: decimal('0.00'),
    ...overrides,
  };
}

describe('reversing before the money has gone', () => {
  it('marks the row reversed and raises no deduction', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.findUnique.mockResolvedValue(aCommission());

    const outcome = await build(deps).reverse('comm-1', 'Refunded', 'admin-1');

    expect(outcome.effect).toBe('dropped');
    expect(outcome.deductedAmount).toBe('0.00');
    expect(deps.deductions.raise).not.toHaveBeenCalled();
    expect(deps.tx.bookingCommission.update.mock.calls[0][0].data.status).toBe(
      'reversed',
    );
  });

  it('detaches it from a draft batch so the batch stops paying for it', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.findUnique.mockResolvedValue(
      aCommission({ payoutId: 'payout-1' }),
    );

    await build(deps).reverse('comm-1', 'Refunded', 'admin-1');

    const { data } = deps.tx.bookingCommission.update.mock.calls[0][0];
    expect(data.payoutId).toBeNull();
    expect(data.incentiveAmount).toBe('0');
  });
});

describe('reversing after the money has gone', () => {
  it('leaves the row paid and raises a deduction instead', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.findUnique.mockResolvedValue(
      aCommission({ status: 'paid' }),
    );

    const outcome = await build(deps).reverse('comm-1', 'Refunded', 'admin-1');

    expect(outcome.effect).toBe('deducted');
    expect(outcome.deductedAmount).toBe('300.00');
    // It WAS paid. Saying otherwise would make the payout it sat in stop
    // adding up.
    expect(deps.tx.bookingCommission.update.mock.calls[0][0].data.status).toBe(
      'paid',
    );
  });

  /** US-8.14, the whole point of the mechanism. */
  it('never debits — the recovery is a deduction row and nothing else', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.findUnique.mockResolvedValue(
      aCommission({ status: 'paid' }),
    );

    await build(deps).reverse('comm-1', 'Refunded', 'admin-1');

    expect(deps.deductions.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        proId: 'pro-1',
        amount: '300.00',
        kind: 'commission_reversal',
        dedupeKey: 'commission_reversal:comm-1',
      }),
    );
  });

  it('recovers an already-credited bonus as its own itemised deduction', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.findUnique.mockResolvedValue(
      aCommission({ status: 'paid' }),
    );
    deps.incentives.unwindForCommission.mockResolvedValue([
      {
        progressId: 'prog-1',
        incentiveName: '50-job bonus',
        rewardAmount: '2000.00',
      },
    ]);

    const outcome = await build(deps).reverse('comm-1', 'Refunded', 'admin-1');

    expect(outcome.deductedAmount).toBe('2300.00');
    expect(outcome.unwoundIncentives).toEqual(['50-job bonus']);
    expect(deps.deductions.raise).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'incentive_unwind',
        amount: '2000.00',
        dedupeKey: 'incentive_unwind:prog-1',
      }),
    );
  });
});

describe('reversing twice', () => {
  /**
   * The trap this guards. A reversed row that was already paid keeps `paid`,
   * so checking `status === 'reversed'` would let the second call through and
   * charge the Pro for the same job twice.
   */
  it('does nothing the second time, even though the status still says paid', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.findUnique.mockResolvedValue(
      aCommission({ status: 'paid', reversedAt: new Date() }),
    );
    deps.prisma.payoutDeduction.findMany.mockResolvedValue([
      {
        kind: 'commission_reversal',
        amount: decimal('300.00'),
        reason: 'Reversal',
      },
    ]);

    const outcome = await build(deps).reverse('comm-1', 'Again', 'admin-1');

    expect(deps.deductions.raise).not.toHaveBeenCalled();
    expect(deps.tx.bookingCommission.update).not.toHaveBeenCalled();
    expect(outcome.effect).toBe('deducted');
    expect(outcome.deductedAmount).toBe('300.00');
  });

  /**
   * A manual deduction an admin raises against the same job also carries this
   * commission's `sourceCommissionId`. Reading it back as though the reversal
   * had raised it turns a `dropped` reversal into a reported `deducted`, at
   * whatever figure the admin happened to type — money this call never charged.
   *
   * Asserted on the query rather than the result: the mock does not honour a
   * `where`, so only the filter itself can prove the narrowing.
   */
  it('reads back only what a reversal raises, not a manual deduction on the same job', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.findUnique.mockResolvedValue(
      aCommission({ status: 'reversed', reversedAt: new Date() }),
    );

    await build(deps).reverse('comm-1', 'Again', 'admin-1');

    expect(deps.prisma.payoutDeduction.findMany).toHaveBeenCalledWith({
      where: {
        sourceCommissionId: 'comm-1',
        kind: { in: ['commission_reversal', 'incentive_unwind'] },
      },
    });
  });

  it('reports "dropped" on a repeat of a reversal that never reached a payout', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.findUnique.mockResolvedValue(
      aCommission({ status: 'reversed', reversedAt: new Date() }),
    );

    const outcome = await build(deps).reverse('comm-1', 'Again', 'admin-1');

    expect(outcome.effect).toBe('dropped');
    expect(deps.deductions.raise).not.toHaveBeenCalled();
  });
});

describe('onRefund', () => {
  it('reverses on a full refund', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.findUnique.mockResolvedValue(aCommission());

    await build(deps).onRefund({
      bookingId: 'bk-1',
      amount: '1000.00',
      isFullRefund: true,
    });

    expect(deps.tx.bookingCommission.update).toHaveBeenCalled();
  });

  /**
   * A partial refund is discretionary goodwill. Taking the Pro's whole pay for
   * a decision somebody else made would punish them for doing the job right.
   */
  it('leaves the commission alone on a partial refund', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.findUnique.mockResolvedValue(aCommission());

    await build(deps).onRefund({
      bookingId: 'bk-1',
      amount: '100.00',
      isFullRefund: false,
    });

    expect(deps.tx.bookingCommission.update).not.toHaveBeenCalled();
    expect(deps.deductions.raise).not.toHaveBeenCalled();
  });

  it('is silent about a refunded booking that never earned anything', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.findUnique.mockResolvedValue(null);

    await expect(
      build(deps).onRefund({
        bookingId: 'bk-1',
        amount: '1000.00',
        isFullRefund: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('reversing something that is not there', () => {
  it('is a 404, not a silent success', async () => {
    const deps = buildDeps();
    deps.prisma.bookingCommission.findUnique.mockResolvedValue(null);

    await expect(build(deps).reverse('nope', 'x', 'admin-1')).rejects.toThrow(
      HttpException,
    );
  });
});
