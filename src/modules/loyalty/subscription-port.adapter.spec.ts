import { HttpException, HttpStatus } from '@nestjs/common';
import { SubscriptionPortAdapter } from './subscription-port.adapter';

function pending(overrides: Record<string, unknown> = {}) {
  return {
    id: 'sub-1',
    customerId: 'cust-1',
    status: 'pending_payment',
    paymentMode: 'online',
    pricePaid: { toString: () => '699.00' },
    plan: { code: 'homingo_gold', name: 'Homingo Gold' },
    ...overrides,
  };
}

function build() {
  const prisma = {
    customerSubscription: {
      findFirst: jest.fn((): Promise<unknown> => Promise.resolve(pending())),
    },
  };
  const subscriptions = {
    findActive: jest.fn((): Promise<unknown> => Promise.resolve(null)),
    activate: jest.fn(() => Promise.resolve({ id: 'sub-1', status: 'active' })),
  };
  return {
    prisma,
    subscriptions,
    adapter: new SubscriptionPortAdapter(
      prisma as never,
      subscriptions as never,
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

describe('SubscriptionPortAdapter · pricing before checkout', () => {
  it('prices from the frozen amount, not the live plan', async () => {
    // A repricing between choosing a plan and paying for it must not change
    // what the customer was quoted.
    const { adapter } = build();

    await expect(
      adapter.getPurchasable('sub-1', 'cust-1'),
    ).resolves.toMatchObject({
      id: 'sub-1',
      planCode: 'homingo_gold',
      planName: 'Homingo Gold',
      pricePaid: '699.00',
    });
  });

  it("hides someone else's subscription behind the same 404", async () => {
    // Ownership is in the `where`, so a different customer's id is
    // indistinguishable from one that does not exist — otherwise this endpoint
    // enumerates subscription ids.
    const { adapter, prisma } = build();
    prisma.customerSubscription.findFirst.mockResolvedValue(null);

    await expect(
      statusOf(adapter.getPurchasable('sub-1', 'someone-else')),
    ).resolves.toBe(HttpStatus.NOT_FOUND);
    expect(prisma.customerSubscription.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sub-1', customerId: 'someone-else' },
      }),
    );
  });

  it('refuses a plan that is already active', async () => {
    const { adapter, prisma } = build();
    prisma.customerSubscription.findFirst.mockResolvedValue(
      pending({ status: 'active' }),
    );

    await expect(
      statusOf(adapter.getPurchasable('sub-1', 'cust-1')),
    ).resolves.toBe(HttpStatus.CONFLICT);
  });

  it('refuses a cancelled plan', async () => {
    const { adapter, prisma } = build();
    prisma.customerSubscription.findFirst.mockResolvedValue(
      pending({ status: 'cancelled' }),
    );

    await expect(
      statusOf(adapter.getPurchasable('sub-1', 'cust-1')),
    ).resolves.toBe(HttpStatus.CONFLICT);
  });

  it('refuses a complimentary plan — there is nothing to pay', async () => {
    const { adapter, prisma } = build();
    prisma.customerSubscription.findFirst.mockResolvedValue(
      pending({ paymentMode: 'complimentary' }),
    );

    await expect(
      statusOf(adapter.getPurchasable('sub-1', 'cust-1')),
    ).resolves.toBe(HttpStatus.CONFLICT);
  });

  it('refuses when the customer already has a live plan', async () => {
    // A customer can create a pending plan, buy a different one, then come
    // back to pay for the first. Charging them for a plan the database would
    // then refuse to activate is the worst possible order of events — so this
    // is checked here, before any gateway order exists.
    const { adapter, subscriptions } = build();
    subscriptions.findActive.mockResolvedValue({ id: 'sub-other' });

    await expect(
      statusOf(adapter.getPurchasable('sub-1', 'cust-1')),
    ).resolves.toBe(HttpStatus.CONFLICT);
  });
});

describe('SubscriptionPortAdapter · activation on capture', () => {
  it('goes through the same activate the admin route uses', async () => {
    // One activation path means one place where the window is set and the
    // welcome coins are granted — and it is already idempotent, which is what
    // makes a redelivered webhook safe.
    const { adapter, subscriptions } = build();

    await adapter.activateFromPayment('sub-1', 'pay_MkT9v2Xy');

    expect(subscriptions.activate).toHaveBeenCalledWith(
      'sub-1',
      'pay_MkT9v2Xy',
    );
  });
});
