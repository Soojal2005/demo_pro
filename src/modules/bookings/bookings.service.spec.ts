import { HttpException, HttpStatus } from '@nestjs/common';
import { BookingsService } from './bookings.service';

function buildDeps() {
  const prisma = {
    booking: {
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: object }) =>
          Promise.resolve({ id: 'booking-1', status: 'created', ...data }),
        ),
      update: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    pro: { findUnique: jest.fn() },
    bookingStatusEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ nextval: 7n }]),
    $transaction: jest
      .fn()
      .mockImplementation((callback: (tx: unknown) => unknown) =>
        callback(prisma),
      ),
  };
  const state = {
    transition: jest
      .fn()
      .mockImplementation((input: { to: string }) =>
        Promise.resolve({ id: 'booking-1', status: input.to }),
      ),
    recordEvent: jest.fn(),
  };
  const catalog = { assertBookable: jest.fn() };
  const customers = {
    getAddressForCustomer: jest
      .fn()
      .mockResolvedValue({ id: 'addr-1', cityId: 'city-1' }),
    checkServiceability: jest.fn().mockResolvedValue({ serviceable: true }),
  };
  const dispatch = { requestAssignment: jest.fn() };
  const payments = {
    createOrder: jest.fn(),
    // Permissive, matching the no-op the port is bound to until module 7
    // registers — so these cases test the fork, not the cash gate.
    assertCashAllowed: jest.fn().mockResolvedValue(undefined),
  };
  // Module 13's area gate. `areaId: null` is what the no-op returns and what
  // every booking taken before areas existed looks like, so these cases test
  // the fork rather than the area map.
  const serviceability = {
    resolveForBooking: jest.fn().mockResolvedValue({ areaId: null }),
  };
  // No plan, no coins — the default a booking spec wants unless it is
  // specifically about loyalty. `quote` returns the full flat price, which is
  // exactly what the no-op port does in production when module 16 is absent.
  const loyalty = {
    quote: jest.fn(({ flatPrice }: { flatPrice: string }) =>
      Promise.resolve({
        flatPrice,
        subscriptionDiscountAmount: '0.00',
        coinsRedeemed: 0,
        walletDiscountAmount: '0.00',
        discountAmount: '0.00',
        payableAmount: flatPrice,
        subscriptionId: null,
        planName: null,
        coinBalance: 0,
        maxRedeemableCoins: 0,
        coinsEarnedEstimate: 0,
      }),
    ),
    commit: jest.fn(),
    release: jest.fn(),
    onBookingCompleted: jest.fn(),
    perksFor: jest.fn().mockResolvedValue({
      waivesCancellationFee: false,
      extraReschedules: 0,
      planName: null,
    }),
  };

  return {
    prisma,
    state,
    catalog,
    customers,
    dispatch,
    payments,
    serviceability,
    loyalty,
  };
}

function buildService(deps: ReturnType<typeof buildDeps>): BookingsService {
  return new BookingsService(
    deps.prisma as never,
    deps.state as never,
    deps.catalog as never,
    deps.customers as never,
    deps.dispatch as never,
    deps.payments as never,
    deps.serviceability,
    deps.loyalty,
  );
}

async function captureStatus(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
  throw new Error('Expected the call to reject, but it resolved');
}

const service90min = {
  id: 'svc-1',
  flatPrice: '599.00',
  durationMinutes: 90,
  supportsInstant: true,
  supportsScheduled: true,
  supportsRecurring: false,
};

describe('BookingsService', () => {
  describe('price freezing', () => {
    it('copies the catalogue price onto the booking', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      const bookings = buildService(deps);

      await bookings.create('cust-1', {
        serviceId: 'svc-1',
        addressId: 'addr-1',
        paymentMode: 'cash',
      });

      const [[call]] = deps.prisma.booking.create.mock.calls as [
        [{ data: { flatPrice: string } }],
      ];
      expect(call.data.flatPrice).toBe('599.00');
    });

    it('derives the slot window from the service duration', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      const bookings = buildService(deps);

      await bookings.create('cust-1', {
        serviceId: 'svc-1',
        addressId: 'addr-1',
        paymentMode: 'cash',
      });

      const [[call]] = deps.prisma.booking.create.mock.calls as [
        [{ data: { slotStartAt: Date; slotEndAt: Date } }],
      ];
      const minutes =
        (call.data.slotEndAt.getTime() - call.data.slotStartAt.getTime()) /
        60_000;
      expect(minutes).toBe(90);
    });
  });

  describe('the payment-mode fork', () => {
    it('sends a cash booking straight to assigning and asks for dispatch', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      const bookings = buildService(deps);

      await bookings.create('cust-1', {
        serviceId: 'svc-1',
        addressId: 'addr-1',
        paymentMode: 'cash',
      });

      const transitions = deps.state.transition.mock.calls.map(
        ([call]) => (call as { to: string }).to,
      );
      expect(transitions).toEqual(['assigning']);
      expect(deps.dispatch.requestAssignment).toHaveBeenCalledWith('booking-1');
    });

    it('sends an online booking to awaiting_payment and never to dispatch', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      deps.payments.createOrder.mockResolvedValue({ orderId: 'order-1' });
      const bookings = buildService(deps);

      await bookings.create('cust-1', {
        serviceId: 'svc-1',
        addressId: 'addr-1',
        paymentMode: 'online',
      });

      const transitions = deps.state.transition.mock.calls.map(
        ([call]) => (call as { to: string }).to,
      );
      expect(transitions).toEqual(['awaiting_payment']);
      expect(deps.dispatch.requestAssignment).not.toHaveBeenCalled();
    });
  });

  describe('admin manual assignment', () => {
    const ELIGIBLE = {
      id: 'pro-1',
      status: 'approved',
      isAvailable: true,
      cityId: 'city-1',
      services: [{ id: 'ps-1' }],
    };
    const assigning = {
      id: 'booking-1',
      status: 'assigning',
      serviceId: 'svc-1',
      address: { cityId: 'city-1' },
      slotStartAt: null,
      slotEndAt: null,
    };

    function arrange(pro: unknown) {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue(assigning);
      deps.prisma.pro.findUnique.mockResolvedValue(pro);
      return deps;
    }

    it('places an eligible Pro on a booking that is looking for one', async () => {
      const deps = arrange(ELIGIBLE);

      await buildService(deps).assignPro('booking-1', 'pro-1', 'admin-1');

      const [call] = deps.state.transition.mock.calls[0] as [
        { to: string; expectedFrom: string[]; data: Record<string, unknown> },
      ];
      expect(call.to).toBe('assigned');
      expect(call.expectedFrom).toEqual(['assigning']);
      expect(call.data.pro).toEqual({ connect: { id: 'pro-1' } });
    });

    /**
     * It used to write `acknowledged`, which recorded a consent the Pro never
     * gave and — since acknowledging requires `pending_ack` — left them unable
     * to confirm the job they had just been handed.
     */
    it('records the assignment as an ops act, not as the Pro accepting', async () => {
      const deps = arrange(ELIGIBLE);

      await buildService(deps).assignPro('booking-1', 'pro-1', 'admin-1');

      const [call] = deps.state.transition.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(call.data.assignmentOutcome).toBe('ops_assigned');
    });

    it.each([
      ['suspended', { ...ELIGIBLE, status: 'suspended' }],
      ['off duty', { ...ELIGIBLE, isAvailable: false }],
      ['in another city', { ...ELIGIBLE, cityId: 'city-2' }],
      ['without the service', { ...ELIGIBLE, services: [] }],
      ['not a Pro at all', null],
    ])('refuses a Pro who is %s', async (_label, pro) => {
      const deps = arrange(pro);

      const status = await captureStatus(
        buildService(deps).assignPro('booking-1', 'pro-1', 'admin-1'),
      );

      expect(status).toBe(HttpStatus.CONFLICT);
      expect(deps.state.transition).not.toHaveBeenCalled();
    });

    it('refuses a Pro already committed in the same window', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue({
        ...assigning,
        slotStartAt: new Date('2026-08-17T09:00:00Z'),
        slotEndAt: new Date('2026-08-17T10:00:00Z'),
      });
      deps.prisma.pro.findUnique.mockResolvedValue(ELIGIBLE);
      deps.prisma.booking.count.mockResolvedValue(1);

      const status = await captureStatus(
        buildService(deps).assignPro('booking-1', 'pro-1', 'admin-1'),
      );

      expect(status).toBe(HttpStatus.CONFLICT);
      expect(deps.state.transition).not.toHaveBeenCalled();
    });

    it('does not look for a clash when the booking has no slot', async () => {
      const deps = arrange(ELIGIBLE);

      await buildService(deps).assignPro('booking-1', 'pro-1', 'admin-1');

      expect(deps.prisma.booking.count).not.toHaveBeenCalled();
    });

    it('refuses an unknown booking', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue(null);

      const status = await captureStatus(
        buildService(deps).assignPro('booking-1', 'pro-1', 'admin-1'),
      );

      expect(status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('admin reassignment', () => {
    const assigned = {
      id: 'booking-1',
      status: 'assigned',
      serviceId: 'svc-1',
      address: { cityId: 'city-1' },
      slotStartAt: null,
      slotEndAt: null,
    };

    it('refuses a scoped admin from another city', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue(assigned);
      const status = await captureStatus(
        buildService(deps).reassignByAdmin(
          'booking-1',
          { mode: 'redispatch', reason: 'Customer requested a new Pro' },
          'admin-1',
          ['city-2'],
        ),
      );
      expect(status).toBe(HttpStatus.FORBIDDEN);
    });

    it('returns an assigned booking to dispatch with the required reason', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue(assigned);
      deps.prisma.booking.update.mockResolvedValue({
        ...assigned,
        status: 'assigning',
        proId: null,
      });

      await buildService(deps).reassignByAdmin(
        'booking-1',
        { mode: 'redispatch', reason: 'Professional is no longer reachable' },
        'admin-1',
        ['city-1'],
      );

      expect(deps.prisma.booking.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'assigning',
            overrideReason: 'Professional is no longer reachable',
          }),
        }),
      );
      expect(deps.dispatch.requestAssignment).toHaveBeenCalledWith('booking-1');
    });

    it('validates the replacement Pro before changing the booking', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue(assigned);
      deps.prisma.pro.findUnique.mockResolvedValue({
        status: 'approved',
        isAvailable: true,
        cityId: 'city-1',
        services: [],
      });

      const status = await captureStatus(
        buildService(deps).reassignByAdmin(
          'booking-1',
          {
            mode: 'specific_pro',
            proId: 'pro-2',
            reason: 'Customer requested a different professional',
          },
          'admin-1',
          ['city-1'],
        ),
      );
      expect(status).toBe(HttpStatus.CONFLICT);
      expect(deps.prisma.booking.update).not.toHaveBeenCalled();
    });
  });

  describe('what is refused', () => {
    it('refuses a booking in a city we do not operate in', async () => {
      const deps = buildDeps();
      deps.customers.checkServiceability.mockResolvedValue({
        serviceable: false,
      });
      const bookings = buildService(deps);

      await expect(
        captureStatus(
          bookings.create('cust-1', {
            serviceId: 'svc-1',
            addressId: 'addr-1',
            paymentMode: 'cash',
          }),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
      // The catalogue is never consulted — serviceability fails first.
      expect(deps.catalog.assertBookable).not.toHaveBeenCalled();
    });

    it('refuses an instant booking of a scheduled-only service', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue({
        ...service90min,
        supportsInstant: false,
      });
      const bookings = buildService(deps);

      await expect(
        captureStatus(
          bookings.create('cust-1', {
            serviceId: 'svc-1',
            addressId: 'addr-1',
            paymentMode: 'cash',
          }),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });

    it('refuses a slot in the past', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      const bookings = buildService(deps);

      await expect(
        captureStatus(
          bookings.create('cust-1', {
            serviceId: 'svc-1',
            addressId: 'addr-1',
            paymentMode: 'cash',
            slotStartAt: new Date(Date.now() - 60_000),
          }),
        ),
      ).resolves.toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('idempotency', () => {
    it('returns the original booking on a replay instead of creating a second', async () => {
      const deps = buildDeps();
      deps.prisma.bookingStatusEvent.findFirst.mockResolvedValue({
        booking: { id: 'booking-original' },
      });
      const bookings = buildService(deps);

      const result = await bookings.create(
        'cust-1',
        { serviceId: 'svc-1', addressId: 'addr-1', paymentMode: 'cash' },
        'key-123',
      );

      expect(result).toEqual({ id: 'booking-original' });
      expect(deps.prisma.booking.create).not.toHaveBeenCalled();
    });
  });

  describe('rebook', () => {
    it('records the lineage but never pins the original Pro', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue({
        id: 'old-booking',
        customerId: 'cust-1',
        serviceId: 'svc-1',
        addressId: 'addr-1',
        paymentMode: 'cash',
        proId: 'pro-original',
      });
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      deps.prisma.booking.update.mockResolvedValue({ id: 'booking-1' });
      const bookings = buildService(deps);

      await bookings.rebook('cust-1', 'old-booking');

      const [[call]] = deps.prisma.booking.update.mock.calls as [
        [{ data: Record<string, unknown> }],
      ];
      // Rotation still applies — a rebook is not a request for the same person.
      expect(call.data).toEqual({ rebookedFromBookingId: 'old-booking' });
      expect(call.data).not.toHaveProperty('proId');
    });
  });

  describe('ownership non-disclosure', () => {
    it('reports someone else’s booking as not found', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue({
        id: 'booking-1',
        customerId: 'someone-else',
      });
      const bookings = buildService(deps);

      await expect(
        captureStatus(bookings.getOwnedBooking('cust-1', 'booking-1')),
      ).resolves.toBe(HttpStatus.NOT_FOUND);
    });

    it('reports a job assigned to another Pro as not found', async () => {
      const deps = buildDeps();
      deps.prisma.booking.findUnique.mockResolvedValue({
        id: 'booking-1',
        proId: 'other-pro',
      });
      const bookings = buildService(deps);

      await expect(
        captureStatus(bookings.getAssignedBooking('pro-1', 'booking-1')),
      ).resolves.toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('booking number', () => {
    it('is human-readable and sequential, not random', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      const bookings = buildService(deps);

      await bookings.create('cust-1', {
        serviceId: 'svc-1',
        addressId: 'addr-1',
        paymentMode: 'cash',
      });

      const [[call]] = deps.prisma.booking.create.mock.calls as [
        [{ data: { bookingNumber: string } }],
      ];
      expect(call.data.bookingNumber).toMatch(/^HB-\d{4}-000007$/);
    });

    it('retries when an imported booking left the sequence behind', async () => {
      const deps = buildDeps();
      deps.catalog.assertBookable.mockResolvedValue(service90min);
      deps.prisma.$queryRaw
        .mockResolvedValueOnce([{ nextval: 7n }])
        .mockResolvedValueOnce([{ nextval: 8n }]);
      deps.prisma.booking.create
        .mockRejectedValueOnce(
          Object.assign(new Error('duplicate booking number'), {
            code: 'P2002',
            meta: { target: ['bookingNumber'] },
          }),
        )
        .mockImplementationOnce(({ data }: { data: object }) =>
          Promise.resolve({ id: 'booking-1', status: 'created', ...data }),
        );
      const bookings = buildService(deps);

      await bookings.create('cust-1', {
        serviceId: 'svc-1',
        addressId: 'addr-1',
        paymentMode: 'cash',
      });

      expect(deps.prisma.booking.create).toHaveBeenCalledTimes(2);
      expect(deps.prisma.booking.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({
          bookingNumber: expect.stringMatching(/000008$/),
        }),
      });
    });
  });
});

describe('BookingsService.listForAdmin · search', () => {
  async function whereFor(
    query: Parameters<BookingsService['listForAdmin']>[0],
    allowedCityIds?: string[],
  ) {
    const deps = buildDeps();
    deps.prisma.booking.findMany.mockResolvedValue([]);
    await buildService(deps).listForAdmin(query, allowedCityIds);
    const [call] = deps.prisma.booking.findMany.mock.calls[0] as [
      { where: Record<string, unknown>; take: number },
    ];
    return call;
  }

  /**
   * The list is capped, so this has to run in the database. Filtering the
   * returned page instead answers "no such booking" for anything older than
   * the hundredth — indistinguishable from a booking that never existed.
   */
  it('matches the booking number in the database', async () => {
    const { where } = await whereFor({ search: 'HB-2026-000450' });

    expect(where.bookingNumber).toEqual({
      contains: 'HB-2026-000450',
      mode: 'insensitive',
    });
  });

  it('still caps the result', async () => {
    const { take } = await whereFor({ search: 'HB-2026' });
    expect(take).toBe(100);
  });

  it('ignores an empty search rather than matching everything', async () => {
    const { where } = await whereFor({ search: '' });
    expect(where.bookingNumber).toBeUndefined();
  });

  it('combines a search with a status filter', async () => {
    const { where } = await whereFor({ search: 'HB-2026', status: 'assigned' });

    expect(where.status).toBe('assigned');
    expect(where.bookingNumber).toBeDefined();
  });

  /** A scoped admin searching must not reach outside their own cities. */
  it('keeps the city scope alongside a search', async () => {
    const { where } = await whereFor({ search: 'HB-2026' }, ['city-1']);

    expect(where.address).toEqual({ cityId: { in: ['city-1'] } });
    expect(where.bookingNumber).toBeDefined();
  });
});
