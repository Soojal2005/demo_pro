import { DashboardService } from './dashboard.service';

const ALL_PERMISSIONS = [
  'customer.moderate',
  'pro.moderate',
  'pro.application.review',
  'booking.read',
  'dispatch.override',
  'payment.cash.handover.confirm',
  'payout.read',
  'ledger.read',
  'review.moderate',
];

function buildDeps(permissionCodes: string[] = ALL_PERMISSIONS) {
  const prisma = {
    role: { findUnique: jest.fn().mockResolvedValue({ permissionCodes }) },
    // `findMany` is mocked purely so the counting test below can prove it was
    // never reached. The service must never list customers to size them.
    customer: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    pro: { count: jest.fn().mockResolvedValue(0) },
    booking: {
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    proApplication: {
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    cashHandover: { count: jest.fn().mockResolvedValue(0) },
    commissionPayout: { count: jest.fn().mockResolvedValue(0) },
    review: { count: jest.fn().mockResolvedValue(0) },
  };
  const ledger = {
    dashboard: jest.fn().mockResolvedValue({
      today: { collected: '100.00', refunded: '0.00', net: '100.00' },
      allTime: { grossRevenue: '5000.00' },
      owedToPros: '900.00',
      cashHeldByPros: '250.00',
    }),
  };
  return { prisma, ledger };
}

function build(deps: ReturnType<typeof buildDeps>): DashboardService {
  return new DashboardService(deps.prisma as never, deps.ledger as never);
}

const CALL = { roleId: 'role-1', days: 7 };

describe('DashboardService · what each role is shown', () => {
  /**
   * The permission model is the response shape. An absent section means "not
   * for you" — which is why every one of these asserts absence, not zero.
   */
  it('gives a super admin every section', async () => {
    const deps = buildDeps();
    const summary = await build(deps).summary(CALL);

    expect(summary.money).toBeDefined();
    expect(summary.bookings).toBeDefined();
    expect(summary.applications).toBeDefined();
    expect(summary.chart).toBeDefined();
    expect(summary.totals.customers).toBeDefined();
  });

  it('never hands an ops admin the money section', async () => {
    const deps = buildDeps([
      'pro.moderate',
      'booking.read',
      'dispatch.override',
    ]);
    const summary = await build(deps).summary(CALL);

    expect(summary.money).toBeUndefined();
    expect(deps.ledger.dashboard).not.toHaveBeenCalled();
    // Still gets the queue it is responsible for clearing.
    expect(summary.needsAttention.stuckBookings).toBeDefined();
  });

  it('does not show a finance admin the dispatch queue', async () => {
    const deps = buildDeps(['ledger.read', 'payout.read']);
    const summary = await build(deps).summary(CALL);

    expect(summary.money).toBeDefined();
    expect(summary.needsAttention.payoutsFailed).toBeDefined();
    expect(summary.needsAttention.stuckBookings).toBeUndefined();
    expect(summary.bookings).toBeUndefined();
  });

  it('returns an empty dashboard rather than failing for a role with nothing', async () => {
    const deps = buildDeps([]);
    const summary = await build(deps).summary(CALL);

    expect(summary.needsAttention).toEqual({});
    expect(summary.totals).toEqual({});
    expect(summary.money).toBeUndefined();
  });

  it('treats a caller with no role as having no grants', async () => {
    const deps = buildDeps();
    const summary = await build(deps).summary({ days: 7 });

    expect(deps.prisma.role.findUnique).not.toHaveBeenCalled();
    expect(summary.totals).toEqual({});
  });
});

describe('DashboardService · counting', () => {
  /**
   * The whole reason this endpoint exists: the console used to fetch a list and
   * read `.length`, and every admin list here is capped at 100.
   */
  it('counts rather than listing', async () => {
    const deps = buildDeps();
    await build(deps).summary(CALL);

    expect(deps.prisma.customer.count).toHaveBeenCalled();
    expect(deps.prisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('reads the previous figure by cutting createdAt, not by guessing', async () => {
    const deps = buildDeps();
    await build(deps).summary(CALL);

    const wheres = deps.prisma.customer.count.mock.calls.map(
      (call: [{ where: Record<string, unknown> }]) => call[0].where,
    );
    expect(wheres.some((w) => 'createdAt' in w)).toBe(true);
    expect(wheres.some((w) => !('createdAt' in w))).toBe(true);
  });

  it('scopes every figure to the caller’s cities', async () => {
    const deps = buildDeps();
    await build(deps).summary({ ...CALL, cityScope: ['city-indore'] });

    expect(deps.prisma.pro.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ cityId: { in: ['city-indore'] } }),
      }),
    );
    expect(deps.prisma.booking.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          address: { cityId: { in: ['city-indore'] } },
        }),
      }),
    );
  });

  it('leaves a platform-wide admin unscoped', async () => {
    const deps = buildDeps();
    await build(deps).summary({ ...CALL, cityScope: [] });

    expect(deps.prisma.pro.count).toHaveBeenCalledWith({ where: {} });
  });
});

describe('DashboardService · the activity chart', () => {
  /**
   * A quiet day has to survive as a zero. Dropping it would slide every later
   * point one column left and make the chart lie about when work happened.
   */
  it('emits one column per day even when nothing happened', async () => {
    const deps = buildDeps();
    const summary = await build(deps).summary({ ...CALL, days: 7 });

    expect(summary.chart).toHaveLength(7);
    expect(summary.chart?.every((day) => day.upcoming === 0)).toBe(true);
  });

  it('buckets a booking into the day it was created', async () => {
    const deps = buildDeps();
    const today = new Date();
    deps.prisma.booking.findMany.mockResolvedValue([
      { createdAt: today, status: 'completed' },
      { createdAt: today, status: 'cancelled' },
      { createdAt: today, status: 'assigned' },
      { createdAt: today, status: 'en_route' },
    ]);

    const summary = await build(deps).summary(CALL);
    const last = summary.chart?.at(-1);

    expect(last).toMatchObject({
      completed: 1,
      cancelled: 1,
      upcoming: 1,
      ongoing: 1,
    });
  });

  it('ignores a booking older than the window rather than misfiling it', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findMany.mockResolvedValue([
      { createdAt: new Date('2020-01-01'), status: 'completed' },
    ]);

    const summary = await build(deps).summary(CALL);

    expect(summary.chart?.every((day) => day.completed === 0)).toBe(true);
  });
});

describe('DashboardService · booking breakdown', () => {
  /** `awaiting_payment` is upcoming to an operator — it just is not paid yet. */
  it('folds the pre-arrival statuses into upcoming and the live ones into ongoing', async () => {
    const deps = buildDeps();
    deps.prisma.booking.groupBy.mockResolvedValue([
      { status: 'created', _count: { _all: 2 } },
      { status: 'awaiting_payment', _count: { _all: 1 } },
      { status: 'assigned', _count: { _all: 3 } },
      { status: 'en_route', _count: { _all: 4 } },
      { status: 'started', _count: { _all: 5 } },
      { status: 'completed', _count: { _all: 6 } },
      { status: 'cancelled', _count: { _all: 7 } },
    ]);

    const summary = await build(deps).summary(CALL);

    expect(summary.bookings).toEqual({
      upcoming: 6,
      ongoing: 9,
      completed: 6,
      cancelled: 7,
    });
  });
});
