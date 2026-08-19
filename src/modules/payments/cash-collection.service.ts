import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Booking } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LEDGER_PORT, type LedgerPort } from './ports/ledger.port';
import { SUPPORT_PORT, type SupportPort } from './ports/support.port';

/** Job states where a Pro is actually at the door with the customer. */
const COLLECTABLE_STATUSES = ['started', 'completed'];

@Injectable()
export class CashCollectionService {
  private readonly logger = new Logger(CashCollectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(LEDGER_PORT) private readonly ledger: LedgerPort,
    @Inject(SUPPORT_PORT) private readonly support: SupportPort,
  ) {}

  /**
   * Feature 13 — collection at the door.
   *
   * **The amount is not a parameter.** It is `payableAmount` or it is
   * nothing. A Pro who could type an amount could under-declare what they
   * collected and pocket the difference, and no later reconciliation would
   * find it — the booking would agree with the ledger, and both would be
   * wrong. The database carries the same rule as a CHECK constraint, so it
   * holds even if some future caller forgets it.
   *
   * `payableAmount` rather than `flatPrice` since module 16: a customer who
   * put 200 coins against a ₹500 job owes ₹300 at the door, and a Pro
   * insisting on ₹500 because the app told them to is the argument this one
   * column change prevents.
   *
   * `paymentStatus = paid` after this means **an employee is carrying
   * banknotes**, not that the platform has the money. Nothing downstream may
   * read it without reading `paymentMode` beside it.
   */
  async collect(proId: string, bookingId: string): Promise<Booking> {
    const booking = await this.collectableOrFail(proId, bookingId);

    if (booking.cashCollectedAt) {
      // Idempotent: a Pro tapping twice on a bad connection has not collected
      // twice, and treating it as an error would push them to work around it.
      return booking;
    }

    const collected = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: {
          cashCollectedAmount: booking.payableAmount,
          cashCollectedAt: new Date(),
          paymentStatus: 'paid',
        },
      });

      // In the same transaction as the collection, because a Pro's balance
      // that disagreed with the bookings behind it is exactly the drift
      // feature 18's reconciliation exists to catch — it should not be
      // manufactured here.
      await tx.pro.update({
        where: { id: proId },
        data: { cashInHand: { increment: booking.payableAmount } },
      });

      return updated;
    });

    await this.ledger.recordCashCollection({
      bookingId: collected.id,
      proId,
      customerId: collected.customerId,
      amount: collected.cashCollectedAmount!.toString(),
    });

    return collected;
  }

  /**
   * Feature 17 — the customer who will not pay.
   *
   * Everything about this is deliberate and none of it is punitive:
   *
   * - the job still **completes**, because the work was done;
   * - `paymentStatus` stays `unpaid`, because it is;
   * - `cashInHand` does not move, because no money changed hands;
   * - the Pro is **still paid their commission**, which module 8 computes from
   *   the completed booking and never from whether the customer paid;
   * - a billing ticket is raised for ops to chase.
   *
   * The Pro did their job. The platform's failure to collect is not theirs.
   */
  async decline(
    proId: string,
    bookingId: string,
    reason: string,
  ): Promise<Booking> {
    const booking = await this.collectableOrFail(proId, bookingId);

    if (booking.cashCollectedAt) {
      throw apiError(
        'This job has already been paid for in cash',
        HttpStatus.CONFLICT,
        [
          {
            field: 'bookingId',
            message: 'Cash was already collected',
            code: 'CASH_ALREADY_COLLECTED',
          },
        ],
      );
    }

    if (booking.cashDeclinedAt) return booking;

    const declined = await this.prisma.booking.update({
      where: { id: booking.id },
      data: { cashDeclinedAt: new Date(), cashDeclinedReason: reason },
    });

    this.logger.warn(
      `Booking ${booking.bookingNumber} completed unpaid: ${booking.flatPrice.toString()} ` +
        `not collected from customer ${booking.customerId}. The Pro is still owed commission.`,
    );

    await this.support.raiseBillingTicket({
      bookingId: declined.id,
      proId,
      customerId: declined.customerId,
      amount: declined.flatPrice.toString(),
      reason,
    });

    return declined;
  }

  private async collectableOrFail(
    proId: string,
    bookingId: string,
  ): Promise<Booking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking || booking.proId !== proId) {
      throw apiError('Booking not found', HttpStatus.NOT_FOUND);
    }

    if (booking.paymentMode !== 'cash') {
      throw apiError(
        'This booking was paid online — there is nothing to collect',
        HttpStatus.CONFLICT,
        [
          {
            field: 'paymentMode',
            message: 'Not a cash booking',
            code: 'BOOKING_IS_ONLINE',
          },
        ],
      );
    }

    if (!COLLECTABLE_STATUSES.includes(booking.status)) {
      throw apiError(
        `This job is ${booking.status}, so money is not due yet`,
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message: `Cash is collected once the job has started (${COLLECTABLE_STATUSES.join(' or ')})`,
            code: 'BOOKING_NOT_COLLECTABLE',
          },
        ],
      );
    }

    return booking;
  }
}
