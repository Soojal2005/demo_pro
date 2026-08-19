import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Order } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { fromPaise, toPaise } from './payments.money';
import { advanceRefundStatus, type RefundStatus } from './payments.types';
import {
  COMMISSION_REVERSAL_PORT,
  type CommissionReversalPort,
} from './ports/commission-reversal.port';
import { LEDGER_PORT, type LedgerPort } from './ports/ledger.port';
import { RazorpayClient } from './razorpay.client';

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayClient,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
    @Inject(COMMISSION_REVERSAL_PORT)
    private readonly commissionReversal: CommissionReversalPort,
  ) {}

  /**
   * Feature 8 — full and partial refunds, tracked through **both** states.
   *
   * The call returns in a second; the money lands in 5–7 working days. A
   * customer told only "refunded" on day one will phone on day three, so
   * `initiated` and `settled` are distinct states and the app can say which.
   *
   * Called both by an ops admin directly and by module 4's cancellation flow
   * through `PaymentsPort.initiateRefund`.
   */
  async initiate(input: {
    bookingId: string;
    /** Rupees. Omit for a full refund of whatever was captured. */
    amount?: string;
    adminId?: string;
    reason?: string;
  }): Promise<Order> {
    const order = await this.paidOrderFor(input.bookingId);

    const capturedPaise = toPaise(order.amountPaid.toString());
    const alreadyRefundedPaise = order.refundAmount
      ? toPaise(order.refundAmount.toString())
      : 0;
    const remainingPaise = capturedPaise - alreadyRefundedPaise;

    if (remainingPaise <= 0) {
      throw apiError(
        'This payment has already been refunded in full',
        HttpStatus.CONFLICT,
        [
          {
            field: 'amount',
            message: 'Nothing left to refund',
            code: 'REFUND_ALREADY_FULL',
          },
        ],
      );
    }

    const requestedPaise =
      input.amount === undefined ? remainingPaise : toPaise(input.amount);

    if (requestedPaise <= 0) {
      throw apiError(
        'A refund must be for more than zero',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'amount',
            message: 'Must be positive',
            code: 'REFUND_AMOUNT_INVALID',
          },
        ],
      );
    }

    if (requestedPaise > remainingPaise) {
      // The database has the same rule as a CHECK constraint; this exists so
      // the caller gets a sentence rather than a constraint violation.
      throw apiError(
        `Only ${fromPaise(remainingPaise)} of this payment is left to refund`,
        HttpStatus.CONFLICT,
        [
          {
            field: 'amount',
            message: 'Exceeds the captured amount less refunds already made',
            code: 'REFUND_EXCEEDS_CAPTURED',
          },
        ],
      );
    }

    let refund;
    try {
      refund = await this.razorpay.createRefund({
        razorpayPaymentId: order.capturedPaymentId!,
        // Razorpay treats an omitted amount as "refund everything", which is
        // its own convention and worth keeping rather than translating.
        ...(requestedPaise === capturedPaise && alreadyRefundedPaise === 0
          ? {}
          : { amountPaise: requestedPaise }),
        notes: {
          bookingId: order.bookingId,
          ...(input.reason ? { reason: input.reason } : {}),
        },
      });
    } catch (cause) {
      this.logger.error(
        `Refund of ${fromPaise(requestedPaise)} for booking ${input.bookingId} was refused by the gateway`,
        cause as Error,
      );
      throw apiError(
        'We could not start this refund with our payment provider. Nothing has been taken from the customer, and no refund has been sent.',
        HttpStatus.SERVICE_UNAVAILABLE,
        [{ message: 'Refund call failed', code: 'REFUND_GATEWAY_FAILED' }],
      );
    }

    const cumulativePaise = alreadyRefundedPaise + requestedPaise;

    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        // CUMULATIVE across refunds — a partial refund followed by another
        // must not look like the second one alone.
        refundAmount: fromPaise(cumulativePaise),
        razorpayRefundId: refund.id,
        refundStatus: advanceRefundStatus(
          order.refundStatus as RefundStatus,
          'initiated',
        ),
        ...(input.adminId ? { refundInitiatedByAdminId: input.adminId } : {}),
      },
    });

    await this.prisma.booking.update({
      where: { id: order.bookingId },
      data: { refundedAmount: fromPaise(cumulativePaise) },
    });

    // Module 8. Non-fatal: the refund has already succeeded at the gateway by
    // this point, and failing the call now would tell the caller nothing was
    // refunded when the customer's money is already on its way back.
    //
    // Only a FULL refund reverses the Pro's pay. A partial is discretionary —
    // ops returning part of the fee on a job the Pro did properly — and taking
    // their whole commission for it would punish them for somebody else's
    // decision. Module 8 logs the partial; ops reverses by hand if the Pro is
    // genuinely at fault.
    try {
      await this.commissionReversal.onRefund({
        bookingId: order.bookingId,
        amount: fromPaise(requestedPaise),
        isFullRefund: cumulativePaise >= capturedPaise,
        reason: input.reason,
        adminId: input.adminId,
      });
    } catch (error) {
      this.logger.error(
        `Refund on booking ${order.bookingId} succeeded, but the Pro's commission was not reversed.`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return updated;
  }

  /**
   * `refund.created` — the gateway acknowledging the call we just made.
   *
   * Almost always redundant, since `initiate` already wrote `initiated`. It
   * matters when a refund was raised from Razorpay's own dashboard, which ops
   * does during an incident: without this, that refund would never appear on
   * the order at all.
   */
  async applyRefundInitiated(
    razorpayRefundId: string,
    razorpayPaymentId: string,
  ): Promise<void> {
    const order = await this.orderByPayment(razorpayPaymentId);
    if (!order) return;

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        razorpayRefundId: order.razorpayRefundId ?? razorpayRefundId,
        refundStatus: advanceRefundStatus(
          order.refundStatus as RefundStatus,
          'initiated',
        ),
      },
    });
  }

  /**
   * `refund.processed` — the money has actually landed, days later.
   *
   * `Booking.paymentStatus` becomes `refunded` **only on a full refund**. A
   * partial refund leaves it `paid`, because it is still true: the platform
   * kept part of that money, and a booking that reads `refunded` while
   * holding a cancellation fee would misstate what happened.
   */
  async applyRefundSettled(input: {
    razorpayRefundId: string;
    razorpayPaymentId: string;
    amountPaise: number;
  }): Promise<void> {
    const order = await this.orderByPayment(input.razorpayPaymentId);
    if (!order) return;

    const updated = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        razorpayRefundId: order.razorpayRefundId ?? input.razorpayRefundId,
        refundStatus: advanceRefundStatus(
          order.refundStatus as RefundStatus,
          'settled',
        ),
        // Convergent, like every other webhook write: a redelivery reads the
        // timestamp already on the row rather than moving it to now.
        refundedAt: order.refundedAt ?? new Date(),
      },
    });

    const refunded = updated.refundAmount
      ? toPaise(updated.refundAmount.toString())
      : 0;
    const captured = toPaise(updated.amountPaid.toString());

    // `bookingId` is null when the order bought a subscription. There is no
    // `paymentStatus` to move in that case — the subscription's own status is
    // what says whether it is still live, and ops sets that when they decide
    // what a part-used plan is worth back.
    if (refunded >= captured && captured > 0 && updated.bookingId) {
      await this.prisma.booking.update({
        where: { id: updated.bookingId },
        data: { paymentStatus: 'refunded' },
      });
    }

    await this.ledger.recordRefund({
      bookingId: updated.bookingId,
      orderId: updated.id,
      razorpayPaymentId: input.razorpayPaymentId,
      razorpayRefundId: input.razorpayRefundId,
      customerId: updated.customerId,
      amount: fromPaise(input.amountPaise),
    });
  }

  /**
   * `refund.failed` — rare, and the one case where the amount deliberately
   * stays on the row.
   *
   * Zeroing `refundAmount` here would make the order look untouched, hiding
   * money the platform still owes. The failure is the thing that needs to be
   * visible; ops retries from the admin route.
   */
  async applyRefundFailed(
    razorpayRefundId: string,
    razorpayPaymentId: string,
  ): Promise<void> {
    const order = await this.orderByPayment(razorpayPaymentId);
    if (!order) return;

    this.logger.error(
      `Refund ${razorpayRefundId} FAILED at the gateway for booking ${order.bookingId}. ` +
        `The customer is still owed ${order.refundAmount?.toString() ?? 'an unrecorded amount'}.`,
    );

    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        refundStatus: advanceRefundStatus(
          order.refundStatus as RefundStatus,
          'failed',
        ),
      },
    });
  }

  private async orderByPayment(
    razorpayPaymentId: string,
  ): Promise<Order | null> {
    const order = await this.prisma.order.findUnique({
      where: { capturedPaymentId: razorpayPaymentId },
    });

    if (!order) {
      this.logger.warn(
        `Refund event for payment ${razorpayPaymentId}, which is not the captured ` +
          `attempt of any order here. Ignored.`,
      );
    }

    return order;
  }

  /**
   * The captured order behind one booking.
   *
   * Returns `Order & { bookingId: string }` rather than a bare `Order`,
   * because everything downstream writes back to the booking and `bookingId`
   * became nullable in module 16 — an order can now belong to a subscription
   * instead. Narrowing here, where the row was found *by* `bookingId`, keeps
   * the rest of this service free of guards that could never fire.
   */
  private async paidOrderFor(
    bookingId: string,
  ): Promise<Order & { bookingId: string }> {
    const order = await this.prisma.order.findFirst({
      where: { bookingId, status: 'paid' },
      orderBy: { paidAt: 'desc' },
    });

    if (!order?.capturedPaymentId) {
      throw apiError(
        'There is no captured payment on this booking to refund',
        HttpStatus.CONFLICT,
        [
          {
            field: 'bookingId',
            // The most common real cause, and the one worth naming: a cash
            // booking has no Order row at all, so there is nothing to refund
            // through a gateway that was never involved.
            message:
              'No paid order exists — a cash booking has no gateway payment',
            code: 'NO_CAPTURED_PAYMENT',
          },
        ],
      );
    }

    // Safe by construction: the row was found *by* `bookingId`, so the column
    // that became nullable in module 16 cannot be null on this path.
    return order as Order & { bookingId: string };
  }
}
