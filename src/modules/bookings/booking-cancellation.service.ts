import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { fromPaise, toPaise } from '../payments/payments.money';
import type { Booking } from '../../prisma/client';
import type {
  BookingStatus,
  CancellationWindow,
  CancelledByType,
} from './booking.types';
import { cancellationWindowFor, windowRequiresOps } from './booking.types';
import { BookingStateService } from './booking-state.service';
import { BookingsService } from './bookings.service';
import { decideCancellation, type PolicyDecision } from './cancellation-policy';
import { DISPATCH_PORT, type DispatchPort } from './ports/dispatch.port';
import { LOYALTY_PORT, type LoyaltyPort } from './ports/loyalty.port';
import { PAYMENTS_PORT, type PaymentsPort } from './ports/payments.port';
import { PlatformSettingsService } from './platform-settings.service';

interface CancelInput {
  bookingId: string;
  reason: string;
  cancelledByType: CancelledByType;
  actorId: string;
  /** Window E only — a human's number, not a computed one. */
  refundAmount?: string;
  /** Overrides the configured window-D fee. */
  cancellationFeeAmount?: string;
}

/**
 * Cancellation across the six windows.
 *
 * Module 4's responsibility here is deliberately narrow: **own the transition,
 * the reason and the actor, and record what was retained.** Executing the
 * refund belongs to module 7, reversing commission to module 8, and the ledger
 * entries to module 9. What this service must get right is *which window* a
 * booking is in, because that decides everything the other modules then do.
 *
 * Four principles from the scope document shape all of it:
 * nothing is deleted, a Pro can never cancel, salary decouples cancellation
 * from Pro pay, and refunds are asynchronous.
 */
@Injectable()
export class BookingCancellationService {
  private readonly logger = new Logger(BookingCancellationService.name);

  constructor(
    private readonly state: BookingStateService,
    private readonly bookings: BookingsService,
    private readonly settings: PlatformSettingsService,
    @Inject(DISPATCH_PORT) private readonly dispatch: DispatchPort,
    @Inject(PAYMENTS_PORT) private readonly payments: PaymentsPort,
    @Inject(LOYALTY_PORT) private readonly loyalty: LoyaltyPort,
  ) {}

  /**
   * The customer's own path. Available any time before the job starts; after
   * that only support can act, because window E is a judgement call.
   */
  async cancelAsCustomer(
    customerId: string,
    bookingId: string,
    reason: string,
  ): Promise<Booking> {
    const booking = await this.bookings.getOwnedBooking(customerId, bookingId);
    const window = this.windowOrFail(booking);

    if (windowRequiresOps(window)) {
      throw apiError(
        'This job has already started. Contact support to stop it — they can arrange a partial refund.',
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message: 'Cancelling a job in progress needs a support agent',
            code: 'CANCELLATION_NEEDS_SUPPORT',
          },
        ],
      );
    }

    return this.cancel({
      bookingId,
      reason,
      cancelledByType: 'customer',
      actorId: customerId,
    });
  }

  /**
   * Ops. Reaches every window including E, and is the only path that may set a
   * discretionary refund.
   */
  async cancelAsOps(
    adminId: string,
    bookingId: string,
    reason: string,
    refundAmount?: string,
    cancellationFeeAmount?: string,
  ): Promise<Booking> {
    return this.cancel({
      bookingId,
      reason,
      cancelledByType: 'ops',
      actorId: adminId,
      refundAmount,
      cancellationFeeAmount,
    });
  }

  /**
   * The system's own path: a payment hold that expired, a recurring plan that
   * ended, dispatch exhausted with nobody found.
   *
   * **Never charges a fee.** When the platform is the party that failed,
   * charging the customer for it is the one thing US-4.22 rules out flatly.
   */
  async cancelAsSystem(bookingId: string, reason: string): Promise<Booking> {
    return this.cancel({
      bookingId,
      reason,
      cancelledByType: 'system',
      actorId: 'system',
      cancellationFeeAmount: '0.00',
    });
  }

  /**
   * Cancels online bookings that sat in `awaiting_payment` past the hold
   * window — US-4.6, so an abandoned checkout does not clog the pipeline.
   *
   * Window A, so nothing was ever charged and nothing is refunded. Driven by a
   * scheduled job once module 12 brings a scheduler; exposed as an admin route
   * meanwhile so it can be run and tested.
   *
   * **Known follow-on, unhandled here:** if the customer pays *after* this
   * runs, the gateway webhook arrives for a cancelled booking. US-4.6 says the
   * payment is then recorded and immediately refunded — that is module 7's to
   * implement when the webhook exists, and there is nothing to hook it to yet.
   */
  async expireUnpaidBookings(now = new Date()): Promise<{ cancelled: number }> {
    const holdMinutes = await this.settings.getNumber(
      'booking.paymentHoldWindowMinutes',
      30,
    );
    const cutoff = new Date(now.getTime() - holdMinutes * 60_000);

    const stale = await this.bookings.findAwaitingPaymentBefore(cutoff);

    let cancelled = 0;
    for (const booking of stale) {
      try {
        await this.cancelAsSystem(
          booking.id,
          `Payment not completed within ${holdMinutes} minutes`,
        );
        cancelled += 1;
      } catch {
        // A booking that moved on between the query and the cancel is not an
        // error — the sweep is best-effort and runs again shortly.
      }
    }

    return { cancelled };
  }

  /**
   * "What happens if I cancel this right now?" — the screen a customer sees
   * before they confirm, and the read ops uses to answer the same question on
   * the phone.
   *
   * Deliberately computed by the **same function that executes the
   * cancellation**, not by a parallel description of it. A preview that can
   * disagree with the action is worse than no preview: the customer is shown a
   * number, agrees to it, and is charged a different one.
   */
  async describeWindow(
    bookingId: string,
    now = new Date(),
  ): Promise<{
    window: CancellationWindow | null;
    chargesFee: boolean;
    requiresOps: boolean;
    feeAmount: string;
    refundAmount: string;
    coinsReturned: number;
    timing: string;
    hoursUntilSlot: number | null;
    freeCancellationHours: number;
    freeUntil: Date | null;
    reason: string;
    feeWaivedBySubscription: boolean;
  }> {
    const booking = await this.bookings.getByIdOrFail(bookingId);
    const window = cancellationWindowFor(booking.status as BookingStatus);

    if (window === null || window === 'F') {
      return {
        window,
        chargesFee: false,
        requiresOps: false,
        feeAmount: '0.00',
        refundAmount: '0.00',
        coinsReturned: 0,
        timing: 'unscheduled',
        hoursUntilSlot: null,
        freeCancellationHours: 0,
        freeUntil: null,
        reason:
          window === 'F'
            ? 'This job is already complete — raise a dispute through support instead.'
            : 'This booking is already cancelled.',
        feeWaivedBySubscription: false,
      };
    }

    const config = await this.readPolicyConfig(booking.customerId);
    const decision = decideCancellation({
      status: booking.status as BookingStatus,
      slotStartAt: booking.slotStartAt,
      payableAmount: booking.payableAmount.toString(),
      freeCancellationHours: config.freeCancellationHours,
      lateCancellationFeePercent: config.lateCancellationFeePercent,
      windowDFeeAmount: config.windowDFeeAmount,
      subscriptionWaivesFee: config.waivesCancellationFee,
      cancelledByType: 'customer',
      now,
    });

    return {
      window,
      chargesFee: decision.feeAmount !== '0.00',
      requiresOps: windowRequiresOps(window),
      feeAmount: decision.feeAmount,
      // Nothing is refunded on a booking nobody has paid for yet.
      refundAmount:
        booking.paymentStatus === 'paid' ? decision.refundAmount : '0.00',
      // Coins go back whatever the fee, and whatever the payment status —
      // they were spent at creation, not at capture.
      coinsReturned: booking.coinsRedeemed,
      timing: decision.timing,
      hoursUntilSlot: decision.hoursUntilSlot,
      freeCancellationHours: config.freeCancellationHours,
      freeUntil: booking.slotStartAt
        ? new Date(
            booking.slotStartAt.getTime() -
              config.freeCancellationHours * 3_600_000,
          )
        : null,
      reason: decision.reason,
      feeWaivedBySubscription: decision.feeWaivedBySubscription,
    };
  }

  // ------------------------------------------------------------------

  private async cancel(input: CancelInput): Promise<Booking> {
    const booking = await this.bookings.getByIdOrFail(input.bookingId);
    const window = this.windowOrFail(booking);

    const decision = await this.decide(booking, window, input);
    const fee = this.resolveFee(window, input, decision);
    const refund = this.resolveRefund(booking, window, input, fee);

    // Release the Pro before anything else. Window D exists because someone is
    // physically driving to this address — every second of delay is a wasted
    // journey (US-4.20).
    if (['C', 'D', 'E'].includes(window)) {
      await this.dispatch.closeAssignment(booking.id, input.reason);
    }

    const cancelled = await this.state.transition({
      bookingId: booking.id,
      to: 'cancelled',
      actorType: input.cancelledByType,
      actorId: input.actorId,
      expectedFrom: BookingsService.liveStatuses,
      data: {
        cancelledAt: new Date(),
        cancelReason: input.reason,
        cancelledByType: input.cancelledByType,
        cancellationFeeAmount: fee,
        refundedAmount: refund,
        // Nothing is deleted or edited: the assignment columns keep whatever
        // they held, and the status event records what happened to them.
        assignmentOutcome: booking.proId
          ? 'cancelled'
          : booking.assignmentOutcome,
      },
    });

    // Windows A and B never charged anything, so there is nothing to send.
    if (Number(refund) > 0 && booking.paymentStatus === 'paid') {
      await this.payments.initiateRefund(booking.id, refund);
    }

    // Coins go back, and the subscription's booking allowance with them.
    //
    // Unconditional on the fee and on the payment status: coins were spent
    // when the booking was created, not when it was captured, so a customer
    // who cancels an unpaid booking is still owed them. Non-fatal for the same
    // reason the commission call is — the booking is genuinely cancelled, and
    // a customer must not see "cancel" fail because a loyalty credit did.
    // Idempotent on the other side, so a support retry does not double-credit.
    try {
      await this.loyalty.release(booking.id);
    } catch (error) {
      this.logger.error(
        `Booking ${booking.id} was cancelled, but its ${booking.coinsRedeemed} redeemed coins were not returned. Return them with a wallet adjustment.`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return cancelled;
  }

  /**
   * Which fee the policy produces for this booking, right now.
   *
   * Reads the customer's subscription perks, so a plan that waives the fee
   * does so here rather than in three separate call sites.
   */
  private async decide(
    booking: Booking,
    window: CancellationWindow,
    input: CancelInput,
  ): Promise<PolicyDecision> {
    const config = await this.readPolicyConfig(booking.customerId);

    return decideCancellation({
      status: booking.status as BookingStatus,
      slotStartAt: booking.slotStartAt,
      payableAmount: booking.payableAmount.toString(),
      freeCancellationHours: config.freeCancellationHours,
      lateCancellationFeePercent: config.lateCancellationFeePercent,
      windowDFeeAmount: config.windowDFeeAmount,
      subscriptionWaivesFee: config.waivesCancellationFee,
      cancelledByType: input.cancelledByType,
      now: new Date(),
    });
  }

  private async readPolicyConfig(customerId: string): Promise<{
    freeCancellationHours: number;
    lateCancellationFeePercent: number;
    windowDFeeAmount: string;
    waivesCancellationFee: boolean;
  }> {
    const [
      freeCancellationHours,
      lateCancellationFeePercent,
      windowDFeeAmount,
      perks,
    ] = await Promise.all([
      this.settings.getNumber('booking.freeCancellationHours', 6),
      this.settings.getNumber('booking.lateCancellationFeePercent', 25),
      this.configuredFee(),
      // Bound to a no-op returning no perks when module 16 is absent, so this
      // whole path works unchanged on a deployment without loyalty.
      this.loyalty.perksFor(customerId),
    ]);

    return {
      freeCancellationHours: Math.max(0, freeCancellationHours),
      lateCancellationFeePercent,
      windowDFeeAmount,
      waivesCancellationFee: perks.waivesCancellationFee,
    };
  }

  private windowOrFail(booking: Booking): CancellationWindow {
    const window = cancellationWindowFor(booking.status as BookingStatus);

    if (window === null) {
      throw apiError('This booking is already cancelled', HttpStatus.CONFLICT);
    }
    // Window F is not a cancellation at all. A completed job is disputed,
    // which is a different path with a different evidence bar (module 11).
    if (window === 'F') {
      throw apiError(
        'This job is already complete. Raise a dispute through support instead.',
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message: 'A completed job cannot be cancelled',
            code: 'BOOKING_ALREADY_COMPLETED',
          },
        ],
      );
    }

    return window;
  }

  /**
   * What the platform retains.
   *
   * An explicit amount from ops always wins — a human looking at the case is
   * the one authority this policy does not try to replace. Otherwise the fee
   * is whatever `decideCancellation` decided, which is the same function the
   * customer's preview screen was rendered from.
   *
   * `window` is still taken so the signature says what the decision depends
   * on, and so a window-E cancellation — which never reaches the policy —
   * cannot silently pick up a percentage fee.
   */
  private resolveFee(
    window: CancellationWindow,
    input: CancelInput,
    decision: PolicyDecision,
  ): string {
    if (input.cancellationFeeAmount !== undefined) {
      return input.cancellationFeeAmount;
    }
    // Window E is "partial, at ops discretion" — a fee computed here would be
    // exactly the formula US-4.21 warns against.
    if (windowRequiresOps(window)) return '0';
    return decision.feeAmount;
  }

  private resolveRefund(
    booking: Booking,
    window: CancellationWindow,
    input: CancelInput,
    fee: string,
  ): string {
    // Nothing was ever charged in window A.
    if (window === 'A' || booking.paymentStatus !== 'paid') return '0.00';

    if (window === 'E') {
      // Deliberately not computed. "Partial, at ops discretion" — routing this
      // to a formula is exactly what US-4.21 warns against.
      return input.refundAmount ?? '0.00';
    }

    // `payableAmount`, not `flatPrice`. A customer who paid ₹400 of a ₹500 job
    // after a subscription discount and a coin redemption is owed ₹400 back —
    // refunding the list price would hand them money the platform never took,
    // and the coins they spent are returned separately by `loyalty.release`.
    return fromPaise(
      Math.max(0, toPaise(booking.payableAmount.toString()) - toPaise(fee)),
    );
  }

  private configuredFee(): Promise<string> {
    return this.settings
      .getNumber('booking.cancellationFeeAmount', 0)
      .then((value) => value.toFixed(2));
  }
}
