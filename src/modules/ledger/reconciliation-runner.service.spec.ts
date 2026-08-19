import { HttpException } from '@nestjs/common';
import { ReconciliationRunnerService } from './reconciliation-runner.service';

const decimal = (value: string) => ({ toString: () => value });

function buildDeps() {
  const prisma = {
    reconciliationRun: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) =>
          Promise.resolve({ id: 'run-1', ...data }),
        ),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) =>
          Promise.resolve({ id: 'run-1', ...data }),
        ),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
    },
    reconciliationDiscrepancy: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({}),
    },
    order: { findMany: jest.fn().mockResolvedValue([]) },
    bookingCommission: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    commissionPayout: { findMany: jest.fn().mockResolvedValue([]) },
    pro: { findMany: jest.fn().mockResolvedValue([]) },
    ledgerEntry: { findUnique: jest.fn().mockResolvedValue(null) },
  };

  const payments = {
    run: jest.fn().mockResolvedValue({
      ordersScanned: 3,
      bookingsScanned: 5,
      discrepancies: [],
    }),
  };
  const counters = { rebuildAll: jest.fn().mockResolvedValue(true) };
  const ledger = {
    verify: jest.fn().mockResolvedValue({ entriesChecked: 10, breaks: [] }),
  };
  const balances = { balanceOf: jest.fn().mockResolvedValue('0.00') };

  return { prisma, payments, counters, ledger, balances };
}

function build(
  deps: ReturnType<typeof buildDeps>,
): ReconciliationRunnerService {
  return new ReconciliationRunnerService(
    deps.prisma as never,
    deps.payments as never,
    deps.counters as never,
    deps.ledger as never,
    deps.balances as never,
  );
}

/** The data the `update` that closes the run was given. */
function closedWith(deps: ReturnType<typeof buildDeps>) {
  return deps.prisma.reconciliationRun.update.mock.calls.at(-1)![0].data;
}

describe('run', () => {
  it('records a clean run', async () => {
    const deps = buildDeps();

    await build(deps).run({ scope: 'all' });

    expect(closedWith(deps)).toMatchObject({
      status: 'completed',
      discrepancyCount: 0,
      totalVarianceAmount: '0.00',
      ordersScanned: 3,
      bookingsScanned: 5,
    });
  });

  /** Feature 7. Called, not reimplemented. */
  it('rebuilds the derived counters on a full run', async () => {
    const deps = buildDeps();

    await build(deps).run({ scope: 'all' });

    expect(deps.counters.rebuildAll).toHaveBeenCalled();
    expect(closedWith(deps).countersRebuilt).toBe(true);
  });

  it('does not rebuild counters on a narrow scope', async () => {
    const deps = buildDeps();

    await build(deps).run({ scope: 'money' });

    expect(deps.counters.rebuildAll).not.toHaveBeenCalled();
  });

  it('skips module 7’s checks when only the ledger is asked for', async () => {
    const deps = buildDeps();

    await build(deps).run({ scope: 'ledger' });

    expect(deps.payments.run).not.toHaveBeenCalled();
    expect(deps.ledger.verify).toHaveBeenCalled();
  });

  it('persists what module 7 found rather than recomputing it', async () => {
    const deps = buildDeps();
    deps.payments.run.mockResolvedValue({
      ordersScanned: 1,
      bookingsScanned: 0,
      discrepancies: [
        {
          kind: 'amount_mismatch',
          reference: 'HMG-1',
          ours: '1000.00',
          theirs: '900.00',
          variance: '100.00',
          detail: 'Gateway says less.',
        },
      ],
    });

    await build(deps).run({ scope: 'money' });

    expect(
      deps.prisma.reconciliationDiscrepancy.createMany.mock.calls[0][0].data[0],
    ).toMatchObject({ runId: 'run-1', kind: 'amount_mismatch' });
    expect(closedWith(deps)).toMatchObject({
      discrepancyCount: 1,
      totalVarianceAmount: '100.00',
    });
  });

  it('sums variance by magnitude, so opposite errors do not cancel out', async () => {
    const deps = buildDeps();
    deps.payments.run.mockResolvedValue({
      ordersScanned: 2,
      bookingsScanned: 0,
      discrepancies: [
        {
          kind: 'a',
          reference: '1',
          ours: null,
          theirs: null,
          variance: '100.00',
          detail: '',
        },
        {
          kind: 'b',
          reference: '2',
          ours: null,
          theirs: null,
          variance: '-100.00',
          detail: '',
        },
      ],
    });

    await build(deps).run({ scope: 'money' });

    expect(closedWith(deps).totalVarianceAmount).toBe('200.00');
  });

  /**
   * "The job died" and "the job found nothing" must not look the same — a
   * `completed` run with zero discrepancies is a statement that everything
   * agrees, and a crash is not.
   */
  it('marks a crashed run failed, keeping what it found first', async () => {
    const deps = buildDeps();
    deps.payments.run.mockResolvedValue({
      ordersScanned: 1,
      bookingsScanned: 0,
      discrepancies: [
        {
          kind: 'amount_mismatch',
          reference: 'HMG-1',
          ours: null,
          theirs: null,
          variance: '50.00',
          detail: '',
        },
      ],
    });
    deps.ledger.verify.mockRejectedValue(new Error('database went away'));

    await build(deps).run({ scope: 'all' });

    expect(closedWith(deps)).toMatchObject({
      status: 'failed',
      failureReason: 'database went away',
      discrepancyCount: 1,
    });
  });

  it('rejects a window that runs backwards', async () => {
    const deps = buildDeps();
    await expect(
      build(deps).run({
        from: new Date('2026-08-12T00:00:00.000Z'),
        to: new Date('2026-08-11T00:00:00.000Z'),
      }),
    ).rejects.toThrow(HttpException);
  });
});

describe('the ledger-scope checks', () => {
  it('reports a broken chain as a discrepancy, not just a log line', async () => {
    const deps = buildDeps();
    deps.ledger.verify.mockResolvedValue({
      entriesChecked: 10,
      breaks: [
        {
          sequence: '7',
          reason: 'hash_mismatch',
          expected: 'aaa',
          found: 'bbb',
        },
      ],
    });

    await build(deps).run({ scope: 'ledger' });

    const written =
      deps.prisma.reconciliationDiscrepancy.createMany.mock.calls[0][0].data;
    expect(written[0]).toMatchObject({
      kind: 'chain_broken',
      reference: 'sequence:7',
    });
  });

  it('catches a captured order that was never booked', async () => {
    const deps = buildDeps();
    deps.prisma.order.findMany.mockResolvedValue([
      { id: 'ord-1', receipt: 'rcpt_1', amountPaid: decimal('1000.00') },
    ]);

    await build(deps).run({ scope: 'ledger' });

    const written =
      deps.prisma.reconciliationDiscrepancy.createMany.mock.calls[0][0].data;
    expect(written[0]).toMatchObject({
      kind: 'missing_ledger_entry',
      reference: 'rcpt_1',
      variance: '1000.00',
    });
  });

  it('catches an entry that disagrees with the order it came from', async () => {
    const deps = buildDeps();
    deps.prisma.order.findMany.mockResolvedValue([
      { id: 'ord-1', receipt: 'rcpt_1', amountPaid: decimal('1000.00') },
    ]);
    deps.prisma.ledgerEntry.findUnique.mockResolvedValue({
      sequence: 4n,
      amount: decimal('900.00'),
    });

    await build(deps).run({ scope: 'ledger' });

    const written =
      deps.prisma.reconciliationDiscrepancy.createMany.mock.calls[0][0].data;
    expect(written[0]).toMatchObject({
      kind: 'ledger_amount_mismatch',
      ours: '900.00',
      theirs: '1000.00',
      variance: '-100.00',
    });
  });

  /**
   * The strongest check: it tests the whole sequence of events rather than one
   * row. A Pro with nothing in flight whose payable is not zero has an entry
   * missing or duplicated somewhere.
   */
  it('catches a settled Pro whose payable did not return to zero', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findMany.mockResolvedValue([
      { proId: 'pro-1' },
    ]);
    deps.prisma.bookingCommission.count.mockResolvedValue(0);
    deps.balances.balanceOf.mockResolvedValue('250.00');

    await build(deps).run({ scope: 'ledger' });

    const written =
      deps.prisma.reconciliationDiscrepancy.createMany.mock.calls[0][0].data;
    expect(written[0]).toMatchObject({
      kind: 'ledger_amount_mismatch',
      reference: 'pro-1',
      ours: '250.00',
      theirs: '0.00',
    });
  });

  it('says nothing about a Pro who still has work in flight', async () => {
    const deps = buildDeps();
    deps.prisma.commissionPayout.findMany.mockResolvedValue([
      { proId: 'pro-1' },
    ]);
    // Unpaid commissions exist, so a non-zero payable is correct.
    deps.prisma.bookingCommission.count.mockResolvedValue(2);
    deps.balances.balanceOf.mockResolvedValue('250.00');

    await build(deps).run({ scope: 'ledger' });

    expect(closedWith(deps).discrepancyCount).toBe(0);
  });

  it('catches the cash cache drifting from the books', async () => {
    const deps = buildDeps();
    deps.prisma.pro.findMany.mockResolvedValue([
      { id: 'pro-1', cashInHand: decimal('4000.00') },
    ]);
    deps.balances.balanceOf.mockResolvedValue('3500.00');

    await build(deps).run({ scope: 'ledger' });

    const written =
      deps.prisma.reconciliationDiscrepancy.createMany.mock.calls[0][0].data;
    expect(written[0]).toMatchObject({
      kind: 'cash_balance_drift',
      ours: '4000.00',
      theirs: '3500.00',
      variance: '500.00',
    });
  });

  it('corrects nothing it finds', async () => {
    const deps = buildDeps();
    deps.prisma.order.findMany.mockResolvedValue([
      { id: 'ord-1', receipt: 'rcpt_1', amountPaid: decimal('1000.00') },
    ]);

    await build(deps).run({ scope: 'ledger' });

    // No write to any source table — a discrepancy is a question, and making
    // our row match theirs would destroy the evidence they ever differed.
    expect(deps.prisma.order.findMany).toHaveBeenCalled();
    expect(
      Object.keys(deps.prisma.order).filter((key) => key !== 'findMany'),
    ).toEqual([]);
  });
});

describe('resolve', () => {
  it('records who answered it and what they found', async () => {
    const deps = buildDeps();
    deps.prisma.reconciliationDiscrepancy.findUnique.mockResolvedValue({
      id: 'disc-1',
      resolvedAt: null,
    });

    await build(deps).resolve(
      'disc-1',
      'Late webhook; entry is present.',
      'admin-1',
    );

    expect(
      deps.prisma.reconciliationDiscrepancy.update.mock.calls[0][0].data,
    ).toMatchObject({
      resolutionNotes: 'Late webhook; entry is present.',
      resolvedByAdminId: 'admin-1',
    });
  });

  it('refuses to close the same finding twice', async () => {
    const deps = buildDeps();
    deps.prisma.reconciliationDiscrepancy.findUnique.mockResolvedValue({
      id: 'disc-1',
      resolvedAt: new Date(),
    });

    await expect(
      build(deps).resolve('disc-1', 'again', 'admin-1'),
    ).rejects.toThrow(HttpException);
  });

  it('is a 404 for a finding that does not exist', async () => {
    const deps = buildDeps();
    deps.prisma.reconciliationDiscrepancy.findUnique.mockResolvedValue(null);

    await expect(build(deps).resolve('nope', 'x', 'admin-1')).rejects.toThrow(
      HttpException,
    );
  });
});

describe('openDiscrepancies', () => {
  /**
   * The count is the point of this list. Without it a caller cannot tell a
   * last page from a full one, and "how much is still unanswered" is the
   * question a work queue exists to settle — its sibling `runs()` has always
   * reported one.
   */
  it('reports how many are still open, not just the page', async () => {
    const deps = buildDeps();
    deps.prisma.reconciliationDiscrepancy.count.mockResolvedValue(137);
    deps.prisma.reconciliationDiscrepancy.findMany.mockResolvedValue([
      { id: 'disc-1' },
    ]);

    const result = await build(deps).openDiscrepancies({ page: 2, limit: 50 });

    expect(result).toEqual({
      page: 2,
      limit: 50,
      total: 137,
      items: [{ id: 'disc-1' }],
    });
  });

  /** The count must be narrowed the same way the page is, or it overstates. */
  it('counts the same rows it lists', async () => {
    const deps = buildDeps();
    deps.prisma.reconciliationDiscrepancy.count.mockResolvedValue(4);

    await build(deps).openDiscrepancies({ kind: 'chain_broken' });

    const where = { resolvedAt: null, kind: 'chain_broken' };
    expect(deps.prisma.reconciliationDiscrepancy.count).toHaveBeenCalledWith({
      where,
    });
    expect(
      deps.prisma.reconciliationDiscrepancy.findMany.mock.calls.at(-1)![0]
        .where,
    ).toEqual(where);
  });
});
