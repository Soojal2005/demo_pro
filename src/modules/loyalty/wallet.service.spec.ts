import { HttpException, HttpStatus } from '@nestjs/common';
import { WalletService } from './wallet.service';

/**
 * An in-memory stand-in for the wallet row and its log, with the balance
 * arithmetic the real transaction does.
 *
 * `lockWallet` runs raw SQL, so `$queryRaw` is what has to be faked rather
 * than a Prisma model call — which is exactly what the row lock is, and
 * pretending otherwise would test a different function.
 */
function buildPrisma(initialBalance = 0) {
  const wallet = {
    id: 'wal-1',
    customerId: 'cust-1',
    balanceCoins: initialBalance,
    lifetimeEarnedCoins: 0,
    lifetimeRedeemedCoins: 0,
    lifetimeExpiredCoins: 0,
    tier: 'bronze',
  };
  const transactions: Record<string, unknown>[] = [];

  const tx = {
    $queryRaw: jest.fn(() =>
      Promise.resolve([{ id: wallet.id, balanceCoins: wallet.balanceCoins }]),
    ),
    walletTransaction: {
      findUnique: jest.fn(({ where }: { where: { sourceRef: string } }) =>
        Promise.resolve(
          transactions.find((row) => row.sourceRef === where.sourceRef) ?? null,
        ),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `wt-${transactions.length + 1}`, ...data };
        transactions.push(row);
        return Promise.resolve(row);
      }),
    },
    customerWallet: {
      upsert: jest.fn(() => Promise.resolve(wallet)),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        if (typeof data.balanceCoins === 'number') {
          wallet.balanceCoins = data.balanceCoins;
        }
        return Promise.resolve(wallet);
      }),
    },
  };

  return {
    wallet,
    transactions,
    tx,
    $transaction: jest.fn((fn: (client: unknown) => unknown) => fn(tx)),
    // Return types are widened deliberately: Jest infers the narrowest type
    // from the factory, so a mock seeded with `null` would refuse a later
    // `mockResolvedValue(row)` in a single test.
    walletTransaction: {
      findUnique: tx.walletTransaction.findUnique,
      findMany: jest.fn((): Promise<unknown[]> => Promise.resolve([])),
      aggregate: jest.fn((): Promise<{ _sum: { coins: number | null } }> =>
        Promise.resolve({ _sum: { coins: 0 } }),
      ),
      update: jest.fn((): Promise<unknown> => Promise.resolve({})),
    },
    customerWallet: {
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(wallet)),
      update: jest.fn((): Promise<unknown> => Promise.resolve(wallet)),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    booking: { count: jest.fn(() => Promise.resolve(0)) },
    customerSubscription: {
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
    },
  };
}

const SETTINGS: Record<string, number> = {
  'wallet.coinValueRupees': 1,
  'wallet.maxRedemptionPercent': 20,
  'wallet.coinExpiryDays': 365,
  'wallet.earnRatePercent.bronze': 3,
  'wallet.earnRatePercent.silver': 5,
  'wallet.earnRatePercent.gold': 7,
  'wallet.earnRatePercent.platinum': 10,
  'wallet.tierThreshold.silver': 5,
  'wallet.tierThreshold.gold': 15,
  'wallet.tierThreshold.platinum': 40,
};

function buildSettings(overrides: Record<string, number> = {}) {
  const values = { ...SETTINGS, ...overrides };
  return {
    values,
    getNumber: jest.fn((key: string, fallback: number) =>
      Promise.resolve(values[key] ?? fallback),
    ),
  };
}

function build(
  prisma: ReturnType<typeof buildPrisma>,
  settings = buildSettings(),
) {
  return new WalletService(prisma as never, settings as never);
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
  throw new Error('Expected the call to reject, but it resolved');
}

describe('WalletService · moving coins', () => {
  it('credits and records the balance the movement produced', async () => {
    const prisma = buildPrisma(100);

    const moved = await build(prisma).move({
      customerId: 'cust-1',
      type: 'earn',
      coins: 25,
      reason: '25 coins',
      sourceRef: 'earn:bk-1',
    });

    expect(moved.balanceAfter).toBe(125);
    expect(prisma.wallet.balanceCoins).toBe(125);
  });

  it('debits', async () => {
    const prisma = buildPrisma(300);

    const moved = await build(prisma).move({
      customerId: 'cust-1',
      type: 'redeem',
      coins: -200,
      reason: 'spent',
      sourceRef: 'redeem:bk-1',
    });

    expect(moved.balanceAfter).toBe(100);
  });

  it('refuses to overdraw — coins are not credit', async () => {
    const prisma = buildPrisma(50);

    await expect(
      statusOf(
        build(prisma).move({
          customerId: 'cust-1',
          type: 'redeem',
          coins: -200,
          reason: 'spent',
          sourceRef: 'redeem:bk-1',
        }),
      ),
    ).resolves.toBe(HttpStatus.CONFLICT);

    expect(prisma.wallet.balanceCoins).toBe(50);
  });

  it('is idempotent — a retried credit returns the first row, not a second', async () => {
    const prisma = buildPrisma(0);
    const service = build(prisma);
    const input = {
      customerId: 'cust-1',
      type: 'earn' as const,
      coins: 25,
      reason: '25 coins',
      sourceRef: 'earn:bk-1',
    };

    const first = await service.move(input);
    const second = await service.move(input);

    expect(second.id).toBe(first.id);
    // The whole point: a redelivered completion must not pay twice.
    expect(prisma.wallet.balanceCoins).toBe(25);
    expect(prisma.transactions).toHaveLength(1);
  });

  it('refuses a movement of nothing', async () => {
    // A zero row would make `balanceAfter` ambiguous when two land in the same
    // millisecond, and the database refuses one too.
    await expect(
      build(buildPrisma()).move({
        customerId: 'cust-1',
        type: 'earn',
        coins: 0,
        reason: 'nothing',
        sourceRef: 'earn:bk-1',
      }),
    ).rejects.toThrow(/Refusing a wallet movement/);
  });

  it('refuses a fraction of a coin', async () => {
    await expect(
      build(buildPrisma()).move({
        customerId: 'cust-1',
        type: 'earn',
        coins: 2.5,
        reason: 'half',
        sourceRef: 'earn:bk-1',
      }),
    ).rejects.toThrow(/Refusing a wallet movement/);
  });

  it('dates a credit for expiry and leaves a debit undated', async () => {
    const prisma = buildPrisma(500);
    const service = build(prisma);

    await service.move({
      customerId: 'cust-1',
      type: 'earn',
      coins: 25,
      reason: 'earned',
      sourceRef: 'earn:bk-1',
    });
    await service.move({
      customerId: 'cust-1',
      type: 'redeem',
      coins: -25,
      reason: 'spent',
      sourceRef: 'redeem:bk-1',
    });

    expect(prisma.transactions[0].expiresAt).toBeInstanceOf(Date);
    expect(prisma.transactions[1].expiresAt).toBeNull();
  });

  it('never expires a credit when expiry is switched off', async () => {
    const prisma = buildPrisma();

    await build(prisma, buildSettings({ 'wallet.coinExpiryDays': 0 })).move({
      customerId: 'cust-1',
      type: 'earn',
      coins: 25,
      reason: 'earned',
      sourceRef: 'earn:bk-1',
    });

    expect(prisma.transactions[0].expiresAt).toBeNull();
  });
});

describe('WalletService · earning on a completed booking', () => {
  const booking = {
    id: 'bk-1',
    customerId: 'cust-1',
    payableAmount: '500.00',
    bookingNumber: 'HB-2026-000412',
    subscriptionId: null,
  };

  it('earns at the tier the customer is in', async () => {
    const prisma = buildPrisma();
    // Four completed before this one, so this is the fifth — silver.
    prisma.booking.count.mockResolvedValue(5);

    const moved = await build(prisma).creditForCompletedBooking(booking);

    expect(moved?.coins).toBe(25);
    expect(moved?.reason).toContain('silver');
  });

  it('counts the job being completed, so the fifth booking earns at silver', async () => {
    // `countCompletedBookings` runs after the transition, so the completing
    // job is already in the count. Rewarding the fifth at the fourth's rate is
    // the kind of detail that generates support tickets.
    const prisma = buildPrisma();
    prisma.booking.count.mockResolvedValue(4);

    const moved = await build(prisma).creditForCompletedBooking(booking);

    expect(moved?.coins).toBe(15);
    expect(moved?.reason).toContain('bronze');
  });

  it('multiplies for a subscriber', async () => {
    const prisma = buildPrisma();
    prisma.booking.count.mockResolvedValue(5);
    prisma.customerSubscription.findUnique.mockResolvedValue({
      coinEarnMultiplier: 2,
    });

    const moved = await build(prisma).creditForCompletedBooking({
      ...booking,
      subscriptionId: 'sub-1',
    });

    expect(moved?.coins).toBe(50);
    expect(moved?.reason).toContain('2× subscriber bonus');
  });

  it('earns on what was paid, not on the list price', async () => {
    // A customer who paid ₹400 of a ₹500 job with coins earns on the ₹400.
    // Earning on the list price would let a large balance recycle itself
    // upward every booking, which is a loop that pays itself.
    const prisma = buildPrisma();
    prisma.booking.count.mockResolvedValue(1);

    const moved = await build(prisma).creditForCompletedBooking({
      ...booking,
      payableAmount: '400.00',
    });

    expect(moved?.coins).toBe(12);
  });

  it('writes no row for a job too small to earn a coin', async () => {
    const prisma = buildPrisma();
    prisma.booking.count.mockResolvedValue(1);

    const moved = await build(prisma).creditForCompletedBooking({
      ...booking,
      payableAmount: '19.00',
    });

    expect(moved).toBeNull();
    expect(prisma.transactions).toHaveLength(0);
  });

  it('is idempotent per booking', async () => {
    const prisma = buildPrisma();
    prisma.booking.count.mockResolvedValue(5);
    const service = build(prisma);

    await service.creditForCompletedBooking(booking);
    await service.creditForCompletedBooking(booking);

    expect(prisma.transactions).toHaveLength(1);
    expect(prisma.wallet.balanceCoins).toBe(25);
  });
});

describe('WalletService · adjustments', () => {
  it('carries the admin who made it, which the database also requires', async () => {
    const prisma = buildPrisma();

    await build(prisma).adjust({
      customerId: 'cust-1',
      coins: 250,
      reason: 'Goodwill — Pro arrived late',
      adminId: 'admin-1',
      adjustmentId: 'adj-1',
    });

    expect(prisma.transactions[0].adjustedByAdminId).toBe('admin-1');
  });

  it('never expires — an apology with a fuse on it is a second complaint', async () => {
    const prisma = buildPrisma();

    await build(prisma).adjust({
      customerId: 'cust-1',
      coins: 250,
      reason: 'Goodwill',
      adminId: 'admin-1',
      adjustmentId: 'adj-1',
    });

    expect(prisma.transactions[0].expiresAt).toBeNull();
  });

  it('is idempotent on the supplied adjustment id', async () => {
    const prisma = buildPrisma();
    const service = build(prisma);
    const input = {
      customerId: 'cust-1',
      coins: 250,
      reason: 'Goodwill',
      adminId: 'admin-1',
      adjustmentId: 'adj-1',
    };

    await service.adjust(input);
    await service.adjust(input);

    expect(prisma.transactions).toHaveLength(1);
  });
});

describe('WalletService · the balance is a cache and the log is the truth', () => {
  it('takes the log when the two disagree', async () => {
    const prisma = buildPrisma(999);
    prisma.walletTransaction.aggregate.mockResolvedValue({
      _sum: { coins: 120 },
    });

    const result = await build(prisma).rebuildBalance('cust-1');

    expect(result).toMatchObject({ before: 999, after: 120, drifted: true });
    expect(prisma.customerWallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ balanceCoins: 120 }),
      }),
    );
  });

  it('reports no drift when they agree', async () => {
    const prisma = buildPrisma(120);
    prisma.walletTransaction.aggregate.mockResolvedValue({
      _sum: { coins: 120 },
    });

    await expect(build(prisma).rebuildBalance('cust-1')).resolves.toMatchObject(
      { drifted: false },
    );
  });

  it('has nothing to rebuild for a customer who never earned a coin', async () => {
    const prisma = buildPrisma();
    prisma.customerWallet.findUnique.mockResolvedValue(null);

    await expect(build(prisma).rebuildBalance('cust-9')).resolves.toMatchObject(
      { after: 0, drifted: false },
    );
  });
});

describe('WalletService · expiry', () => {
  it('debits a lapsed credit and names the grant that lapsed', async () => {
    const prisma = buildPrisma(300);
    prisma.walletTransaction.findMany.mockResolvedValue([
      {
        id: 'wt-old',
        customerId: 'cust-1',
        coins: 100,
        createdAt: new Date('2025-08-19T00:00:00Z'),
      },
    ]);

    const result = await build(prisma).expireLapsedCoins();

    expect(result).toEqual({ expired: 1, coins: 100 });
    expect(prisma.transactions[0].reason).toContain('2025-08-19');
    // The statement explains the loss rather than showing a balance that fell
    // for no visible reason.
    expect(prisma.transactions[0].coins).toBe(-100);
  });

  it('cannot expire coins the customer already spent', async () => {
    const prisma = buildPrisma(30);
    prisma.walletTransaction.findMany.mockResolvedValue([
      {
        id: 'wt-old',
        customerId: 'cust-1',
        coins: 100,
        createdAt: new Date('2025-08-19T00:00:00Z'),
      },
    ]);

    const result = await build(prisma).expireLapsedCoins();

    expect(result.coins).toBe(30);
    expect(prisma.wallet.balanceCoins).toBe(0);
  });

  it('marks a fully spent credit done rather than revisiting it forever', async () => {
    const prisma = buildPrisma(0);
    prisma.walletTransaction.findMany.mockResolvedValue([
      {
        id: 'wt-old',
        customerId: 'cust-1',
        coins: 100,
        createdAt: new Date('2025-08-19T00:00:00Z'),
      },
    ]);

    const result = await build(prisma).expireLapsedCoins();

    expect(result).toEqual({ expired: 1, coins: 0 });
    expect(prisma.walletTransaction.update).toHaveBeenCalled();
  });
});

describe('WalletService · the wallet screen', () => {
  it('says which tier, and how far the next one is', async () => {
    const prisma = buildPrisma(640);
    prisma.booking.count.mockResolvedValue(7);

    const summary = await build(prisma).summarise('cust-1');

    expect(summary).toMatchObject({
      balanceCoins: 640,
      balanceValue: '640.00',
      tier: 'silver',
      nextTier: 'gold',
      bookingsToNextTier: 8,
      earnRatePercent: 5,
    });
  });

  it('stops offering a next tier at platinum', async () => {
    const prisma = buildPrisma(0);
    prisma.booking.count.mockResolvedValue(100);

    const summary = await build(prisma).summarise('cust-1');

    expect(summary.nextTier).toBeNull();
    expect(summary.bookingsToNextTier).toBeNull();
  });

  it('answers for a customer who has no wallet row yet', async () => {
    const prisma = buildPrisma();
    prisma.customerWallet.findUnique.mockResolvedValue(null);

    await expect(build(prisma).summarise('cust-9')).resolves.toMatchObject({
      balanceCoins: 0,
      tier: 'bronze',
    });
  });
});
