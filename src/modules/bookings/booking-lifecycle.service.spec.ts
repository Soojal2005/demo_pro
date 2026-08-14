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
  const otp = {
    sendOtp: jest.fn().mockResolvedValue({ providerRef: 'ref-1' }),
    verifyOtp: jest.fn(),
  };
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
    otp,
    commission,
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
    deps.otp,
    deps.commission,
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
  startOtpProviderRef: 'ref-1',
  startOtpAttempts: 0,
  flatPrice: { toString: () => '599.00' },
};

describe('BookingLifecycleService', () => {
  describe('the start OTP — the trust anchor', () => {
    it('sends the code to the CUSTOMER, not the Pro', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue({
        ...arrivedBooking,
        status: 'en_route',
        arrivedAt: null,
      });
      deps.state.transition.mockResolvedValue({
        ...arrivedBooking,
        customerId: 'cust-1',
      });
      const service = buildService(deps);

      await service.markArrived('pro-1', 'booking-1', {});

      expect(deps.customers.getById).toHaveBeenCalledWith('cust-1');
      expect(deps.otp.sendOtp).toHaveBeenCalledWith('+919876543210');
    });

    it('does not set startedAt when the provider rejects the code', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue(arrivedBooking);
      deps.otp.verifyOtp.mockResolvedValue(false);
      deps.prisma.booking.update.mockResolvedValue({ startOtpAttempts: 1 });
      const service = buildService(deps);

      await expect(
        captureStatus(service.verifyStartOtp('pro-1', 'booking-1', '0000', {})),
      ).resolves.toBe(HttpStatus.BAD_REQUEST);

      expect(deps.state.transition).not.toHaveBeenCalled();
    });

    it('counts the failed attempt', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue(arrivedBooking);
      deps.otp.verifyOtp.mockResolvedValue(false);
      deps.prisma.booking.update.mockResolvedValue({ startOtpAttempts: 1 });
      const service = buildService(deps);

      await captureStatus(
        service.verifyStartOtp('pro-1', 'booking-1', '0000', {}),
      );

      expect(deps.prisma.booking.update).toHaveBeenCalledWith({
        where: { id: 'booking-1' },
        data: { startOtpAttempts: { increment: 1 } },
      });
    });

    it('sets startedAt only on the provider’s answer', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue(arrivedBooking);
      deps.otp.verifyOtp.mockResolvedValue(true);
      const service = buildService(deps);

      await service.verifyStartOtp('pro-1', 'booking-1', '1234', {});

      const [[call]] = deps.state.transition.mock.calls as [
        [{ to: string; data: { startedAt: Date } }],
      ];
      expect(call.to).toBe('started');
      expect(call.data.startedAt).toBeInstanceOf(Date);
    });

    it('refuses before the Pro has marked arrival', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue({
        ...arrivedBooking,
        status: 'en_route',
      });
      const service = buildService(deps);

      await expect(
        captureStatus(service.verifyStartOtp('pro-1', 'booking-1', '1234', {})),
      ).resolves.toBe(HttpStatus.CONFLICT);
      expect(deps.otp.verifyOtp).not.toHaveBeenCalled();
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

    it('survives an OTP dispatch failure — the Pro really is at the door', async () => {
      const deps = buildDeps();
      deps.bookings.getAssignedBooking.mockResolvedValue({
        ...arrivedBooking,
        arrivedAt: null,
      });
      deps.state.transition.mockResolvedValue(arrivedBooking);
      deps.otp.sendOtp.mockRejectedValue(new Error('provider down'));
      const service = buildService(deps);

      await expect(
        service.markArrived('pro-1', 'booking-1', {}),
      ).resolves.toBeDefined();
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
