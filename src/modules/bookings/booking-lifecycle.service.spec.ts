import { HttpException, HttpStatus } from '@nestjs/common';
import { BookingLifecycleService } from './booking-lifecycle.service';

function buildDeps() {
  const prisma = {
    booking: { update: jest.fn(), findUnique: jest.fn() },
    jobPhotoProof: { create: jest.fn(), count: jest.fn(), findMany: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([{ nextval: 42n }]),
  };
  const state = {
    transition: jest
      .fn()
      .mockImplementation((input: { data?: unknown }) =>
        Promise.resolve({ id: 'booking-1', ...(input.data as object) }),
      ),
    recordEvent: jest.fn(),
  };
  const bookings = { getAssignedBooking: jest.fn(), getByIdOrFail: jest.fn() };
  const customers = {
    getById: jest
      .fn()
      .mockResolvedValue({ id: 'cust-1', phone: '+919876543210' }),
  };
  const counters = { recordCompletion: jest.fn() };
  const s3 = {
    createUploadUrl: jest
      .fn()
      .mockResolvedValue({ key: 'k', uploadUrl: 'u', expiresIn: 900 }),
  };
  const settings = {
    getNumber: jest
      .fn()
      .mockImplementation((_key: string, fallback: number) =>
        Promise.resolve(fallback),
      ),
  };
  const config = { get: jest.fn() };
  // Module 8's completion hook. Resolved by default so the lifecycle tests
  // stay about the lifecycle; the one case that matters here — a failing
  // commission must not fail the completion — has its own test.
  const commission = {
    recordCompletion: jest.fn().mockResolvedValue(undefined),
  };
  return {
    prisma,
    state,
    bookings,
    customers,
    counters,
    s3,
    settings,
    config,
    commission,
    loyalty: {
      quote: jest.fn(),
      commit: jest.fn(),
      release: jest.fn(),
      onBookingCompleted: jest.fn().mockResolvedValue(undefined),
      perksFor: jest.fn().mockResolvedValue({
        waivesCancellationFee: false,
        extraReschedules: 0,
        planName: null,
      }),
    },
  };
}

function buildService(
  deps: ReturnType<typeof buildDeps>,
): BookingLifecycleService {
  return new BookingLifecycleService(
    deps.prisma as never,
    deps.state as never,
    deps.bookings as never,
    deps.customers as never,
    deps.counters as never,
    deps.s3 as never,
    deps.settings as never,
    deps.config as never,
    deps.commission,
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

const arrivedBooking = {
  id: 'booking-1',
  customerId: 'cust-1',
  proId: 'pro-1',
  status: 'arrived',
  arrivedAt: new Date('2026-08-10T09:00:00Z'),
  startedAt: null,
  startOtpCode: '481920',
  startOtpAttempts: 0,
  flatPrice: { toString: () => '599.00' },
  payableAmount: { toString: () => '599.00' },
};

describe('BookingLifecycleService', () => {
  describe('the start OTP — the trust anchor', () => {
    /** The code written by whichever `booking.update` call issued one. */
    const issuedCode = (deps: ReturnType<typeof buildDeps>): string => {
      const call = deps.prisma.booking.update.mock.calls.find(
        ([arg]: [{ data?: { startOtpCode?: string } }]) =>
          typeof arg?.data?.startOtpCode === 'string',
      ) as [{ data: { startOtpCode: string } }] | undefined;

      expect(call).toBeDefined();
      return call![0].data.startOtpCode;
    };

    /*
     * The whole point of the change: the code is ours. It used to be sent by
     * the login SMS provider, which meant it never reached this database, the
     * app could not show it, and a customer with no number on file could not
     * start their job at all.
     */
    it('mints the code itself and stores it on the booking', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue({
        ...arrivedBooking,
        status: 'en_route',
        arrivedAt: null,
      });
      deps.state.transition.mockResolvedValue(arrivedBooking);
      const service = buildService(deps);

      await service.markArrived('pro-1', 'booking-1', {});

      expect(issuedCode(deps)).toMatch(/^\d{6}$/);
    });

    it('issues one to a customer who has no phone number at all', async () => {
      const deps = buildDeps();
      deps.customers.getById.mockResolvedValue({ id: 'cust-1', phone: null });
      deps.bookings.getAssignedBooking.mockResolvedValue({
        ...arrivedBooking,
        status: 'en_route',
        arrivedAt: null,
      });
      deps.state.transition.mockResolvedValue(arrivedBooking);
      const service = buildService(deps);

      await service.markArrived('pro-1', 'booking-1', {});

      expect(issuedCode(deps)).toMatch(/^\d{6}$/);
    });

    it('does not set startedAt when the code is wrong', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue(arrivedBooking);
      deps.prisma.booking.update.mockResolvedValue({ startOtpAttempts: 1 });
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.verifyStartOtp('pro-1', 'booking-1', '000000', {}),
        ),
      ).resolves.toBe(HttpStatus.BAD_REQUEST);

      expect(deps.state.transition).not.toHaveBeenCalled();
    });

    it('counts the failed attempt', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue(arrivedBooking);
      deps.prisma.booking.update.mockResolvedValue({ startOtpAttempts: 1 });
      const service = buildService(deps);

      await captureStatus(
        service.verifyStartOtp('pro-1', 'booking-1', '000000', {}),
      );

      expect(deps.prisma.booking.update).toHaveBeenCalledWith({
        where: { id: 'booking-1' },
        data: { startOtpAttempts: { increment: 1 } },
      });
    });

    it('starts the job on the right code, and spends it', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue(arrivedBooking);
      const service = buildService(deps);

      await service.verifyStartOtp('pro-1', 'booking-1', '481920', {});

      const [[call]] = deps.state.transition.mock.calls as [
        [{ to: string; data: { startedAt: Date; startOtpCode: null } }],
      ];
      expect(call.to).toBe('started');
      expect(call.data.startedAt).toBeInstanceOf(Date);
      // A started job must stop carrying a live code.
      expect(call.data.startOtpCode).toBeNull();
    });

    /*
     * The cap used to be read only AFTER a comparison, so it changed the
     * message but never refused the guess — a caller could keep trying
     * indefinitely against a six-digit code.
     */
    it('refuses to look at another code once the attempts are spent', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue({
        ...arrivedBooking,
        startOtpAttempts: 5,
      });
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.verifyStartOtp('pro-1', 'booking-1', '481920', {}),
        ),
      ).resolves.toBe(HttpStatus.TOO_MANY_REQUESTS);
      expect(deps.state.transition).not.toHaveBeenCalled();
    });

    it('refuses before the Pro has marked arrival', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue({
        ...arrivedBooking,
        status: 'en_route',
      });
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.verifyStartOtp('pro-1', 'booking-1', '481920', {}),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
      expect(deps.state.transition).not.toHaveBeenCalled();
    });

    it('refuses when no code has been issued', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue({
        ...arrivedBooking,
        startOtpCode: null,
      });
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.verifyStartOtp('pro-1', 'booking-1', '481920', {}),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });

    /* Asking for a resend means the first one is unusable — the same digits
       back would solve nothing, and the old allowance is already spent. */
    it('replaces the code and clears the attempts on a resend', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue({
        ...arrivedBooking,
        startOtpAttempts: 4,
      });
      const service = buildService(deps);

      await service.resendStartOtp('booking-1');

      const [[call]] = deps.prisma.booking.update.mock.calls as [
        [{ data: { startOtpCode: string; startOtpAttempts: number } }],
      ];
      expect(call.data.startOtpCode).toMatch(/^\d{6}$/);
      expect(call.data.startOtpAttempts).toBe(0);
    });

    it('does not restart the grace clock when a Pro returns', async () => {
      const deps = buildDeps();
      // Already arrived once, now coming back after stepping away.
      deps.bookings.getAssignedBooking.mockResolvedValue(arrivedBooking);
      deps.state.transition.mockResolvedValue(arrivedBooking);
      const service = buildService(deps);

      await service.markArrived('pro-1', 'booking-1', {});

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: Record<string, unknown> }],
      ];
      expect(call.data).not.toHaveProperty('arrivedAt');
    });
  });

  describe('force-start — the documented override', () => {
    it('returns the booking lookup failure before writing an audit event', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockRejectedValue(
        new HttpException('Booking not found', HttpStatus.NOT_FOUND),
      );
      const service = buildService(deps);

      await expect(
        service.forceStart('missing-booking', 'admin-1', 'Building security'),
      ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
      expect(deps.state.recordEvent).not.toHaveBeenCalled();
    });

    it('records a distinct bypass event before the transition', async () => {
      const deps = buildDeps();
      const service = buildService(deps);

      await service.forceStart(
        'booking-1',
        'admin-1',
        'Customer sent a relative',
      );

      expect(deps.state.recordEvent).toHaveBeenCalledWith(
        'booking-1',
        'start_otp_bypassed',
        'ops',
        'admin-1',
      );
    });

    it('attributes the start to ops, not to the Pro', async () => {
      const deps = buildDeps();
      const service = buildService(deps);

      await service.forceStart('booking-1', 'admin-1', 'Building security');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ actorType: string; data: { startedAt: Date } }],
      ];
      expect(call.actorType).toBe('ops');
      expect(call.data.startedAt).toBeInstanceOf(Date);
    });
  });

  describe('completion', () => {
    const startedBooking = {
      ...arrivedBooking,
      status: 'started',
      startedAt: new Date(Date.now() - 90 * 60_000),
    };

    it('refuses without a verified start', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue({
        ...startedBooking,
        startedAt: null,
      });
      const service = buildService(deps);

      await expect(
        captureStatus(service.complete('pro-1', 'booking-1', {})),
      ).resolves.toBe(HttpStatus.CONFLICT);
      expect(deps.state.transition).not.toHaveBeenCalled();
    });

    it('refuses without a completion photo — US-4.16', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue(startedBooking);
      deps.prisma.jobPhotoProof.count.mockResolvedValue(0);
      const service = buildService(deps);

      await expect(
        captureStatus(service.complete('pro-1', 'booking-1', {})),
      ).resolves.toBe(HttpStatus.CONFLICT);
      expect(deps.state.transition).not.toHaveBeenCalled();
      expect(deps.counters.recordCompletion).not.toHaveBeenCalled();
    });

    it('computes actual duration from the verified start', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue(startedBooking);
      deps.prisma.jobPhotoProof.count.mockResolvedValue(1);
      const service = buildService(deps);

      await service.complete('pro-1', 'booking-1', {});

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { actualDurationMinutes: number } }],
      ];
      expect(call.data.actualDurationMinutes).toBeGreaterThanOrEqual(89);
      expect(call.data.actualDurationMinutes).toBeLessThanOrEqual(91);
    });

    it('increments the Pro counters that have had no caller until now', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue(startedBooking);
      deps.prisma.jobPhotoProof.count.mockResolvedValue(1);
      const service = buildService(deps);

      await service.complete('pro-1', 'booking-1', {});

      expect(deps.counters.recordCompletion).toHaveBeenCalledWith(
        'booking-1',
        'pro-1',
      );
    });

    it('records tax as the component within the flat price, not on top of it', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue(startedBooking);
      deps.prisma.jobPhotoProof.count.mockResolvedValue(1);
      const service = buildService(deps);

      await service.complete('pro-1', 'booking-1', {});

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { taxAmount: string; invoiceNumber: string } }],
      ];
      // 599 inclusive of 18% => 599 - 599/1.18 ≈ 91.37, which is less than
      // the 107.82 an additive calculation would give.
      expect(Number(call.data.taxAmount)).toBeCloseTo(91.37, 1);
      expect(call.data.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
    });
  });

  describe('photo proof', () => {
    it('rejects a key belonging to another booking', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue(arrivedBooking);
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.attachPhoto('pro-1', 'booking-1', {
            photoType: 'completion',
            photoKey: 'bookings/some-other-booking/proof/completion/x',
          }),
        ),
      ).resolves.toBe(HttpStatus.BAD_REQUEST);
      expect(deps.prisma.jobPhotoProof.create).not.toHaveBeenCalled();
    });

    it('namespaces upload keys per booking', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue(arrivedBooking);
      const service = buildService(deps);

      await service.createPhotoUploadUrl('pro-1', 'booking-1', {
        photoType: 'completion',
        contentType: 'image/jpeg',
      });

      expect(deps.s3.createUploadUrl).toHaveBeenCalledWith(
        'bookings/booking-1/proof/completion',
        'image/jpeg',
      );
    });
  });
});
