import { HttpException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { OrdersService } from './orders.service';

const KEY_SECRET = 'test_key_secret';

function buildDeps() {
  const prisma = {
    booking: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    order: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    customer: {
      update: jest.fn(),
      findUnique: jest.fn((): Promise<unknown> =>
        Promise.resolve({
          id: 'cust-1',
          fullName: 'A Customer',
          phone: '+919000000000',
          email: null,
          razorpayCustomerId: 'cust_rzp',
        }),
      ),
    },
  };
  const razorpay = {
    createOrder: jest.fn(),
    fetchPayment: jest.fn(),
    createCustomer: jest.fn(),
    publicKeyId: 'rzp_test_key',
    keySecretForSignature: KEY_SECRET,
  };
  const state = { transition: jest.fn() };
  const settings = { getNumber: jest.fn().mockResolvedValue(15) };
  const dispatch = { requestAssignment: jest.fn() };
  const ledger = { recordCapture: jest.fn() };
  const subscriptions = {
    getPurchasable: jest.fn((): Promise<unknown> =>
      Promise.resolve({
        id: 'sub-1',
        customerId: 'cust-1',
        planCode: 'homingo_gold',
        planName: 'Homingo Gold',
        pricePaid: '699.00',
        status: 'pending_payment',
      }),
    ),
    activateFromPayment: jest.fn((): Promise<void> => Promise.resolve()),
  };
  return { prisma, razorpay, state, settings, dispatch, ledger, subscriptions };
}

function build(deps: ReturnType<typeof buildDeps>): OrdersService {
  return new OrdersService(
    deps.prisma as never,
    deps.razorpay as never,
    deps.state as never,
    deps.settings as never,
    deps.dispatch as never,
    deps.ledger as never,
    deps.subscriptions as never,
  );
}

const decimal = (value: string) => ({ toString: () => value });

function anOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-row-1',
    bookingId: 'bk-1',
    customerId: 'cust-1',
    razorpayOrderId: 'order_ABC',
    status: 'created',
    amount: decimal('599.00'),
    amountPaid: decimal('0.00'),
    capturedPaymentId: null,
    paymentMethod: null,
    paidAt: null,
    failureCode: null,
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

describe('OrdersService · creation', () => {
  it('takes the amount from the booking, never from the caller', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue({
      id: 'bk-1',
      customerId: 'cust-1',
      bookingNumber: 'HB-2026-000123',
      serviceId: 'svc-1',
      paymentMode: 'online',
      status: 'awaiting_payment',
      flatPrice: decimal('599.00'),
      payableAmount: decimal('599.00'),
      customer: {
        id: 'cust-1',
        razorpayCustomerId: 'cust_rzp',
        fullName: 'A',
        phone: '+91',
        email: null,
      },
      address: { cityId: 'city-1' },
    });
    deps.prisma.order.findMany.mockResolvedValue([]);
    deps.razorpay.createOrder.mockResolvedValue({
      id: 'order_ABC',
      currency: 'INR',
    });
    deps.prisma.order.create.mockResolvedValue(anOrder());

    await build(deps).createForBooking('bk-1', 'cust-1');

    // 599.00 rupees, expressed to the gateway in paise.
    expect(deps.razorpay.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 59900 }),
    );
  });

  it('carries booking references in the notes, so a gateway row is traceable', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue({
      id: 'bk-1',
      customerId: 'cust-1',
      bookingNumber: 'HB-2026-000123',
      serviceId: 'svc-1',
      paymentMode: 'online',
      status: 'awaiting_payment',
      flatPrice: decimal('599.00'),
      payableAmount: decimal('599.00'),
      customer: {
        id: 'cust-1',
        razorpayCustomerId: 'c',
        fullName: null,
        phone: null,
        email: null,
      },
      address: { cityId: 'city-1' },
    });
    deps.prisma.order.findMany.mockResolvedValue([]);
    deps.razorpay.createOrder.mockResolvedValue({
      id: 'order_ABC',
      currency: 'INR',
    });
    deps.prisma.order.create.mockResolvedValue(anOrder());

    await build(deps).createForBooking('bk-1', 'cust-1');

    expect(deps.razorpay.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        receipt: 'HB-2026-000123-1',
        notes: {
          bookingId: 'bk-1',
          bookingNumber: 'HB-2026-000123',
          serviceId: 'svc-1',
          cityId: 'city-1',
        },
      }),
    );
  });

  it('refuses to open checkout on a cash booking, which has no order at all', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue({
      id: 'bk-1',
      customerId: 'cust-1',
      paymentMode: 'cash',
      status: 'assigning',
      customer: {},
      address: {},
    });

    expect(await statusOf(build(deps).createForBooking('bk-1', 'cust-1'))).toBe(
      409,
    );
  });

  /** Otherwise this endpoint enumerates other customers' booking ids. */
  it('is indistinguishable between someone else’s booking and none', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue({
      id: 'bk-1',
      customerId: 'someone-else',
      paymentMode: 'online',
      status: 'awaiting_payment',
      customer: {},
      address: {},
    });

    expect(await statusOf(build(deps).createForBooking('bk-1', 'cust-1'))).toBe(
      404,
    );
  });

  it('refuses a second order once one has been paid', async () => {
    const deps = buildDeps();
    deps.prisma.booking.findUnique.mockResolvedValue({
      id: 'bk-1',
      customerId: 'cust-1',
      paymentMode: 'online',
      status: 'awaiting_payment',
      customer: {},
      address: {},
    });
    deps.prisma.order.findMany.mockResolvedValue([anOrder({ status: 'paid' })]);

    expect(await statusOf(build(deps).createForBooking('bk-1', 'cust-1'))).toBe(
      409,
    );
  });
});

describe('OrdersService · verification', () => {
  const base = {
    bookingId: 'bk-1',
    customerId: 'cust-1',
    razorpayOrderId: 'order_ABC',
    razorpayPaymentId: 'pay_XYZ',
  };
  const validSignature = createHmac('sha256', KEY_SECRET)
    .update('order_ABC|pay_XYZ')
    .digest('hex');

  function withOrder(deps: ReturnType<typeof buildDeps>) {
    deps.prisma.order.findUnique.mockResolvedValue(
      anOrder({ status: 'attempted' }),
    );
  }

  it('rejects a claim whose signature does not verify', async () => {
    const deps = buildDeps();
    withOrder(deps);

    const status = await statusOf(
      build(deps).verifyCheckout({ ...base, signature: 'f'.repeat(64) }),
    );

    expect(status).toBe(400);
    expect(deps.razorpay.fetchPayment).not.toHaveBeenCalled();
  });

  /**
   * The core of feature 3. A valid signature proves Razorpay produced this
   * order/payment pair — not that the payment was captured. Trusting it alone
   * would dispatch a Pro against an authorized-but-never-captured payment.
   */
  it('rejects a correctly signed payment that was never captured', async () => {
    const deps = buildDeps();
    withOrder(deps);
    deps.razorpay.fetchPayment.mockResolvedValue({
      id: 'pay_XYZ',
      order_id: 'order_ABC',
      amount: 59900,
      status: 'authorized',
    });

    const status = await statusOf(
      build(deps).verifyCheckout({ ...base, signature: validSignature }),
    );

    expect(status).toBe(409);
    expect(deps.prisma.order.update).not.toHaveBeenCalled();
  });

  it('rejects a correctly signed payment for the wrong amount', async () => {
    const deps = buildDeps();
    withOrder(deps);
    deps.razorpay.fetchPayment.mockResolvedValue({
      id: 'pay_XYZ',
      order_id: 'order_ABC',
      amount: 100,
      status: 'captured',
    });

    expect(
      await statusOf(
        build(deps).verifyCheckout({ ...base, signature: validSignature }),
      ),
    ).toBe(409);
  });

  it('rejects a correctly signed payment belonging to a different order', async () => {
    const deps = buildDeps();
    withOrder(deps);
    deps.razorpay.fetchPayment.mockResolvedValue({
      id: 'pay_XYZ',
      order_id: 'order_SOMEONE_ELSE',
      amount: 59900,
      status: 'captured',
    });

    expect(
      await statusOf(
        build(deps).verifyCheckout({ ...base, signature: validSignature }),
      ),
    ).toBe(409);
  });

  it('accepts only when the gateway itself confirms status, order and amount', async () => {
    const deps = buildDeps();
    withOrder(deps);
    deps.razorpay.fetchPayment.mockResolvedValue({
      id: 'pay_XYZ',
      order_id: 'order_ABC',
      amount: 59900,
      status: 'captured',
      method: 'upi',
    });
    deps.prisma.order.update.mockResolvedValue(
      anOrder({
        status: 'paid',
        capturedPaymentId: 'pay_XYZ',
        amountPaid: decimal('599.00'),
      }),
    );
    deps.prisma.booking.findUnique.mockResolvedValue({
      id: 'bk-1',
      status: 'awaiting_payment',
    });

    await build(deps).verifyCheckout({ ...base, signature: validSignature });

    expect(deps.prisma.order.update).toHaveBeenCalled();
  });
});

describe('OrdersService · applyCapture', () => {
  function paidOrder(deps: ReturnType<typeof buildDeps>) {
    deps.prisma.order.update.mockResolvedValue(
      anOrder({
        status: 'paid',
        capturedPaymentId: 'pay_XYZ',
        amountPaid: decimal('599.00'),
      }),
    );
    deps.prisma.booking.findUnique.mockResolvedValue({
      id: 'bk-1',
      status: 'awaiting_payment',
    });
  }

  const facts = {
    razorpayOrderId: 'order_ABC',
    razorpayPaymentId: 'pay_XYZ',
    amountPaise: 59900,
    method: 'upi',
  };

  it('marks the booking paid and hands it to dispatch on the first capture', async () => {
    const deps = buildDeps();
    deps.prisma.order.findUnique.mockResolvedValue(
      anOrder({ status: 'attempted' }),
    );
    paidOrder(deps);

    await build(deps).applyCapture(facts);

    expect(deps.prisma.booking.update).toHaveBeenCalledWith({
      where: { id: 'bk-1' },
      data: { paymentStatus: 'paid' },
    });
    expect(deps.state.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'assigning',
        expectedFrom: ['awaiting_payment'],
      }),
    );
    expect(deps.dispatch.requestAssignment).toHaveBeenCalledWith('bk-1');
  });

  /**
   * Feature 5. The side effects must run once even though the delivery may
   * arrive five times — and the row itself must come out identical each time.
   */
  it('runs the side effects only on the delivery that moved the status', async () => {
    const deps = buildDeps();
    deps.prisma.order.findUnique.mockResolvedValue(
      anOrder({
        status: 'paid',
        capturedPaymentId: 'pay_XYZ',
        paidAt: new Date('2026-08-11T10:00:00Z'),
      }),
    );
    paidOrder(deps);

    await build(deps).applyCapture(facts);

    expect(deps.prisma.booking.update).not.toHaveBeenCalled();
    expect(deps.dispatch.requestAssignment).not.toHaveBeenCalled();
    expect(deps.ledger.recordCapture).not.toHaveBeenCalled();
  });

  it('keeps paidAt from the row on a redelivery rather than moving it to now', async () => {
    const deps = buildDeps();
    const originalPaidAt = new Date('2026-08-11T10:00:00Z');
    deps.prisma.order.findUnique.mockResolvedValue(
      anOrder({
        status: 'paid',
        capturedPaymentId: 'pay_XYZ',
        paidAt: originalPaidAt,
      }),
    );
    paidOrder(deps);

    await build(deps).applyCapture(facts);

    expect(deps.prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ paidAt: originalPaidAt }),
      }),
    );
  });

  /**
   * A second, different payment id against a paid order means the customer was
   * very likely charged twice. Overwriting erases the evidence.
   */
  it('refuses to overwrite a capture with a different payment id', async () => {
    const deps = buildDeps();
    const existing = anOrder({
      status: 'paid',
      capturedPaymentId: 'pay_FIRST',
    });
    deps.prisma.order.findUnique.mockResolvedValue(existing);

    const result = await build(deps).applyCapture({
      ...facts,
      razorpayPaymentId: 'pay_SECOND',
    });

    expect(result).toBe(existing);
    expect(deps.prisma.order.update).not.toHaveBeenCalled();
  });
});

describe('OrdersService · applyAuthorized', () => {
  /**
   * An authorized payment can still fail to capture. Dispatching on it sends a
   * Pro to travel against money the platform may never receive.
   */
  it('never dispatches — authorization is not payment', async () => {
    const deps = buildDeps();
    deps.prisma.order.findUnique.mockResolvedValue(
      anOrder({ status: 'created' }),
    );
    deps.prisma.order.update.mockResolvedValue(
      anOrder({ status: 'attempted' }),
    );

    await build(deps).applyAuthorized({
      razorpayOrderId: 'order_ABC',
      razorpayPaymentId: 'pay_XYZ',
      amountPaise: 59900,
    });

    expect(deps.dispatch.requestAssignment).not.toHaveBeenCalled();
    expect(deps.state.transition).not.toHaveBeenCalled();
  });

  it('does not walk a paid booking back when it arrives after the capture', async () => {
    const deps = buildDeps();
    deps.prisma.order.findUnique.mockResolvedValue(anOrder({ status: 'paid' }));
    deps.prisma.order.update.mockResolvedValue(anOrder({ status: 'paid' }));

    await build(deps).applyAuthorized({
      razorpayOrderId: 'order_ABC',
      razorpayPaymentId: 'pay_XYZ',
      amountPaise: 59900,
    });

    expect(deps.prisma.booking.updateMany).not.toHaveBeenCalled();
    expect(deps.prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'paid' }),
      }),
    );
  });
});

describe('OrdersService · applyFailure', () => {
  /**
   * A declined card should let the customer try another one, not find their
   * booking cancelled underneath them. Module 4's hold window owns expiry.
   */
  it('records the failure and leaves the booking alone', async () => {
    const deps = buildDeps();
    deps.prisma.order.findUnique.mockResolvedValue(
      anOrder({ status: 'created' }),
    );
    deps.prisma.order.update.mockResolvedValue(
      anOrder({ status: 'attempted' }),
    );

    await build(deps).applyFailure({
      razorpayOrderId: 'order_ABC',
      failureCode: 'BAD_REQUEST_ERROR',
    });

    expect(deps.prisma.booking.update).not.toHaveBeenCalled();
    expect(deps.prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failureCode: 'BAD_REQUEST_ERROR' }),
      }),
    );
  });
});

describe('OrdersService · buying a subscription online', () => {
  it('takes the amount from the subscription, never from the caller', async () => {
    // Same rule as a booking order and for the same reason (US-7.1): a client
    // that could name its own amount could buy a ₹1,499 plan for ₹1.
    const deps = buildDeps();
    deps.prisma.order.findMany.mockResolvedValue([]);
    deps.razorpay.createOrder.mockResolvedValue({
      id: 'order_SUB1',
      currency: 'INR',
    });
    deps.prisma.order.create.mockResolvedValue(
      anOrder({
        id: 'order-row-sub',
        bookingId: null,
        subscriptionId: 'sub-1',
        razorpayOrderId: 'order_SUB1',
        amount: decimal('699.00'),
      }),
    );

    const handoff = await build(deps).createForSubscription('sub-1', 'cust-1');

    expect(deps.razorpay.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({ amountPaise: 69_900 }),
    );
    expect(handoff.amount).toBe('699.00');
    expect(handoff.purpose).toBe('subscription');
    expect(handoff.reference).toBe('Homingo Gold');
    // A subscription is not a booking, and the app must not be able to read
    // one out of this response.
    expect(handoff.bookingNumber).toBeNull();
  });

  it('writes an order that belongs to the subscription and to no booking', async () => {
    const deps = buildDeps();
    deps.prisma.order.findMany.mockResolvedValue([]);
    deps.razorpay.createOrder.mockResolvedValue({
      id: 'order_SUB1',
      currency: 'INR',
    });
    deps.prisma.order.create.mockResolvedValue(
      anOrder({ bookingId: null, subscriptionId: 'sub-1' }),
    );

    await build(deps).createForSubscription('sub-1', 'cust-1');

    const written = deps.prisma.order.create.mock.calls[0][0].data;
    // `orders_exactly_one_subject_check` refuses anything else.
    expect(written.bookingId).toBeNull();
    expect(written.subscriptionId).toBe('sub-1');
    expect(written.notesJson).toMatchObject({ planCode: 'homingo_gold' });
  });

  it('refuses a plan that has already been paid for', async () => {
    const deps = buildDeps();
    deps.prisma.order.findMany.mockResolvedValue([
      anOrder({ status: 'paid', subscriptionId: 'sub-1', bookingId: null }),
    ]);

    await expect(
      statusOf(build(deps).createForSubscription('sub-1', 'cust-1')),
    ).resolves.toBe(409);
    expect(deps.razorpay.createOrder).not.toHaveBeenCalled();
  });

  it('lets module 16 refuse before any gateway order exists', async () => {
    // Everything that can invalidate the purchase is checked in
    // `getPurchasable`, so nothing has to refuse after a card is charged.
    const deps = buildDeps();
    deps.subscriptions.getPurchasable.mockRejectedValue(
      new Error('not purchasable'),
    );

    await expect(
      build(deps).createForSubscription('sub-1', 'cust-1'),
    ).rejects.toThrow('not purchasable');
    expect(deps.razorpay.createOrder).not.toHaveBeenCalled();
    expect(deps.prisma.order.create).not.toHaveBeenCalled();
  });

  it('activates the plan on first capture, then books the money', async () => {
    // Ordering matters: the customer gets what they paid for before the
    // ledger entry, because a plan that took money and never activated is a
    // customer-visible failure and a missing ledger row is rebuildable.
    const deps = buildDeps();
    const order = anOrder({
      bookingId: null,
      subscriptionId: 'sub-1',
      status: 'created',
      amount: decimal('699.00'),
    });
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.prisma.order.update.mockResolvedValue({
      ...order,
      status: 'paid',
      capturedPaymentId: 'pay_XYZ',
      amountPaid: decimal('699.00'),
    });

    await build(deps).applyCapture({
      razorpayOrderId: 'order_ABC',
      razorpayPaymentId: 'pay_XYZ',
      amountPaise: 69_900,
    });

    expect(deps.subscriptions.activateFromPayment).toHaveBeenCalledWith(
      'sub-1',
      'pay_XYZ',
    );
    // The booking half must not run at all — there is no booking.
    expect(deps.prisma.booking.update).not.toHaveBeenCalled();
    expect(deps.ledger.recordCapture).toHaveBeenCalledWith(
      expect.objectContaining({ bookingId: null, subscriptionId: 'sub-1' }),
    );
  });

  it('still books the money when activation fails', async () => {
    // The money is captured either way. Throwing here would make Razorpay
    // retry a webhook that has already done its real work.
    const deps = buildDeps();
    const order = anOrder({
      bookingId: null,
      subscriptionId: 'sub-1',
      amount: decimal('699.00'),
    });
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.prisma.order.update.mockResolvedValue({
      ...order,
      status: 'paid',
      capturedPaymentId: 'pay_XYZ',
      amountPaid: decimal('699.00'),
    });
    deps.subscriptions.activateFromPayment.mockRejectedValue(
      new Error('loyalty down'),
    );

    await expect(
      build(deps).applyCapture({
        razorpayOrderId: 'order_ABC',
        razorpayPaymentId: 'pay_XYZ',
        amountPaise: 69_900,
      }),
    ).resolves.toBeDefined();

    expect(deps.ledger.recordCapture).toHaveBeenCalled();
  });
});
