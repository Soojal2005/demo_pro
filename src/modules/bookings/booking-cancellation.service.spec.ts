import { HttpException, HttpStatus } from '@nestjs/common';
import { BookingCancellationService } from './booking-cancellation.service';

function buildDeps() {
  const state = {
    transition: jest
      .fn()
      .mockImplementation((input: { data?: unknown }) =>
        Promise.resolve({ id: 'booking-1', ...(input.data as object) }),
      ),
  };
  const bookings = { getOwnedBooking: jest.fn(), getByIdOrFail: jest.fn() };
  /**
   * Keyed rather than blanket, because the policy now reads three settings
   * that mean entirely different things — a mock returning one number for all
   * of them would make a 25% fee and a 25-hour free window the same fixture.
   */
  const settingValues: Record<string, number> = {
    'booking.freeCancellationHours': 6,
    'booking.lateCancellationFeePercent': 25,
    'booking.cancellationFeeAmount': 0,
  };
  const settings = {
    values: settingValues,
    getNumber: jest.fn((key: string, fallback: number) =>
      Promise.resolve(settingValues[key] ?? fallback),
    ),
  };
  const dispatch = { closeAssignment: jest.fn() };
  const payments = { initiateRefund: jest.fn() };
  const loyalty = {
    quote: jest.fn(),
    commit: jest.fn(),
    release: jest.fn(),
    onBookingCompleted: jest.fn(),
    perksFor: jest.fn().mockResolvedValue({
      waivesCancellationFee: false,
      extraReschedules: 0,
      planName: null,
    }),
  };
  return { state, bookings, settings, dispatch, payments, loyalty };
}

function buildService(
  deps: ReturnType<typeof buildDeps>,
): BookingCancellationService {
  return new BookingCancellationService(
    deps.state as never,
    deps.bookings as never,
    deps.settings as never,
    deps.dispatch as never,
    deps.payments as never,
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

const HOUR = 3_600_000;

/** A slot `hours` from now — the second axis the policy turns on. */
function slotIn(hours: number): Date {
  return new Date(Date.now() + hours * HOUR);
}

function bookingIn(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'booking-1',
    customerId: 'cust-1',
    proId: status === 'created' ? null : 'pro-1',
    status,
    flatPrice: '1000.00',
    // What the customer actually owes, and what every refund is computed
    // against. Equal to `flatPrice` here because these fixtures carry no
    // discount; the discount tests are the ones where they differ.
    payableAmount: { toString: () => '1000.00' },
    coinsRedeemed: 0,
    // Well outside the six-hour cutoff by default, so a test that does not
    // care about timing gets the free case rather than an incidental fee.
    slotStartAt: slotIn(48),
    paymentStatus: 'paid',
    assignmentOutcome: null,
    ...overrides,
  };
}

describe('BookingCancellationService', () => {
  describe('who may cancel', () => {
    it('stops a customer cancelling a job already under way — window E is a human call', async () => {
      const deps = buildDeps();
      deps.bookings.getOwnedBooking.mockResolvedValue(bookingIn('started'));
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.cancelAsCustomer('cust-1', 'booking-1', 'changed my mind'),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
      expect(deps.state.transition).not.toHaveBeenCalled();
    });

    it('lets a customer cancel while the Pro is on the way', async () => {
      const deps = buildDeps();
      deps.bookings.getOwnedBooking.mockResolvedValue(bookingIn('en_route'));
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('en_route'));
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'no longer needed');

      expect(deps.state.transition).toHaveBeenCalled();
    });

    it('lets ops reach window E, which the customer cannot', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('started'));
      const service = buildService(deps);

      await service.cancelAsOps(
        'admin-1',
        'booking-1',
        'work is unsafe',
        '400.00',
      );

      expect(deps.state.transition).toHaveBeenCalled();
    });

    it('refuses to cancel a completed job — that is a dispute, not a cancellation', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('completed'));
      const service = buildService(deps);

      await expect(
        captureStatus(
          service.cancelAsOps('admin-1', 'booking-1', 'customer complained'),
        ),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });

    it('refuses to cancel twice', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('cancelled'));
      const service = buildService(deps);

      await expect(
        captureStatus(service.cancelAsOps('admin-1', 'booking-1', 'again')),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });
  });

  describe('the fee — status window and clock together', () => {
    it('is free more than six hours out, even in window D', async () => {
      const deps = buildDeps();
      // The rule the whole policy exists for: a Pro marked en route two days
      // early has not lost the afternoon.
      const booking = bookingIn('en_route', { slotStartAt: slotIn(48) });
      deps.bookings.getOwnedBooking.mockResolvedValue(booking);
      deps.bookings.getByIdOrFail.mockResolvedValue(booking);
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'not needed');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { cancellationFeeAmount: string; refundedAmount: string } }],
      ];
      expect(call.data.cancellationFeeAmount).toBe('0.00');
      expect(call.data.refundedAmount).toBe('1000.00');
    });

    it('retains the configured percentage inside the cutoff', async () => {
      const deps = buildDeps();
      const booking = bookingIn('assigning', { slotStartAt: slotIn(2) });
      deps.bookings.getOwnedBooking.mockResolvedValue(booking);
      deps.bookings.getByIdOrFail.mockResolvedValue(booking);
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'plans changed');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { cancellationFeeAmount: string; refundedAmount: string } }],
      ];
      // 25% of the payable amount, not of the list price.
      expect(call.data.cancellationFeeAmount).toBe('250.00');
      expect(call.data.refundedAmount).toBe('750.00');
    });

    it('charges nothing in window A whatever the clock says', async () => {
      const deps = buildDeps();
      // Nothing was ever charged, so there is nothing to retain.
      const booking = bookingIn('created', { slotStartAt: slotIn(0.5) });
      deps.bookings.getOwnedBooking.mockResolvedValue(booking);
      deps.bookings.getByIdOrFail.mockResolvedValue(booking);
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'mistake');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { cancellationFeeAmount: string } }],
      ];
      expect(call.data.cancellationFeeAmount).toBe('0.00');
    });

    it('takes the flat window-D fee when it beats the percentage', async () => {
      const deps = buildDeps();
      // Someone is standing at the door: that is the one case where the
      // platform's floor applies over the proportion.
      deps.settings.values['booking.lateCancellationFeePercent'] = 5;
      deps.settings.values['booking.cancellationFeeAmount'] = 300;
      const booking = bookingIn('arrived', { slotStartAt: slotIn(0.5) });
      deps.bookings.getOwnedBooking.mockResolvedValue(booking);
      deps.bookings.getByIdOrFail.mockResolvedValue(booking);
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'not needed');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { cancellationFeeAmount: string } }],
      ];
      expect(call.data.cancellationFeeAmount).toBe('300.00');
    });

    it('never lets the fee exceed what the customer owes', async () => {
      const deps = buildDeps();
      deps.settings.values['booking.cancellationFeeAmount'] = 99999;
      const booking = bookingIn('arrived', { slotStartAt: slotIn(0.5) });
      deps.bookings.getOwnedBooking.mockResolvedValue(booking);
      deps.bookings.getByIdOrFail.mockResolvedValue(booking);
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'not needed');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { cancellationFeeAmount: string; refundedAmount: string } }],
      ];
      // A cancellation must never turn into a debt.
      expect(call.data.cancellationFeeAmount).toBe('1000.00');
      expect(call.data.refundedAmount).toBe('0.00');
    });

    it('waives the fee for a subscriber whose plan says so', async () => {
      const deps = buildDeps();
      deps.loyalty.perksFor.mockResolvedValue({
        waivesCancellationFee: true,
        extraReschedules: 2,
        planName: 'Homingo Plus',
      });
      const booking = bookingIn('arrived', { slotStartAt: slotIn(0.5) });
      deps.bookings.getOwnedBooking.mockResolvedValue(booking);
      deps.bookings.getByIdOrFail.mockResolvedValue(booking);
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'not needed');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { cancellationFeeAmount: string; refundedAmount: string } }],
      ];
      expect(call.data.cancellationFeeAmount).toBe('0.00');
      expect(call.data.refundedAmount).toBe('1000.00');
    });

    it('never charges a fee when the platform is the party that failed — US-4.22', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(
        bookingIn('arrived', { slotStartAt: slotIn(0.5) }),
      );
      const service = buildService(deps);

      await service.cancelAsSystem('booking-1', 'no Pro could be found');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { cancellationFeeAmount: string; refundedAmount: string } }],
      ];
      expect(call.data.cancellationFeeAmount).toBe('0.00');
      expect(call.data.refundedAmount).toBe('1000.00');
    });

    it('does not charge an ops cancellation inside the cutoff either', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(
        bookingIn('en_route', { slotStartAt: slotIn(1) }),
      );
      const service = buildService(deps);

      await service.cancelAsOps('admin-1', 'booking-1', 'safety incident');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { cancellationFeeAmount: string } }],
      ];
      expect(call.data.cancellationFeeAmount).toBe('0.00');
    });

    it('charges nothing on a booking that never had a slot', async () => {
      const deps = buildDeps();
      // No slot means no promise about a time, and charging against a time
      // that was never agreed is a surprise rather than a policy.
      const booking = bookingIn('assigned', { slotStartAt: null });
      deps.bookings.getOwnedBooking.mockResolvedValue(booking);
      deps.bookings.getByIdOrFail.mockResolvedValue(booking);
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'mistake');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { cancellationFeeAmount: string } }],
      ];
      expect(call.data.cancellationFeeAmount).toBe('0.00');
    });
  });

  describe('the refund', () => {
    it('refunds nothing in window A — nothing was ever charged', async () => {
      const deps = buildDeps();
      const unpaid = bookingIn('created', { paymentStatus: 'unpaid' });
      deps.bookings.getOwnedBooking.mockResolvedValue(unpaid);
      deps.bookings.getByIdOrFail.mockResolvedValue(unpaid);
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'mistake');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { refundedAmount: string } }],
      ];
      expect(call.data.refundedAmount).toBe('0.00');
      expect(deps.payments.initiateRefund).not.toHaveBeenCalled();
    });

    it('refunds in full in window B', async () => {
      const deps = buildDeps();
      deps.bookings.getOwnedBooking.mockResolvedValue(bookingIn('assigning'));
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('assigning'));
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'changed plans');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { refundedAmount: string } }],
      ];
      expect(call.data.refundedAmount).toBe('1000.00');
    });

    it('refunds the payable amount, not the list price', async () => {
      const deps = buildDeps();
      // A 1,000-rupee job, 400 of it paid with coins and a plan discount. The
      // customer is owed the 600 the platform actually took — refunding the
      // list price would hand them money that never changed hands.
      const discounted = bookingIn('assigning', {
        payableAmount: { toString: () => '600.00' },
        coinsRedeemed: 200,
      });
      deps.bookings.getOwnedBooking.mockResolvedValue(discounted);
      deps.bookings.getByIdOrFail.mockResolvedValue(discounted);
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'changed plans');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { refundedAmount: string } }],
      ];
      expect(call.data.refundedAmount).toBe('600.00');
      expect(deps.payments.initiateRefund).toHaveBeenCalledWith(
        'booking-1',
        '600.00',
      );
    });

    it('uses the ops figure in window E and never computes one', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('started'));
      const service = buildService(deps);

      await service.cancelAsOps('admin-1', 'booking-1', 'half done', '350.00');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { refundedAmount: string } }],
      ];
      expect(call.data.refundedAmount).toBe('350.00');
    });

    it('refunds nothing in window E when ops names no amount', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('started'));
      const service = buildService(deps);

      await service.cancelAsOps('admin-1', 'booking-1', 'customer at fault');

      const [[call]] = deps.state.transition.mock.calls as [
        [{ data: { refundedAmount: string; cancellationFeeAmount: string } }],
      ];
      expect(call.data.refundedAmount).toBe('0.00');
      // Window E never reaches the percentage rule — "partial, at ops
      // discretion" is a judgement, and a formula here is what US-4.21 warns
      // against.
      expect(call.data.cancellationFeeAmount).toBe('0');
    });
  });

  describe('coins', () => {
    it('returns redeemed coins on every cancellation', async () => {
      const deps = buildDeps();
      const booking = bookingIn('assigning', { coinsRedeemed: 200 });
      deps.bookings.getOwnedBooking.mockResolvedValue(booking);
      deps.bookings.getByIdOrFail.mockResolvedValue(booking);
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'changed plans');

      expect(deps.loyalty.release).toHaveBeenCalledWith('booking-1');
    });

    it('returns them even when a fee was charged', async () => {
      const deps = buildDeps();
      // The fee is money and the coins are an entitlement. Keeping both would
      // charge the customer twice for one cancellation.
      const booking = bookingIn('arrived', {
        slotStartAt: slotIn(0.5),
        coinsRedeemed: 200,
      });
      deps.bookings.getOwnedBooking.mockResolvedValue(booking);
      deps.bookings.getByIdOrFail.mockResolvedValue(booking);
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'not needed');

      expect(deps.loyalty.release).toHaveBeenCalledWith('booking-1');
    });

    it('does not fail the cancellation when the coins cannot be returned', async () => {
      const deps = buildDeps();
      deps.loyalty.release.mockRejectedValue(new Error('wallet unreachable'));
      const booking = bookingIn('assigning', { coinsRedeemed: 200 });
      deps.bookings.getOwnedBooking.mockResolvedValue(booking);
      deps.bookings.getByIdOrFail.mockResolvedValue(booking);
      const service = buildService(deps);

      // The booking is genuinely cancelled. A customer must not see "cancel"
      // fail because a loyalty credit did.
      await expect(
        service.cancelAsCustomer('cust-1', 'booking-1', 'changed plans'),
      ).resolves.toBeDefined();
    });
  });

  describe('releasing the Pro', () => {
    it('closes the assignment from window C onward', async () => {
      const deps = buildDeps();
      deps.bookings.getOwnedBooking.mockResolvedValue(bookingIn('en_route'));
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('en_route'));
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'not needed');

      // The Pro is physically driving there — every second of delay is a
      // wasted journey.
      expect(deps.dispatch.closeAssignment).toHaveBeenCalledWith(
        'booking-1',
        'not needed',
      );
    });

    it('has no assignment to close in windows A and B', async () => {
      const deps = buildDeps();
      deps.bookings.getOwnedBooking.mockResolvedValue(bookingIn('assigning'));
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('assigning'));
      const service = buildService(deps);

      await service.cancelAsCustomer('cust-1', 'booking-1', 'changed plans');

      expect(deps.dispatch.closeAssignment).not.toHaveBeenCalled();
    });
  });

  describe('describeWindow — the confirm screen', () => {
    it('is computed by the same function that executes the cancellation', async () => {
      const deps = buildDeps();
      const slot = slotIn(0.5);
      const booking = bookingIn('arrived', {
        slotStartAt: slot,
        coinsRedeemed: 120,
      });
      deps.bookings.getByIdOrFail.mockResolvedValue(booking);
      const service = buildService(deps);

      const preview = await service.describeWindow('booking-1');

      expect(preview.window).toBe('D');
      expect(preview.chargesFee).toBe(true);
      expect(preview.feeAmount).toBe('250.00');
      expect(preview.refundAmount).toBe('750.00');
      expect(preview.timing).toBe('late');
      expect(preview.coinsReturned).toBe(120);
      expect(preview.freeCancellationHours).toBe(6);
      // Six hours before the slot — the instant after which it stops being
      // free, which is the one number a customer actually wants.
      expect(preview.freeUntil?.getTime()).toBe(slot.getTime() - 6 * HOUR);
    });

    it('says free, and why, outside the cutoff', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(
        bookingIn('assigned', { slotStartAt: slotIn(48) }),
      );
      const service = buildService(deps);

      const preview = await service.describeWindow('booking-1');

      expect(preview.chargesFee).toBe(false);
      expect(preview.feeAmount).toBe('0.00');
      expect(preview.timing).toBe('early');
      expect(preview.reason).toContain('more than 6 hours');
    });

    it('promises no refund on a booking nobody has paid for', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(
        bookingIn('assigning', { paymentStatus: 'unpaid' }),
      );
      const service = buildService(deps);

      await expect(service.describeWindow('booking-1')).resolves.toMatchObject({
        refundAmount: '0.00',
      });
    });

    it('routes a completed job to disputes rather than pricing a cancellation', async () => {
      const deps = buildDeps();
      deps.bookings.getByIdOrFail.mockResolvedValue(bookingIn('completed'));
      const service = buildService(deps);

      const preview = await service.describeWindow('booking-1');

      expect(preview.window).toBe('F');
      expect(preview.chargesFee).toBe(false);
      expect(preview.reason).toContain('dispute');
    });

    it('tells a subscriber their plan is what made it free', async () => {
      const deps = buildDeps();
      deps.loyalty.perksFor.mockResolvedValue({
        waivesCancellationFee: true,
        extraReschedules: 0,
        planName: 'Homingo Plus',
      });
      deps.bookings.getByIdOrFail.mockResolvedValue(
        bookingIn('arrived', { slotStartAt: slotIn(0.5) }),
      );
      const service = buildService(deps);

      const preview = await service.describeWindow('booking-1');

      expect(preview.feeWaivedBySubscription).toBe(true);
      expect(preview.reason).toContain('plan');
    });
  });
});
