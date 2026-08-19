import { HttpException } from '@nestjs/common';
import { CashCollectionService } from './cash-collection.service';

function buildDeps() {
  const tx = {
    booking: { update: jest.fn() },
    pro: { update: jest.fn() },
  };
  const prisma = {
    booking: { findUnique: jest.fn(), update: jest.fn() },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const ledger = { recordCashCollection: jest.fn() };
  const support = { raiseBillingTicket: jest.fn() };
  return { prisma, tx, ledger, support };
}

function build(deps: ReturnType<typeof buildDeps>): CashCollectionService {
  return new CashCollectionService(
    deps.prisma as never,
    deps.ledger as never,
    deps.support,
  );
}

const decimal = (value: string) => ({ toString: () => value });

function aBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bk-1',
    bookingNumber: 'HB-2026-000123',
    proId: 'pro-1',
    customerId: 'cust-1',
    paymentMode: 'cash',
    status: 'completed',
    flatPrice: decimal('599.00'),
    payableAmount: decimal('599.00'),
    cashCollectedAt: null,
    cashDeclinedAt: null,
    ...overrides,
  };
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    throw new Error('expected a rejection');
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
}

describe('CashCollectionService · collect', () => {
  /**
   * Feature 13's hardest rule. A Pro who could name the amount could
   * under-declare and pocket the difference, and no reconciliation would find
   * it — the booking would agree with the ledger and both would be wrong.
   */
  it('records the booking’s flat price, and takes no amount from the caller', async () => {
    const deps = buildDeps();
    const booking = aBooking();
    deps.prisma.booking.findUnique.mockResolvedValue(booking);
    deps.tx.booking.update.mockResolvedValue(
      aBooking({
        cashCollectedAmount: decimal('599.00'),
        cashCollectedAt: new Date(),
      }),
    );

    await build(deps).collect('pro-1', 'bk-1');

    // What reaches the column is the booking's own frozen `payableAmount`, by
    // identity — not a figure derived from anything the caller supplied.
    // `collect` takes no amount parameter at all, which the compiler enforces.
    const written = deps.tx.booking.update.mock.calls[0][0].data;
    expect(written.cashCollectedAmount).toBe(booking.payableAmount);
    expect(written.paymentStatus).toBe('paid');
  });

  it('increments the Pro’s balance in the same transaction as the booking', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(aBooking());
    deps.tx.booking.update.mockResolvedValue(
      aBooking({ cashCollectedAmount: decimal('599.00') }),
    );

    await build(deps).collect('pro-1', 'bk-1');

    expect(deps.prisma.$transaction).toHaveBeenCalled();
    expect(deps.tx.pro.update).toHaveBeenCalledWith({
      where: { id: 'pro-1' },
      data: { cashInHand: { increment: expect.anything() } },
    });
  });

  it('is idempotent — a double tap does not collect twice', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aBooking({
        cashCollectedAt: new Date(),
        cashCollectedAmount: decimal('599.00'),
      }),
    );

    await build(deps).collect('pro-1', 'bk-1');

    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(deps.tx.pro.update).not.toHaveBeenCalled();
  });

  it('refuses collection on an online booking', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aBooking({ paymentMode: 'online' }),
    );

    expect(await statusOf(build(deps).collect('pro-1', 'bk-1'))).toBe(409);
  });

  it('refuses collection before the Pro is at the door', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aBooking({ status: 'en_route' }),
    );

    expect(await statusOf(build(deps).collect('pro-1', 'bk-1'))).toBe(409);
  });

  it('hides a booking belonging to another Pro behind a 404', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aBooking({ proId: 'pro-2' }),
    );

    expect(await statusOf(build(deps).collect('pro-1', 'bk-1'))).toBe(404);
  });
});

describe('CashCollectionService · decline', () => {
  /**
   * Feature 17. The Pro did the work; the customer's refusal is not theirs to
   * carry. Nothing here may touch the balance, the job or the commission.
   */
  it('leaves the booking unpaid, the balance untouched, and raises a ticket', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(aBooking());
    deps.prisma.booking.update.mockResolvedValue(
      aBooking({ cashDeclinedAt: new Date(), cashDeclinedReason: 'refused' }),
    );

    await build(deps).decline('pro-1', 'bk-1', 'Customer refused to pay');

    const written = deps.prisma.booking.update.mock.calls[0][0].data;
    expect(written).not.toHaveProperty('paymentStatus');
    expect(written).not.toHaveProperty('cashCollectedAmount');
    expect(deps.tx.pro.update).not.toHaveBeenCalled();
    expect(deps.support.raiseBillingTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: 'bk-1',
        proId: 'pro-1',
        amount: '599.00',
      }),
    );
  });

  it('refuses to declare a decline after cash was already collected', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aBooking({ cashCollectedAt: new Date() }),
    );

    expect(
      await statusOf(build(deps).decline('pro-1', 'bk-1', 'changed my mind')),
    ).toBe(409);
  });

  it('is idempotent', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue(
      aBooking({ cashDeclinedAt: new Date() }),
    );

    await build(deps).decline('pro-1', 'bk-1', 'refused');

    expect(deps.prisma.booking.update).not.toHaveBeenCalled();
  });
});
