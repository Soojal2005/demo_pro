import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Order, Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BookingStateService } from '../bookings/booking-state.service';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import {
  DISPATCH_PORT,
  type DispatchPort,
} from '../bookings/ports/dispatch.port';
import { fromPaise, rupeesEqual, toPaise } from './payments.money';
import {
  advanceStatus,
  isForwardStatus,
  PAYMENT_SETTINGS,
  type OrderStatus,
} from './payments.types';
import { LEDGER_PORT, type LedgerPort } from './ports/ledger.port';
import {
  SUBSCRIPTION_PORT,
  type SubscriptionPort,
} from './ports/subscription.port';
import { RazorpayClient, RazorpayError } from './razorpay.client';
import { verifyCheckoutSignature } from './razorpay.signature';

/** What a payment conversation actually starts from. */
const ORDER_BOOKING_SELECT = {
  id: true,
  bookingNumber: true,
  status: true,
  paymentMode: true,
} satisfies Prisma.BookingSelect;

export type OrderWithBooking = Order & {
  booking: Prisma.BookingGetPayload<{ select: typeof ORDER_BOOKING_SELECT }>;
};

/** What an order is buying. */
export type CheckoutPurpose = 'booking' | 'subscription';

/** What Checkout hands back to the app, and what the app posts to verify. */
export interface CheckoutHandoff {
  orderId: string;
  razorpayOrderId: string;
  keyId: string;
  amount: string;
  currency: string;
  /**
   * Which of the two things this payment buys. The app needs it because the
   * two have different success screens — one lands on a booking, the other on
   * a plan.
   */
  purpose: CheckoutPurpose;
  /** Booking number, or the plan name. What to show on the checkout sheet. */
  reference: string;
  /** Null on a subscription order. Kept so booking clients are unaffected. */
  bookingNumber: string | null;
  customerName: string | null;
  customerContact: string | null;
}

/** Everything a webhook or a verify call knows about one gateway attempt. */
export interface CaptureFacts {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  amountPaise: number;
  method?: string | null;
  attempts?: number;
}

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayClient,
    private readonly state: BookingStateService,
    private readonly settings: PlatformSettingsService,
    @Inject(DISPATCH_PORT) private readonly dispatch: DispatchPort,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
    @Inject(SUBSCRIPTION_PORT)
    private readonly subscriptions: SubscriptionPort,
  ) {}

  // ------------------------------------------------------------------
  // Creation — feature 1, 2, 9
  // ------------------------------------------------------------------

  /**
   * Server-side order creation, before checkout opens.
   *
   * The amount is read from `Booking.payableAmount`, which module 4 froze at
   * creation: the catalogue price less whatever the customer's subscription
   * and Homingo Coins took off it. It is never taken from the client — that is
   * the whole reason this happens server-side (US-7.1). A client that could
   * name its own amount could book a ₹4,000 deep clean for ₹1.
   *
   * **`payableAmount`, not `flatPrice`.** Charging the list price to a
   * customer who was quoted a discounted one is the single worst bug this
   * module could have, and the two columns are one character apart.
   */
  async createForBooking(
    bookingId: string,
    customerId: string,
  ): Promise<CheckoutHandoff> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      // The address is here only for its cityId, which goes into the gateway
      // notes so a Razorpay-side row is traceable without our database.
      include: { customer: true, address: { select: { cityId: true } } },
    });

    if (!booking || booking.customerId !== customerId) {
      // Same message whether it does not exist or belongs to someone else —
      // otherwise this endpoint enumerates other customers' booking ids.
      throw apiError('Booking not found', HttpStatus.NOT_FOUND);
    }

    if (booking.paymentMode !== 'online') {
      throw apiError(
        'This booking is paid in cash at the door, so there is nothing to pay now',
        HttpStatus.CONFLICT,
        [
          {
            field: 'paymentMode',
            message: 'A cash booking has no order',
            code: 'BOOKING_IS_CASH',
          },
        ],
      );
    }

    if (booking.status !== 'awaiting_payment') {
      throw apiError(
        `This booking is ${booking.status}, so it cannot be paid for now`,
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message: 'Only a booking awaiting payment can open checkout',
            code: 'BOOKING_NOT_AWAITING_PAYMENT',
          },
        ],
      );
    }

    const existing = await this.prisma.order.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'desc' },
    });

    if (existing.some((order) => order.status === 'paid')) {
      throw apiError(
        'This booking has already been paid for',
        HttpStatus.CONFLICT,
        [
          {
            field: 'bookingId',
            message: 'A paid order already exists',
            code: 'BOOKING_ALREADY_PAID',
          },
        ],
      );
    }

    // Reissue rather than mutate. An expired order still exists at the
    // gateway with its own attempt history, and overwriting our row would
    // make that history unreachable by receipt.
    const reusable = await this.findReusable(existing);
    if (reusable) return this.toHandoff(reusable, booking);

    const customer = await this.ensureGatewayCustomer(booking.customer);

    const receipt = `${booking.bookingNumber}-${existing.length + 1}`;
    const notes: Record<string, string> = {
      bookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      serviceId: booking.serviceId,
      // The notes are what makes a row in Razorpay's dashboard traceable back
      // to a booking without our database — support's first move.
      ...(booking.address?.cityId ? { cityId: booking.address.cityId } : {}),
    };

    let gatewayOrder;
    try {
      gatewayOrder = await this.razorpay.createOrder({
        amountPaise: toPaise(booking.payableAmount.toString()),
        currency: 'INR',
        receipt,
        notes,
      });
    } catch (cause) {
      throw this.gatewayUnavailable(cause, 'create a payment order');
    }

    const order = await this.prisma.order.create({
      data: {
        bookingId: booking.id,
        customerId: booking.customerId,
        razorpayOrderId: gatewayOrder.id,
        receipt,
        amount: booking.payableAmount,
        amountDue: booking.payableAmount,
        currency: gatewayOrder.currency,
        status: 'created',
        notesJson: notes,
      },
    });

    return this.toHandoff(order, { ...booking, customer });
  }

  /**
   * The same server-side order creation, for a subscription plan.
   *
   * Deliberately a **sibling** of `createForBooking` rather than a
   * generalisation of it. The two share the gateway call, the receipt scheme
   * and the reissue rule, and differ in every precondition: a booking checks
   * payment mode and lifecycle status, a subscription checks that it is still
   * pending and still belongs to the caller. Merging them would produce one
   * method with two disjoint halves behind an `if`.
   *
   * The amount comes from `CustomerSubscription.pricePaid`, frozen when the
   * plan was chosen — never from the live `SubscriptionPlan`, and never from
   * the client. A repricing between choosing a plan and paying for it must not
   * change what the customer was quoted.
   */
  async createForSubscription(
    subscriptionId: string,
    customerId: string,
  ): Promise<CheckoutHandoff> {
    // Module 16 owns every rule about whether this plan can still be bought,
    // and throws with the reason if it cannot.
    const purchasable = await this.subscriptions.getPurchasable(
      subscriptionId,
      customerId,
    );

    const customerRow = await this.prisma.customer.findUnique({
      where: { id: customerId },
    });
    if (!customerRow) {
      throw apiError('Customer not found', HttpStatus.NOT_FOUND);
    }

    const existing = await this.prisma.order.findMany({
      where: { subscriptionId },
      orderBy: { createdAt: 'desc' },
    });

    if (existing.some((order) => order.status === 'paid')) {
      throw apiError(
        'This plan has already been paid for',
        HttpStatus.CONFLICT,
        [
          {
            field: 'subscriptionId',
            message: 'A paid order already exists',
            code: 'SUBSCRIPTION_ALREADY_PAID',
          },
        ],
      );
    }

    // Reissue rather than mutate, exactly as a booking does — an expired order
    // still exists at the gateway with its own attempt history.
    const reusable = await this.findReusable(existing);
    if (reusable) {
      return this.toHandoff(reusable, {
        purpose: 'subscription',
        reference: purchasable.planName,
        bookingNumber: null,
        customer: customerRow,
      });
    }

    const customer = await this.ensureGatewayCustomer(customerRow);

    // `SUB-` prefixed so a receipt is self-describing in Razorpay's dashboard,
    // where booking receipts already read `HB-2026-000123-1`.
    const receipt = `SUB-${purchasable.planCode.toUpperCase()}-${subscriptionId.slice(0, 8)}-${existing.length + 1}`;
    const notes: Record<string, string> = {
      subscriptionId: purchasable.id,
      planCode: purchasable.planCode,
      planName: purchasable.planName,
      customerId,
    };

    let gatewayOrder;
    try {
      gatewayOrder = await this.razorpay.createOrder({
        amountPaise: toPaise(purchasable.pricePaid),
        currency: 'INR',
        receipt,
        notes,
      });
    } catch (cause) {
      throw this.gatewayUnavailable(cause, 'create a payment order');
    }

    const order = await this.prisma.order.create({
      data: {
        // Exactly one of the two is set — the database refuses anything else.
        bookingId: null,
        subscriptionId: purchasable.id,
        customerId,
        razorpayOrderId: gatewayOrder.id,
        receipt,
        amount: purchasable.pricePaid,
        amountDue: purchasable.pricePaid,
        currency: gatewayOrder.currency,
        status: 'created',
        notesJson: notes,
      },
    });

    return this.toHandoff(order, {
      purpose: 'subscription',
      reference: purchasable.planName,
      bookingNumber: null,
      customer,
    });
  }

  /**
   * Feature 9 — saved instruments, via the gateway customer object.
   *
   * **Only the id comes back.** Razorpay holds the tokenised cards and VPAs
   * and offers them at checkout; the platform stores nothing about an
   * instrument and has no column that could. That is what keeps this out of
   * PCI scope entirely.
   */
  private async ensureGatewayCustomer<
    T extends {
      id: string;
      razorpayCustomerId: string | null;
      fullName: string | null;
      phone: string | null;
      email: string | null;
    },
  >(customer: T): Promise<T> {
    if (customer.razorpayCustomerId) return customer;

    try {
      const created = await this.razorpay.createCustomer({
        name: customer.fullName ?? undefined,
        contact: customer.phone ?? undefined,
        email: customer.email ?? undefined,
      });

      await this.prisma.customer.update({
        where: { id: customer.id },
        data: { razorpayCustomerId: created.id },
      });

      return { ...customer, razorpayCustomerId: created.id };
    } catch (cause) {
      // Saved instruments are a convenience. Failing checkout because we
      // could not create the customer object would trade a working payment
      // for a nicer one, so this degrades instead of throwing.
      this.logger.warn(
        `Could not create a Razorpay customer for ${customer.id}; checkout ` +
          `will proceed without saved instruments: ${
            cause instanceof Error ? cause.message : 'unknown'
          }`,
      );
      return customer;
    }
  }

  /**
   * An order Razorpay is still offering. Past the validity window the app is
   * given a fresh one rather than a stale id checkout will refuse.
   */
  private async findReusable(orders: Order[]): Promise<Order | null> {
    const minutes = await this.settings.getNumber(
      PAYMENT_SETTINGS.orderValidityMinutes,
      15,
    );
    const cutoff = new Date(Date.now() - minutes * 60_000);

    return (
      orders.find(
        (order) => order.status !== 'paid' && order.createdAt > cutoff,
      ) ?? null
    );
  }

  // ------------------------------------------------------------------
  // Verification — feature 3
  // ------------------------------------------------------------------

  /**
   * Closes the checkout loop when the app returns from Razorpay.
   *
   * **A valid signature is necessary and nowhere near sufficient.** It proves
   * Razorpay produced this `order_id | payment_id` pair — not that the payment
   * was captured, not for how much, and it is replayable by whoever received
   * it legitimately. So after the HMAC passes, the payment is fetched from the
   * gateway and its status, order and amount are checked against our own row.
   * Only then does anything move.
   *
   * The webhook remains the authority. This exists so the customer sees their
   * booking dispatch immediately instead of waiting on a delivery.
   */
  async verifyCheckout(input: {
    bookingId: string;
    customerId: string;
    razorpayOrderId: string;
    razorpayPaymentId: string;
    signature: string;
  }): Promise<Order> {
    const order = await this.prisma.order.findUnique({
      where: { razorpayOrderId: input.razorpayOrderId },
    });

    if (
      !order ||
      order.bookingId !== input.bookingId ||
      order.customerId !== input.customerId
    ) {
      throw apiError('Order not found', HttpStatus.NOT_FOUND);
    }

    const signatureValid = verifyCheckoutSignature({
      razorpayOrderId: input.razorpayOrderId,
      razorpayPaymentId: input.razorpayPaymentId,
      signature: input.signature,
      keySecret: this.razorpay.keySecretForSignature,
    });

    if (!signatureValid) {
      this.logger.warn(
        `Rejected an unsigned payment claim for order ${input.razorpayOrderId}`,
      );
      throw apiError(
        'We could not verify this payment. Nothing has been charged to you twice — please try again.',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'signature',
            message: 'Signature does not match',
            code: 'PAYMENT_SIGNATURE_INVALID',
          },
        ],
      );
    }

    let payment;
    try {
      payment = await this.razorpay.fetchPayment(input.razorpayPaymentId);
    } catch (cause) {
      throw this.gatewayUnavailable(cause, 'confirm this payment');
    }

    // Each of these is a distinct attack or bug, and none is caught by the
    // signature: a payment against a different order, a payment that was
    // authorized but never captured, and a payment for less than the price.
    const mismatch =
      payment.order_id !== input.razorpayOrderId
        ? 'PAYMENT_ORDER_MISMATCH'
        : payment.status !== 'captured'
          ? 'PAYMENT_NOT_CAPTURED'
          : !rupeesEqual(fromPaise(payment.amount), order.amount.toString())
            ? 'PAYMENT_AMOUNT_MISMATCH'
            : null;

    if (mismatch) {
      this.logger.warn(
        `Refused a signed but unusable payment ${payment.id} for order ` +
          `${input.razorpayOrderId}: ${mismatch} (gateway status ${payment.status}, ` +
          `amount ${payment.amount} paise against ${order.amount.toString()})`,
      );
      throw apiError(
        'This payment has not completed yet. If money has left your account, it will be confirmed shortly.',
        HttpStatus.CONFLICT,
        [{ field: 'razorpayPaymentId', message: 'Not usable', code: mismatch }],
      );
    }

    return this.applyCapture({
      razorpayOrderId: input.razorpayOrderId,
      razorpayPaymentId: payment.id,
      amountPaise: payment.amount,
      method: payment.method,
    });
  }

  // ------------------------------------------------------------------
  // The convergent writer — features 4, 5, 6
  // ------------------------------------------------------------------

  /**
   * The single place an order becomes paid, whichever path found out first.
   *
   * Every field it writes is read from the gateway's own facts, so applying
   * the same capture five times produces a byte-identical row. That, plus the
   * forward-only status rank, is what makes duplicate webhook deliveries safe
   * — not a dedupe table. The Redis short-circuit upstream is an optimisation
   * that correctness does not depend on.
   *
   * The side effects downstream of it — the booking transition and dispatch —
   * run **only on the delivery that actually moved the status**, which is what
   * `isForwardStatus` is for.
   */
  async applyCapture(facts: CaptureFacts): Promise<Order> {
    const order = await this.requireOrder(facts.razorpayOrderId);

    if (
      order.capturedPaymentId &&
      order.capturedPaymentId !== facts.razorpayPaymentId
    ) {
      // Two different payments captured against one order means the customer
      // was very likely charged twice. Overwriting would erase the evidence,
      // so the row stands and reconciliation surfaces it. Support answers the
      // rest from Razorpay's dashboard, by order id.
      this.logger.error(
        `DUPLICATE CAPTURE on order ${order.razorpayOrderId}: already captured by ` +
          `${order.capturedPaymentId}, now told ${facts.razorpayPaymentId}. ` +
          `Left untouched — check the attempt list at Razorpay.`,
      );
      return order;
    }

    const movingToPaid = isForwardStatus(order.status as OrderStatus, 'paid');
    const paidRupees = fromPaise(facts.amountPaise);

    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: advanceStatus(order.status as OrderStatus, 'paid'),
        capturedPaymentId: facts.razorpayPaymentId,
        paymentMethod: facts.method ?? order.paymentMethod,
        // Convergent: the same capture always yields the same timestamp
        // because it comes from the row, not the clock, once set.
        paidAt: order.paidAt ?? new Date(),
        amountPaid: paidRupees,
        amountDue: fromPaise(
          toPaise(order.amount.toString()) - facts.amountPaise,
        ),
        ...(facts.attempts === undefined ? {} : { attempts: facts.attempts }),
        // A capture clears the last failure — it is triage for an unpaid
        // order, and this one is paid.
        failureCode: null,
      },
    });

    if (movingToPaid) {
      await this.onFirstCapture(updated);
    }

    return updated;
  }

  /**
   * Runs once per order, on whichever of webhook or verify won the race.
   *
   * Ordering matters. The booking is marked paid and dispatched **before** the
   * ledger entry, because a booking that took money and never dispatched is a
   * customer-visible failure while a missing ledger row is a rebuildable one.
   */
  private async onFirstCapture(order: Order): Promise<void> {
    // Exactly one of the two is set, enforced by
    // `orders_exactly_one_subject_check`, so this is a total branch rather
    // than a guard with a silent fall-through.
    if (order.subscriptionId) {
      return this.onSubscriptionCapture(order);
    }
    return this.onBookingCapture(order);
  }

  private async onBookingCapture(order: Order): Promise<void> {
    if (!order.bookingId) return;

    const booking = await this.prisma.booking.findUnique({
      where: { id: order.bookingId },
    });
    if (!booking) return;

    await this.prisma.booking.update({
      where: { id: booking.id },
      data: { paymentStatus: 'paid' },
    });

    // Module 4 owns `status`; this goes through its door so the status event,
    // its actor and its timestamp are recorded like every other transition.
    if (booking.status === 'awaiting_payment') {
      await this.state.transition({
        bookingId: booking.id,
        to: 'assigning',
        actorType: 'system',
        actorId: 'system',
        expectedFrom: ['awaiting_payment'],
      });
      await this.dispatch.requestAssignment(booking.id);
    }

    await this.ledger.recordCapture({
      bookingId: booking.id,
      orderId: order.id,
      razorpayPaymentId: order.capturedPaymentId ?? '',
      customerId: order.customerId,
      amount: order.amountPaid.toString(),
    });
  }

  /**
   * The subscription half of first capture.
   *
   * Same ordering rule as the booking half, for the same reason: the thing the
   * customer paid for is handed over **before** the ledger entry. A plan that
   * took money and never activated is a customer-visible failure; a missing
   * ledger row is a rebuildable one.
   *
   * Activation is non-fatal here. The money is already captured, and throwing
   * would make Razorpay retry a webhook that has already done its real work —
   * `applyCapture` is idempotent, so the retry would be harmless but endless.
   * Module 16's own activation is idempotent too, so ops re-running it by hand
   * from the admin route costs nothing.
   */
  private async onSubscriptionCapture(order: Order): Promise<void> {
    if (!order.subscriptionId) return;

    try {
      await this.subscriptions.activateFromPayment(
        order.subscriptionId,
        order.capturedPaymentId ?? order.razorpayOrderId,
      );
    } catch (error) {
      this.logger.error(
        `PAID BUT NOT ACTIVATED: order ${order.razorpayOrderId} captured for ` +
          `subscription ${order.subscriptionId}, but activation failed. The ` +
          'customer has been charged and has no plan — activate it from ' +
          'POST /admin/loyalty/subscriptions/:id/activate.',
        error instanceof Error ? error.stack : String(error),
      );
    }

    await this.ledger.recordCapture({
      // Not a booking. `LedgerEntry.bookingId` is nullable, and the entry is
      // keyed on the order either way.
      bookingId: null,
      subscriptionId: order.subscriptionId,
      orderId: order.id,
      razorpayPaymentId: order.capturedPaymentId ?? '',
      customerId: order.customerId,
      amount: order.amountPaid.toString(),
    });
  }

  /**
   * `payment.authorized` — money is held, not taken.
   *
   * Deliberately does **not** dispatch. An authorized payment can still fail
   * to capture, and sending a Pro to a job on the strength of one would mean
   * travelling against money the platform never receives.
   */
  async applyAuthorized(facts: CaptureFacts): Promise<Order> {
    const order = await this.requireOrder(facts.razorpayOrderId);

    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: advanceStatus(order.status as OrderStatus, 'attempted'),
        paymentMethod: facts.method ?? order.paymentMethod,
        ...(facts.attempts === undefined ? {} : { attempts: facts.attempts }),
      },
    });

    // Only when nothing better has happened. A late `authorized` arriving
    // after a capture must not walk the booking back from paid.
    //
    // A subscription order has no booking to mark, and an authorization is not
    // an activation either way — the plan goes live on capture and nowhere
    // else, which is the whole reason this method deliberately does not
    // dispatch.
    if (order.status !== 'paid' && order.bookingId) {
      await this.prisma.booking.updateMany({
        where: { id: order.bookingId, paymentStatus: 'unpaid' },
        data: { paymentStatus: 'authorized' },
      });
    }

    return updated;
  }

  /**
   * `payment.failed` — records what support will be asked about and nothing
   * else.
   *
   * The booking is left in `awaiting_payment` on purpose. Module 4's hold
   * window already sweeps orders that never get paid, and a customer whose
   * card was declined should be able to try a different one rather than find
   * their booking cancelled underneath them.
   */
  async applyFailure(input: {
    razorpayOrderId: string;
    failureCode?: string | null;
    attempts?: number;
  }): Promise<Order> {
    const order = await this.requireOrder(input.razorpayOrderId);

    return this.prisma.order.update({
      where: { id: order.id },
      data: {
        status: advanceStatus(order.status as OrderStatus, 'attempted'),
        failureCode: input.failureCode ?? order.failureCode,
        ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
      },
    });
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  /**
   * Who owns this booking.
   *
   * Exists for `RealPaymentsAdapter`, which is called by module 4 during
   * creation and so is already acting for the customer — there is no request
   * to take an id from. Every customer-facing route passes the authenticated
   * id instead, so ownership is still checked on the paths where it could be
   * forged.
   */
  async customerIdFor(bookingId: string): Promise<string> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { customerId: true },
    });

    if (!booking) throw apiError('Booking not found', HttpStatus.NOT_FOUND);
    return booking.customerId;
  }

  async findForBooking(
    bookingId: string,
    customerId?: string,
  ): Promise<Order[]> {
    return this.prisma.order.findMany({
      where: { bookingId, ...(customerId ? { customerId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByIdOrFail(id: string): Promise<Order> {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw apiError('Order not found', HttpStatus.NOT_FOUND);
    return order;
  }

  /**
   * The booking is joined in because support searches by booking number, not
   * by uuid — "HB-2026-000123" is what the customer reads off their receipt
   * and what every conversation about a payment starts with.
   */
  list(where: Prisma.OrderWhereInput, take: number, skip: number) {
    return this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
        skip,
        include: { booking: { select: ORDER_BOOKING_SELECT } },
      }),
      this.prisma.order.count({ where }),
    ]);
  }

  /**
   * The attempt history this module deliberately does not store, fetched live
   * when support asks for it. Never persisted — that is the trade the module
   * made in exchange for having no local payment data to drift.
   */
  async fetchAttempts(razorpayOrderId: string) {
    try {
      return await this.razorpay.fetchPaymentsForOrder(razorpayOrderId);
    } catch (cause) {
      throw this.gatewayUnavailable(cause, 'fetch the attempt history');
    }
  }

  // ------------------------------------------------------------------

  private async requireOrder(razorpayOrderId: string): Promise<Order> {
    const order = await this.prisma.order.findUnique({
      where: { razorpayOrderId },
    });

    if (!order) {
      // A gateway event for an order we never created. Real causes: a shared
      // Razorpay account across environments, or a replayed delivery after a
      // database restore. Neither is fixable here.
      throw apiError(`No order for ${razorpayOrderId}`, HttpStatus.NOT_FOUND, [
        { message: 'Unknown gateway order', code: 'ORDER_UNKNOWN' },
      ]);
    }

    return order;
  }

  private toHandoff(
    order: Order,
    subject: {
      purpose?: CheckoutPurpose;
      reference?: string;
      bookingNumber: string | null;
      customer: { fullName: string | null; phone: string | null };
    },
  ): CheckoutHandoff {
    const purpose: CheckoutPurpose =
      subject.purpose ?? (order.subscriptionId ? 'subscription' : 'booking');

    return {
      orderId: order.id,
      razorpayOrderId: order.razorpayOrderId,
      keyId: this.razorpay.publicKeyId,
      amount: order.amount.toString(),
      currency: order.currency,
      purpose,
      reference: subject.reference ?? subject.bookingNumber ?? order.receipt,
      bookingNumber: subject.bookingNumber,
      customerName: subject.customer.fullName,
      customerContact: subject.customer.phone,
    };
  }

  /**
   * Gateway failures reach the customer as a plain "try again", never as
   * Razorpay's own error text — that is written for a developer reading their
   * dashboard and routinely names internal detail.
   */
  private gatewayUnavailable(cause: unknown, what: string) {
    if (cause instanceof RazorpayError) {
      this.logger.error(
        `Razorpay refused to ${what}: ${cause.code ?? cause.status} ${cause.description ?? cause.message}`,
      );
    } else {
      this.logger.error(`Could not ${what}`, cause as Error);
    }

    return apiError(
      'We could not reach our payment provider just now. Please try again in a moment.',
      HttpStatus.SERVICE_UNAVAILABLE,
      [
        {
          message: `Gateway call failed: ${what}`,
          code: 'GATEWAY_UNAVAILABLE',
        },
      ],
    );
  }
}
