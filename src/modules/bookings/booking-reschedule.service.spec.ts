import { HttpException, HttpStatus } from '@nestjs/common';
import { BookingRescheduleService } from './booking-reschedule.service';

const HOUR = 3_600_000;

function slotIn(hours: number): Date {
  return new Date(Date.now() + hours * HOUR);
}

function bookingIn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'booking-1',
    customerId: 'cust-1',
    serviceId: 'svc-1',
    bookingNumber: 'HB-2026-000412',
    status: 'assigned',
    bookingType: 'scheduled',
    proId: 'pro-1',
    slotStartAt: slotIn(48),
    rescheduleCount: 0,
    originalSlotStartAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function buildDeps() {
  const prisma = {
    $transaction: jest.fn((ops: unknown[]) => Promise.all(ops)),
    booking: {
      update: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'booking-1', status: 'assigning', ...data }),
      ),
    },
    bookingReschedule: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'rs-1', ...data }),
      ),
      findMany: jest.fn(() => Promise.resolve([])),
    },
  };

  const bookings = {
    getOwnedBooking: jest.fn(() => Promise.resolve(bookingIn())),
    getByIdOrFail: jest.fn(() => Promise.resolve(bookingIn())),
  };
  const state = { recordEvent: jest.fn(() => Promise.resolve()) };
  const catalog = {
    assertBookable: jest.fn(() => Promise.resolve({ durationMinutes: 90 })),
  };

  const settingValues: Record<string, number> = {
    'booking.maxReschedules': 2,
    'booking.freeRescheduleHours': 6,
  };
  const settings = {
    values: settingValues,
    getNumber: jest.fn((key: string, fallback: number) =>
      Promise.resolve(settingValues[key] ?? fallback),
    ),
  };

  const dispatch = {
    closeAssignment: jest.fn(() => Promise.resolve()),
    requestAssignment: jest.fn(() => Promise.resolve()),
  };
  const loyalty = {
    perksFor: jest.fn(
      (): Promise<{
        waivesCancellationFee: boolean;
        extraReschedules: number;
        planName: string | null;
      }> =>
        Promise.resolve({
          waivesCancellationFee: false,
          extraReschedules: 0,
          planName: null,
        }),
    ),
  };

  return { prisma, bookings, state, catalog, settings, dispatch, loyalty };
}

function build(deps: ReturnType<typeof buildDeps>): BookingRescheduleService {
  return new BookingRescheduleService(
    deps.prisma as never,
    deps.bookings as never,
    deps.state as never,
    deps.catalog as never,
    deps.settings as never,
    deps.dispatch as never,
    deps.loyalty as never,
  );
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
  throw new Error('Expected the call to reject, but it resolved');
}

describe('BookingRescheduleService · moving a slot', () => {
  it('moves the slot and derives the end from the live service duration', async () => {
    // Re-read rather than carried forward, because slotEnd − slotStart is what
    // the job was sold against (US-3.6).
    const deps = buildDeps();
    const target = slotIn(72);

    await build(deps).rescheduleAsCustomer('cust-1', 'booking-1', target);

    const written = deps.prisma.booking.update.mock.calls[0][0].data;
    expect(written.slotStartAt).toBe(target);
    expect((written.slotEndAt as Date).getTime()).toBe(
      target.getTime() + 90 * 60_000,
    );
  });

  it('records the move with the notice the Pro actually got', async () => {
    const deps = buildDeps();

    await build(deps).rescheduleAsCustomer('cust-1', 'booking-1', slotIn(72));

    const row = deps.prisma.bookingReschedule.create.mock.calls[0][0].data;
    expect(row.requestedByType).toBe('customer');
    expect(Number(row.hoursBeforeSlot)).toBeCloseTo(48, 1);
    // Always free: the policy refuses a late move rather than pricing one.
    expect(row.feeAmount).toBe('0');
  });

  it('writes the original slot once, so it survives however many moves follow', async () => {
    const deps = buildDeps();
    deps.bookings.getOwnedBooking.mockResolvedValue(
      bookingIn({ originalSlotStartAt: new Date('2026-08-01T09:00:00Z') }),
    );

    await build(deps).rescheduleAsCustomer('cust-1', 'booking-1', slotIn(72));

    const written = deps.prisma.booking.update.mock.calls[0][0].data;
    expect(written.originalSlotStartAt).toBeUndefined();
  });

  it('releases the Pro and re-dispatches against the new time', async () => {
    const deps = buildDeps();

    await build(deps).rescheduleAsCustomer('cust-1', 'booking-1', slotIn(72));

    expect(deps.dispatch.closeAssignment).toHaveBeenCalled();
    expect(deps.dispatch.requestAssignment).toHaveBeenCalledWith('booking-1');

    const written = deps.prisma.booking.update.mock.calls[0][0].data;
    expect(written.status).toBe('assigning');
    expect(written.proId).toBeNull();
  });

  it('leaves an unassigned booking where it is', async () => {
    const deps = buildDeps();
    deps.bookings.getOwnedBooking.mockResolvedValue(
      bookingIn({ status: 'assigning', proId: null }),
    );

    await build(deps).rescheduleAsCustomer('cust-1', 'booking-1', slotIn(72));

    expect(deps.dispatch.closeAssignment).not.toHaveBeenCalled();
    const written = deps.prisma.booking.update.mock.calls[0][0].data;
    expect(written.status).toBeUndefined();
  });

  it('appends to the booking timeline as well as its own history', async () => {
    const deps = buildDeps();

    await build(deps).rescheduleAsCustomer('cust-1', 'booking-1', slotIn(72));

    expect(deps.state.recordEvent).toHaveBeenCalled();
  });

  it('refuses a move inside the cutoff', async () => {
    const deps = buildDeps();
    deps.bookings.getOwnedBooking.mockResolvedValue(
      bookingIn({ slotStartAt: slotIn(3) }),
    );

    await expect(
      statusOf(
        build(deps).rescheduleAsCustomer('cust-1', 'booking-1', slotIn(72)),
      ),
    ).resolves.toBe(HttpStatus.CONFLICT);
    expect(deps.prisma.booking.update).not.toHaveBeenCalled();
  });

  it('refuses a new slot inside the cutoff', async () => {
    const deps = buildDeps();

    await expect(
      statusOf(
        build(deps).rescheduleAsCustomer('cust-1', 'booking-1', slotIn(2)),
      ),
    ).resolves.toBe(HttpStatus.BAD_REQUEST);
  });

  it('refuses once the allowance is spent', async () => {
    const deps = buildDeps();
    deps.bookings.getOwnedBooking.mockResolvedValue(
      bookingIn({ rescheduleCount: 2 }),
    );

    await expect(
      statusOf(
        build(deps).rescheduleAsCustomer('cust-1', 'booking-1', slotIn(72)),
      ),
    ).resolves.toBe(HttpStatus.CONFLICT);
  });

  it("adds the plan's extra reschedules to the allowance", async () => {
    const deps = buildDeps();
    deps.bookings.getOwnedBooking.mockResolvedValue(
      bookingIn({ rescheduleCount: 2 }),
    );
    deps.loyalty.perksFor.mockResolvedValue({
      waivesCancellationFee: true,
      extraReschedules: 2,
      planName: 'Homingo Gold',
    });

    await expect(
      build(deps).rescheduleAsCustomer('cust-1', 'booking-1', slotIn(72)),
    ).resolves.toBeDefined();
  });
});

describe('BookingRescheduleService · ops', () => {
  it('bypasses the allowance', async () => {
    // A customer out of moves can still be helped by a human.
    const deps = buildDeps();
    deps.bookings.getByIdOrFail.mockResolvedValue(
      bookingIn({ rescheduleCount: 9 }),
    );

    await expect(
      build(deps).rescheduleAsOps(
        'admin-1',
        'booking-1',
        slotIn(72),
        'building water is off',
      ),
    ).resolves.toBeDefined();
  });

  it('does not bypass the cutoff', async () => {
    // The cutoff exists because of what a Pro's committed afternoon costs, and
    // that does not change because an admin is the one clicking.
    const deps = buildDeps();
    deps.bookings.getByIdOrFail.mockResolvedValue(
      bookingIn({ slotStartAt: slotIn(2) }),
    );

    await expect(
      statusOf(
        build(deps).rescheduleAsOps(
          'admin-1',
          'booking-1',
          slotIn(72),
          'customer called',
        ),
      ),
    ).resolves.toBe(HttpStatus.CONFLICT);
  });

  it('records itself as an ops move, which the CHECK constraint also allows', async () => {
    const deps = buildDeps();

    await build(deps).rescheduleAsOps(
      'admin-1',
      'booking-1',
      slotIn(72),
      'customer called',
    );

    const row = deps.prisma.bookingReschedule.create.mock.calls[0][0].data;
    expect(row.requestedByType).toBe('ops');
    expect(row.requestedById).toBe('admin-1');
    expect(row.reason).toBe('customer called');
  });
});

describe('BookingRescheduleService · the preview', () => {
  it('tells the picker where to start', async () => {
    const deps = buildDeps();

    const preview = await build(deps).preview('cust-1', 'booking-1');

    expect(preview.allowed).toBe(true);
    expect(preview.reschedulesRemaining).toBe(2);
    expect(preview.freeRescheduleHours).toBe(6);
    expect(preview.earliestNewSlotAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('explains the refusal rather than just saying no', async () => {
    const deps = buildDeps();
    deps.bookings.getOwnedBooking.mockResolvedValue(
      bookingIn({ slotStartAt: slotIn(3) }),
    );

    const preview = await build(deps).preview('cust-1', 'booking-1');

    expect(preview.allowed).toBe(false);
    expect(preview.refusal).toBe('INSIDE_CUTOFF');
    expect(preview.message).toContain('cancel');
  });
});
