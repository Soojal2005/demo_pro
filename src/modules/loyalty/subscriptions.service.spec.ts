import { HttpException, HttpStatus } from '@nestjs/common';
import { NO_SUBSCRIPTION, SubscriptionsService } from './subscriptions.service';

const PLAN = {
  id: 'plan-1',
  code: 'homingo_plus',
  name: 'Homingo Plus',
  tier: 'gold',
  priceAmount: '499.00',
  durationDays: 90,
  discountPercent: '10.00',
  maxDiscountAmount: '200.00',
  coinEarnMultiplier: '2.00',
  bonusCoins: 500,
  waivesCancellationFee: true,
  extraReschedules: 2,
  includedBookings: null as number | null,
  isActive: true,
};

function buildPrisma() {
  return {
    subscriptionPlan: {
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(PLAN)),
      findMany: jest.fn(() => Promise.resolve([PLAN])),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'plan-new', ...data }),
      ),
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ ...PLAN, ...data }),
      ),
    },
    customerSubscription: {
      // Widened for the same reason as the plan mocks: Jest infers the
      // narrowest return type, and a mock seeded with `null` would refuse a
      // later `mockResolvedValue(row)`.
      findUnique: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      findFirst: jest.fn((): Promise<unknown> => Promise.resolve(null)),
      findMany: jest.fn((): Promise<unknown[]> => Promise.resolve([])),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'sub-1', ...data }),
      ),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => Promise.resolve({ id: where.id, customerId: 'cust-1', ...data }),
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
    },
  };
}

function buildWallet() {
  return { move: jest.fn(() => Promise.resolve({ id: 'wt-1' })) };
}

function build(prisma = buildPrisma(), wallet = buildWallet()) {
  return {
    prisma,
    wallet,
    service: new SubscriptionsService(prisma as never, wallet as never),
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

describe('SubscriptionsService · buying', () => {
  it('creates a pending row that entitles the customer to nothing', async () => {
    // Two steps on purpose: an entitlement created in the same call that takes
    // payment would be live before the payment cleared, and a failed checkout
    // would leave a customer discounted for free.
    const { service } = build();

    const subscription = await service.purchase('cust-1', 'plan-1');

    expect(subscription.status).toBe('pending_payment');
    // No window, so nothing is entitled: `perksFor` only ever looks at
    // `status = active`.
    expect(subscription.activatedAt).toBeUndefined();
  });

  it('freezes the perks at purchase, so the customer agrees to what they get', async () => {
    const { service } = build();

    const subscription = await service.purchase('cust-1', 'plan-1');

    expect(subscription).toMatchObject({
      pricePaid: '499.00',
      discountPercent: '10.00',
      coinEarnMultiplier: '2.00',
      waivesCancellationFee: true,
      extraReschedules: 2,
    });
  });

  it('refuses a second plan while one is live', async () => {
    const { service, prisma } = build();
    prisma.customerSubscription.findFirst.mockResolvedValue({
      id: 'sub-old',
      status: 'active',
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    await expect(statusOf(service.purchase('cust-1', 'plan-1'))).resolves.toBe(
      HttpStatus.CONFLICT,
    );
  });

  it('refuses a retired plan', async () => {
    const { service, prisma } = build();
    prisma.subscriptionPlan.findUnique.mockResolvedValue({
      ...PLAN,
      isActive: false,
    });

    await expect(statusOf(service.purchase('cust-1', 'plan-1'))).resolves.toBe(
      HttpStatus.CONFLICT,
    );
  });
});

describe('SubscriptionsService · activation', () => {
  const pending = {
    id: 'sub-1',
    customerId: 'cust-1',
    planId: 'plan-1',
    status: 'pending_payment',
  };

  it('sets the window from the plan duration and grants the welcome coins', async () => {
    const { service, prisma, wallet } = build();
    prisma.customerSubscription.findUnique.mockResolvedValue(pending);
    const now = new Date('2026-08-19T12:00:00.000Z');

    const activated = await service.activate('sub-1', 'pay_abc', now);

    expect(activated.status).toBe('active');
    expect(activated.expiresAt).toEqual(
      new Date('2026-11-17T12:00:00.000Z'), // 90 days
    );
    expect(wallet.move).toHaveBeenCalledWith(
      expect.objectContaining({ coins: 500, type: 'subscription_bonus' }),
    );
  });

  it('is idempotent — a redelivered confirmation does not extend or re-pay', async () => {
    const { service, prisma, wallet } = build();
    const active = { ...pending, status: 'active', expiresAt: new Date() };
    prisma.customerSubscription.findUnique.mockResolvedValue(active);

    const result = await service.activate('sub-1', 'pay_abc');

    expect(result).toBe(active);
    expect(prisma.customerSubscription.update).not.toHaveBeenCalled();
    expect(wallet.move).not.toHaveBeenCalled();
  });

  it('refuses to reactivate a cancelled subscription', async () => {
    const { service, prisma } = build();
    prisma.customerSubscription.findUnique.mockResolvedValue({
      ...pending,
      status: 'cancelled',
    });

    await expect(statusOf(service.activate('sub-1'))).resolves.toBe(
      HttpStatus.CONFLICT,
    );
  });

  it('stays live when the welcome coins fail to credit', async () => {
    // The subscription is bought and paid for. A bonus that did not land is
    // worth a log and a support fix, never a customer who paid and got
    // nothing.
    const { service, prisma, wallet } = build();
    prisma.customerSubscription.findUnique.mockResolvedValue(pending);
    wallet.move.mockRejectedValue(new Error('wallet unreachable'));

    await expect(service.activate('sub-1')).resolves.toMatchObject({
      status: 'active',
    });
  });
});

describe('SubscriptionsService · what a plan is worth', () => {
  const active = {
    id: 'sub-1',
    customerId: 'cust-1',
    planId: 'plan-1',
    status: 'active',
    discountPercent: '10.00',
    maxDiscountAmount: { toString: () => '200.00' },
    coinEarnMultiplier: '2.00',
    waivesCancellationFee: true,
    extraReschedules: 2,
    includedBookings: null as number | null,
    bookingsUsed: 0,
    expiresAt: new Date(Date.now() + 86_400_000),
  };

  it('returns the frozen perks, not the live plan', async () => {
    const { service, prisma } = build();
    prisma.customerSubscription.findFirst.mockResolvedValue(active);

    await expect(service.perksFor('cust-1')).resolves.toMatchObject({
      subscriptionId: 'sub-1',
      discountPercent: 10,
      coinEarnMultiplier: 2,
      waivesCancellationFee: true,
      extraReschedules: 2,
    });
  });

  it('gives a customer with no plan the honest default rather than null', async () => {
    // Returning null would let a caller read `undefined` as a discount.
    const { service } = build();

    await expect(service.perksFor('cust-1')).resolves.toEqual(NO_SUBSCRIPTION);
  });

  it('treats a lapsed subscription as gone, whatever the stored status says', async () => {
    // Reading a stale `active` row as live would discount a booking against a
    // plan that ended last night.
    const { service, prisma } = build();
    prisma.customerSubscription.findFirst.mockResolvedValue({
      ...active,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(service.perksFor('cust-1')).resolves.toEqual(NO_SUBSCRIPTION);
    expect(prisma.customerSubscription.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'expired' } }),
    );
  });

  it('stops the per-booking discount once the allowance is spent', async () => {
    const { service, prisma } = build();
    prisma.customerSubscription.findFirst.mockResolvedValue({
      ...active,
      includedBookings: 10,
      bookingsUsed: 10,
    });

    const perks = await service.perksFor('cust-1');

    expect(perks.discountPercent).toBe(0);
    expect(perks.bookingsRemaining).toBe(0);
    // An exhausted allowance is not an expired plan: the multiplier, the fee
    // waiver and the extra reschedules all still apply.
    expect(perks.coinEarnMultiplier).toBe(2);
    expect(perks.waivesCancellationFee).toBe(true);
    expect(perks.extraReschedules).toBe(2);
  });

  it('reports an unlimited plan as having no remaining count', async () => {
    const { service, prisma } = build();
    prisma.customerSubscription.findFirst.mockResolvedValue(active);

    await expect(service.perksFor('cust-1')).resolves.toMatchObject({
      bookingsRemaining: null,
    });
  });
});

describe('SubscriptionsService · the allowance counter', () => {
  it('never decrements below zero, which the CHECK constraint also refuses', async () => {
    const { service, prisma } = build();

    await service.releaseBookingUse('sub-1');

    expect(prisma.customerSubscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sub-1', bookingsUsed: { gt: 0 } },
      }),
    );
  });
});

describe('SubscriptionsService · cancelling', () => {
  it('records who stopped it and why, and computes no refund', async () => {
    // What a part-used plan is worth back is a judgement, not a formula — the
    // same reasoning that keeps window-E booking refunds off a calculator.
    const { service, prisma } = build();
    prisma.customerSubscription.findUnique.mockResolvedValue({
      id: 'sub-1',
      status: 'active',
      activatedAt: new Date(),
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const cancelled = await service.cancel('sub-1', 'moved away', 'admin-1');

    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelReason: 'moved away',
      cancelledByAdminId: 'admin-1',
    });
  });

  it('gives a never-activated subscription the window the CHECK requires', async () => {
    const { service, prisma } = build();
    prisma.customerSubscription.findUnique.mockResolvedValue({
      id: 'sub-1',
      status: 'pending_payment',
      activatedAt: null,
    });

    const cancelled = await service.cancel('sub-1', 'checkout abandoned');

    // It was live for no time at all, which is the truth.
    expect(cancelled.activatedAt).toBeInstanceOf(Date);
    expect(cancelled.expiresAt).toBeInstanceOf(Date);
  });

  it('is idempotent', async () => {
    const { service, prisma } = build();
    const already = { id: 'sub-1', status: 'cancelled' };
    prisma.customerSubscription.findUnique.mockResolvedValue(already);

    await expect(service.cancel('sub-1', 'again')).resolves.toBe(already);
    expect(prisma.customerSubscription.update).not.toHaveBeenCalled();
  });
});

describe('SubscriptionsService · the catalogue', () => {
  it('offers global plans everywhere and city plans only in their city', async () => {
    const { service, prisma } = build();

    await service.listPurchasablePlans('city-1');

    expect(prisma.subscriptionPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isActive: true, OR: [{ cityId: null }, { cityId: 'city-1' }] },
      }),
    );
  });

  it('offers only global plans to a customer with no city', async () => {
    const { service, prisma } = build();

    await service.listPurchasablePlans(null);

    expect(prisma.subscriptionPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true, cityId: null } }),
    );
  });
});
