import { HttpException, HttpStatus } from '@nestjs/common';
import { ReferralsService } from './referrals.service';

function buildPrisma() {
  // Hoisted so `update` can read the current row back without the object
  // referring to itself, which TypeScript cannot infer a type through.
  const referralFindUnique = jest.fn(
    (): Promise<Record<string, unknown> | null> => Promise.resolve(null),
  );

  const prisma = {
    referralCode: {
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'rc-1',
          totalReferrals: 0,
          qualifiedCount: 0,
          totalCoinsEarned: 0,
          isBlocked: false,
          ...data,
        }),
      ),
      update: jest.fn(() => Promise.resolve({})),
    },
    referral: {
      findUnique: referralFindUnique,
      findMany: jest.fn((): Promise<unknown[]> => Promise.resolve([])),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'ref-1', ...data }),
      ),
      // Merged over the current row, because Prisma's `update` returns the
      // **whole** record and `payOut` reads the frozen coin amounts off it. A
      // mock returning only the changed fields would make both credits
      // silently skip, and the test would pass for the wrong reason.
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }): Promise<Record<string, unknown>> =>
          referralFindUnique().then((row) => ({
            ...(row ?? {}),
            id: where.id,
            ...data,
          })),
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
      count: jest.fn(() => Promise.resolve(0)),
    },
    booking: { count: jest.fn(() => Promise.resolve(0)) },
  };

  return prisma;
}

function buildWallet() {
  return { move: jest.fn(() => Promise.resolve({ id: 'wt-1' })) };
}

const SETTINGS: Record<string, number> = {
  'referral.referrerCoins': 200,
  'referral.refereeCoins': 100,
  'referral.qualifyWindowDays': 60,
  'referral.maxPerReferrer': 50,
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
  prisma = buildPrisma(),
  wallet = buildWallet(),
  settings = buildSettings(),
) {
  return {
    prisma,
    wallet,
    settings,
    service: new ReferralsService(
      prisma as never,
      wallet as never,
      settings as never,
    ),
  };
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
  throw new Error('Expected the call to reject, but it resolved');
}

describe('ReferralsService · the code', () => {
  it('mints one on first ask, from an alphabet without 0/O or 1/I/L', async () => {
    const { service, prisma } = build();

    await service.getOrCreateCode('cust-1');

    const created = prisma.referralCode.create.mock.calls[0][0].data as {
      code: string;
    };
    // The alphabet is the point: this code is read aloud across a kitchen
    // table and typed by someone who has had the app four minutes.
    expect(created.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });

  it('returns the existing one rather than minting a second', async () => {
    const { service, prisma } = build();
    prisma.referralCode.findUnique.mockResolvedValue({
      id: 'rc-1',
      code: 'HM4K2P',
    });

    const code = await service.getOrCreateCode('cust-1');

    expect(code.code).toBe('HM4K2P');
    expect(prisma.referralCode.create).not.toHaveBeenCalled();
  });
});

describe('ReferralsService · attribution', () => {
  const ownerCode = {
    id: 'rc-owner',
    customerId: 'referrer-1',
    code: 'HM4K2P',
    qualifiedCount: 0,
    isBlocked: false,
  };

  it('records a pending referral and freezes what was promised', async () => {
    const { service, prisma } = build();
    prisma.referralCode.findUnique.mockResolvedValue(ownerCode);

    const referral = await service.attribute('referee-1', 'hm4k-2p');

    expect(referral).toMatchObject({
      referrerId: 'referrer-1',
      refereeId: 'referee-1',
      code: 'HM4K2P',
      status: 'pending',
      // Frozen at attribution: a settings change must not alter what a pending
      // referral was promised.
      referrerCoins: 200,
      refereeCoins: 100,
    });
    // Nothing is credited yet. A signup costs an attacker nothing.
    expect(build().wallet.move).not.toHaveBeenCalled();
  });

  it('refuses a malformed code before touching the database', async () => {
    const { service, prisma } = build();

    await expect(
      statusOf(service.attribute('referee-1', 'nope')),
    ).resolves.toBe(HttpStatus.BAD_REQUEST);
    expect(prisma.referralCode.findUnique).not.toHaveBeenCalled();
  });

  it('refuses an unknown code', async () => {
    const { service } = build();

    await expect(
      statusOf(service.attribute('referee-1', 'ZZZZZZ')),
    ).resolves.toBe(HttpStatus.NOT_FOUND);
  });

  it('refuses a self-referral — the cheapest attack there is', async () => {
    const { service, prisma } = build();
    prisma.referralCode.findUnique.mockResolvedValue({
      ...ownerCode,
      customerId: 'referee-1',
    });

    await expect(
      statusOf(service.attribute('referee-1', 'HM4K2P')),
    ).resolves.toBe(HttpStatus.UNPROCESSABLE_ENTITY);
  });

  it('refuses a second code for the same customer, ever', async () => {
    const { service, prisma } = build();
    prisma.referral.findUnique.mockResolvedValue({ id: 'ref-old' });

    await expect(
      statusOf(service.attribute('referee-1', 'HM4K2P')),
    ).resolves.toBe(HttpStatus.CONFLICT);
  });

  it('refuses a blocked code without explaining someone else’s standing', async () => {
    const { service, prisma } = build();
    prisma.referralCode.findUnique.mockResolvedValue({
      ...ownerCode,
      isBlocked: true,
    });

    await expect(
      statusOf(service.attribute('referee-1', 'HM4K2P')),
    ).resolves.toBe(HttpStatus.CONFLICT);
  });

  it('refuses a code that has hit its lifetime cap', async () => {
    const { service, prisma } = build();
    prisma.referralCode.findUnique.mockResolvedValue({
      ...ownerCode,
      qualifiedCount: 50,
    });

    await expect(
      statusOf(service.attribute('referee-1', 'HM4K2P')),
    ).resolves.toBe(HttpStatus.CONFLICT);
  });

  it('refuses an account that has already had work done', async () => {
    const { service, prisma } = build();
    prisma.referralCode.findUnique.mockResolvedValue(ownerCode);
    prisma.booking.count.mockResolvedValue(3);

    await expect(
      statusOf(service.attribute('referee-1', 'HM4K2P')),
    ).resolves.toBe(HttpStatus.CONFLICT);
  });

  it('does not punish a cancelled first attempt', async () => {
    // Counted against completed jobs, not against any booking, so a customer
    // whose first booking fell through can still use a friend's code.
    const { service, prisma } = build();
    prisma.referralCode.findUnique.mockResolvedValue(ownerCode);
    prisma.booking.count.mockResolvedValue(0);

    await expect(
      service.attribute('referee-1', 'HM4K2P'),
    ).resolves.toMatchObject({ status: 'pending' });
    expect(prisma.booking.count).toHaveBeenCalledWith({
      where: { customerId: 'referee-1', status: 'completed' },
    });
  });
});

describe('ReferralsService · the reward', () => {
  const pending = {
    id: 'ref-1',
    referrerId: 'referrer-1',
    refereeId: 'referee-1',
    code: 'HM4K2P',
    status: 'pending',
    referrerCoins: 200,
    refereeCoins: 100,
    expiresAt: new Date(Date.now() + 86_400_000),
  };

  const booking = {
    id: 'bk-1',
    customerId: 'referee-1',
    bookingNumber: 'HB-2026-000412',
  };

  it('pays both sides when the referee’s first job completes', async () => {
    const { service, prisma, wallet } = build();
    prisma.referral.findUnique.mockResolvedValue(pending);

    const result = await service.onBookingCompleted(booking);

    expect(result?.status).toBe('rewarded');
    expect(wallet.move).toHaveBeenCalledTimes(2);
    expect(wallet.move).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'referrer-1', coins: 200 }),
    );
    expect(wallet.move).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'referee-1', coins: 100 }),
    );
  });

  it('names the booking that qualified it, which the database also requires', async () => {
    const { service, prisma } = build();
    prisma.referral.findUnique.mockResolvedValue(pending);

    await service.onBookingCompleted(booking);

    const [qualifyCall] = prisma.referral.update.mock.calls[0];
    expect(qualifyCall.data.qualifyingBookingId).toBe('bk-1');
  });

  it('does nothing for a customer nobody referred', async () => {
    const { service, wallet } = build();

    await expect(service.onBookingCompleted(booking)).resolves.toBeNull();
    expect(wallet.move).not.toHaveBeenCalled();
  });

  it('does not pay a second time on a second completed booking', async () => {
    const { service, prisma, wallet } = build();
    prisma.referral.findUnique.mockResolvedValue({
      ...pending,
      status: 'rewarded',
    });

    await expect(service.onBookingCompleted(booking)).resolves.toBeNull();
    expect(wallet.move).not.toHaveBeenCalled();
  });

  it('expires rather than pays a referral whose window has closed', async () => {
    const { service, prisma, wallet } = build();
    prisma.referral.findUnique.mockResolvedValue({
      ...pending,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(service.onBookingCompleted(booking)).resolves.toBeNull();
    expect(wallet.move).not.toHaveBeenCalled();
    expect(prisma.referral.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'expired' } }),
    );
  });

  it('leaves the referral qualified when the coins do not credit', async () => {
    const { service, prisma, wallet } = build();
    prisma.referral.findUnique.mockResolvedValue(pending);
    wallet.move.mockRejectedValue(new Error('wallet unreachable'));

    const result = await service.onBookingCompleted(booking);

    // The referral is genuinely earned and the customer is owed it. The sweep
    // finds it and tries again — moving it to `rewarded` here would lose it.
    expect(result?.status).toBe('qualified');
  });

  it('retries a stuck referral on the sweep', async () => {
    const { service, prisma, wallet } = build();
    prisma.referral.findMany.mockResolvedValue([
      {
        ...pending,
        status: 'qualified',
        qualifyingBooking: { bookingNumber: 'HB-1' },
      },
    ]);

    const result = await service.sweep();

    expect(wallet.move).toHaveBeenCalledTimes(2);
    expect(result.paid).toBe(1);
  });

  it('closes windows that passed without a booking', async () => {
    const { service, prisma } = build();
    prisma.referral.updateMany.mockResolvedValue({ count: 4 });

    await expect(service.sweep()).resolves.toMatchObject({ expired: 4 });
  });
});

describe('ReferralsService · ops', () => {
  it('refuses to reject a referral that has already been paid', async () => {
    const { service, prisma } = build();
    prisma.referral.findUnique.mockResolvedValue({
      id: 'ref-1',
      status: 'rewarded',
    });

    // Reversing credited coins is a wallet adjustment, so it appears in the
    // customer's statement with a reason rather than vanishing.
    await expect(statusOf(service.reject('ref-1', 'duplicate'))).resolves.toBe(
      HttpStatus.CONFLICT,
    );
  });

  it('rejects a pending one with a reason, which the database also requires', async () => {
    const { service, prisma } = build();
    prisma.referral.findUnique.mockResolvedValue({
      id: 'ref-1',
      status: 'pending',
    });

    await expect(
      service.reject('ref-1', 'duplicate account'),
    ).resolves.toMatchObject({
      status: 'rejected',
      rejectedReason: 'duplicate account',
    });
  });
});

describe('ReferralsService · the share screen', () => {
  it('states the qualifying window up front', async () => {
    // A referral that silently never pays is the single most common complaint
    // this feature generates, so both sides are told the rule before they
    // share anything.
    const { service, prisma } = build();
    prisma.referralCode.findUnique.mockResolvedValue({
      id: 'rc-1',
      code: 'HM4K2P',
      totalReferrals: 12,
      qualifiedCount: 7,
      totalCoinsEarned: 1400,
      isBlocked: false,
    });

    const summary = await service.summarise('cust-1');

    expect(summary).toMatchObject({
      code: 'HM4K2P',
      referrerCoins: 200,
      refereeCoins: 100,
      qualifyWindowDays: 60,
      totalReferrals: 12,
      qualifiedCount: 7,
    });
    expect(summary.shareMessage).toContain('HM4K2P');
  });
});
