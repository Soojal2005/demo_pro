import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../../common/utils';

export const PAYMENTS_PORT = Symbol('PAYMENTS_PORT');

export interface CreatedOrder {
  orderId: string;
}

/**
 * What Booking needs from Payments (module 7), expressed as an interface
 * Booking owns.
 *
 * Module 7 exists and registers `RealPaymentsAdapter` into the delegate below
 * — but only when Razorpay credentials are configured. With none set it
 * registers nothing and online bookings get the honest 501 from
 * `NoOpPaymentsService`. Because a **cash** booking has no `Order` row at all
 * and skips `awaiting_payment` entirely, the whole cash path runs either way,
 * which is what lets someone with no gateway keys work on the product.
 */
export interface PaymentsPort {
  /**
   * Server-side order creation. Must happen before checkout opens, or the
   * amount could be tampered with client-side (US-7.1).
   */
  createOrder(bookingId: string, amount: string): Promise<CreatedOrder>;

  /**
   * Begin a refund. Asynchronous by nature — Razorpay initiates immediately
   * but settles in roughly 5–7 working days, and "initiated" and "settled"
   * are different states the customer must be able to tell apart.
   */
  initiateRefund(bookingId: string, amount: string): Promise<void>;

  /**
   * May this service, in this city, be booked as cash at all?
   *
   * Asked **before** the booking row exists, because `paymentMode` is frozen
   * at creation — getting it wrong is permanent for that booking, and there is
   * no route anywhere in the API to change it afterwards.
   *
   * Throws rather than returning a boolean: every caller's only sensible
   * response to "no" is to refuse the booking with a reason, and a boolean
   * invites one of them to forget.
   */
  assertCashAllowed(serviceId: string, cityId: string | null): Promise<void>;
}

/**
 * Whether a real gateway is behind the port right now.
 *
 * This is the single source of truth for "can this deployment take an online
 * payment", and it answers from what is actually wired rather than from an
 * environment variable read a second time: module 7 registers its adapter only
 * once Razorpay is fully configured, so anything that re-derived the answer
 * from `RAZORPAY_*` could disagree with the code that has to serve the request.
 */
export const isGatewayRegistered = (port: PaymentsPort): boolean =>
  port instanceof NoOpPaymentsService ? port.isGatewayRegistered : true;

/**
 * The fallback when module 7 registers nothing, and the delegate it registers
 * into.
 *
 * `createOrder` **fails loudly** rather than returning a fake order id. An
 * online booking that appeared to have an order but did not would sit in
 * `awaiting_payment` forever with no way to diagnose why; a `501` at creation
 * says exactly what is missing.
 *
 * `initiateRefund` logs the intent and returns. Module 4's own responsibility
 * in the refund flow is narrow — own the transition, the reason and the actor,
 * and record what was retained. Executing the refund, writing the ledger entry
 * and reversing commission belong to modules 7, 9 and 8.
 */
@Injectable()
export class NoOpPaymentsService implements PaymentsPort {
  private readonly logger = new Logger(NoOpPaymentsService.name);

  /**
   * The real gateway integration, registered at boot by module 7 if it is
   * present and configured.
   *
   * The same indirection `NoOpDispatchService` uses, for the same reason: Nest
   * resolves providers per module, so re-binding `PAYMENTS_PORT` inside
   * `PaymentsModule` would never reach `BookingsService` — it would keep
   * getting *this* class. Making `BookingsModule` import `PaymentsModule`
   * instead would invert the very dependency this port exists to prevent.
   */
  private real: PaymentsPort | null = null;

  register(implementation: PaymentsPort): void {
    this.real = implementation;
    this.logger.log(
      'Payment gateway registered — online bookings can be paid.',
    );
  }

  get isGatewayRegistered(): boolean {
    return this.real !== null;
  }

  createOrder(bookingId: string, amount: string): Promise<CreatedOrder> {
    if (this.real) return this.real.createOrder(bookingId, amount);

    throw apiError(
      'Online payment is not available yet — book with cash on delivery instead',
      HttpStatus.NOT_IMPLEMENTED,
      [
        {
          field: 'paymentMode',
          message: `Payments (module 7) is not built, so no order can be created for booking ${bookingId}`,
          code: 'PAYMENTS_NOT_AVAILABLE',
        },
      ],
    );
  }

  /**
   * Permissive when nothing is registered, and deliberately so.
   *
   * Cash is the default payment mode and the only one that works without a
   * gateway. Refusing it here would take the whole product offline on a
   * deployment with no Razorpay credentials, to enforce a per-service and
   * per-city policy that module 7 is the only thing able to express.
   */
  assertCashAllowed(serviceId: string, cityId: string | null): Promise<void> {
    if (this.real) return this.real.assertCashAllowed(serviceId, cityId);
    return Promise.resolve();
  }

  initiateRefund(bookingId: string, amount: string): Promise<void> {
    if (this.real) return this.real.initiateRefund(bookingId, amount);

    this.logger.warn(
      `Refund of ${amount} recorded against booking ${bookingId}, but Payments (module 7) is not built — nothing has been sent to the gateway.`,
    );
    return Promise.resolve();
  }
}
