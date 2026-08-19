import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import { fromPaise, rupeesDifference, toPaise } from './payments.money';
import { PAYMENT_SETTINGS } from './payments.types';
import { RazorpayClient } from './razorpay.client';

export interface Discrepancy {
  kind:
    | 'amount_mismatch'
    | 'not_paid_at_gateway'
    | 'gateway_unreachable'
    | 'duplicate_capture'
    | 'cash_completed_uncollected'
    | 'cash_balance_drift';
  reference: string;
  ours: string | null;
  theirs: string | null;
  variance: string | null;
  detail: string;
}

export interface ReconciliationReport {
  scope: 'money' | 'cash' | 'both';
  from: string;
  to: string;
  ordersScanned: number;
  bookingsScanned: number;
  prosScanned: number;
  discrepancyCount: number;
  totalVarianceAmount: string;
  discrepancies: Discrepancy[];
}

/**
 * Features 10 and 18 — the cross-checks, without module 9's tables.
 *
 * `ReconciliationRun` belongs to module 9 and does not exist, so **nothing
 * here is persisted**. That is a smaller loss than it sounds: the value of a
 * reconciliation is the answer, and the answer is recomputable from `Order`,
 * `Booking` and `CashHandover` at any time. What is missing is the history of
 * having asked, which module 9 will add by writing a row around this call.
 *
 * Nothing is auto-corrected. A discrepancy between us and the gateway is a
 * question for a human — silently making our row match theirs would destroy
 * the only evidence that they ever differed.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  /** Bounded so one call cannot walk a year of orders through the gateway. */
  private static readonly MAX_ORDERS = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly razorpay: RazorpayClient,
    private readonly settings: PlatformSettingsService,
  ) {}

  async run(input: {
    scope: 'money' | 'cash' | 'both';
    from: Date;
    to: Date;
  }): Promise<ReconciliationReport> {
    const discrepancies: Discrepancy[] = [];
    let ordersScanned = 0;
    let bookingsScanned = 0;
    let prosScanned = 0;

    if (input.scope !== 'cash') {
      const online = await this.reconcileOnline(input.from, input.to);
      ordersScanned = online.scanned;
      discrepancies.push(...online.discrepancies);
    }

    if (input.scope !== 'money') {
      const cash = await this.reconcileCash(input.from, input.to);
      bookingsScanned = cash.bookingsScanned;
      prosScanned = cash.prosScanned;
      discrepancies.push(...cash.discrepancies);
    }

    const totalVariancePaise = discrepancies.reduce(
      (sum, item) =>
        sum +
        (item.variance ? Math.abs(toPaise(item.variance.replace('-', ''))) : 0),
      0,
    );

    if (discrepancies.length > 0) {
      this.logger.warn(
        `Reconciliation found ${discrepancies.length} discrepancies totalling ${fromPaise(totalVariancePaise)}`,
      );
    }

    return {
      scope: input.scope,
      from: input.from.toISOString(),
      to: input.to.toISOString(),
      ordersScanned,
      bookingsScanned,
      prosScanned,
      discrepancyCount: discrepancies.length,
      totalVarianceAmount: fromPaise(totalVariancePaise),
      discrepancies,
    };
  }

  /**
   * Feature 10 — captured amounts cross-checked against Razorpay by order id.
   *
   * `razorpayOrderId` is the join key for everything, which is exactly why the
   * module keeps it and discards attempt history: one stable reference is
   * enough to ask the gateway anything.
   */
  private async reconcileOnline(from: Date, to: Date) {
    const tolerance = await this.settings.getNumber(
      PAYMENT_SETTINGS.reconciliationVarianceTolerance,
      0,
    );
    const tolerancePaise = toPaise(tolerance.toFixed(2));

    const orders = await this.prisma.order.findMany({
      where: { status: 'paid', paidAt: { gte: from, lte: to } },
      orderBy: { paidAt: 'asc' },
      take: ReconciliationService.MAX_ORDERS,
    });

    const total = await this.prisma.order.count({
      where: { status: 'paid', paidAt: { gte: from, lte: to } },
    });

    if (total > orders.length) {
      // Never truncate silently — a capped scan that read as "all clear"
      // would be worse than not running at all.
      this.logger.warn(
        `Reconciliation capped at ${orders.length} of ${total} paid orders in this window. ` +
          'Narrow the range to cover the rest.',
      );
    }

    const discrepancies: Discrepancy[] = [];

    for (const order of orders) {
      try {
        const gateway = await this.razorpay.fetchOrder(order.razorpayOrderId);
        const oursPaise = toPaise(order.amountPaid.toString());
        const theirsPaise = gateway.amount_paid;

        if (gateway.status !== 'paid') {
          discrepancies.push({
            kind: 'not_paid_at_gateway',
            reference: order.razorpayOrderId,
            ours: order.amountPaid.toString(),
            theirs: fromPaise(theirsPaise),
            variance: rupeesDifference(
              order.amountPaid.toString(),
              fromPaise(theirsPaise),
            ),
            detail: `We hold this order as paid; Razorpay reports ${gateway.status}.`,
          });
          continue;
        }

        if (Math.abs(oursPaise - theirsPaise) > tolerancePaise) {
          discrepancies.push({
            kind: 'amount_mismatch',
            reference: order.razorpayOrderId,
            ours: order.amountPaid.toString(),
            theirs: fromPaise(theirsPaise),
            variance: rupeesDifference(
              order.amountPaid.toString(),
              fromPaise(theirsPaise),
            ),
            detail: 'Captured amount differs from the gateway.',
          });
        }

        // More attempts than one against a paid order is not itself wrong —
        // a declined card followed by a successful one is ordinary. It is
        // worth surfacing only when the gateway took money more than once.
        if (theirsPaise > oursPaise && gateway.attempts > 1) {
          discrepancies.push({
            kind: 'duplicate_capture',
            reference: order.razorpayOrderId,
            ours: order.amountPaid.toString(),
            theirs: fromPaise(theirsPaise),
            variance: rupeesDifference(
              fromPaise(theirsPaise),
              order.amountPaid.toString(),
            ),
            detail: `Razorpay reports ${gateway.attempts} attempts and more paid than we recorded — possible double charge.`,
          });
        }
      } catch {
        discrepancies.push({
          kind: 'gateway_unreachable',
          reference: order.razorpayOrderId,
          ours: order.amountPaid.toString(),
          theirs: null,
          variance: null,
          detail:
            'Could not read this order from Razorpay — unverified, not clean.',
        });
      }
    }

    return { scanned: orders.length, discrepancies };
  }

  /**
   * Feature 18 — completed cash bookings against collections recorded, and
   * each Pro's balance against the collections behind it.
   *
   * The second check is the one that matters. `Pro.cashInHand` is a cache
   * (CONFLICTS_AND_DECISIONS #35) and this is what proves it still agrees with
   * the bookings and handovers it was derived from.
   */
  private async reconcileCash(from: Date, to: Date) {
    const discrepancies: Discrepancy[] = [];

    const uncollected = await this.prisma.booking.findMany({
      where: {
        paymentMode: 'cash',
        status: 'completed',
        completedAt: { gte: from, lte: to },
        cashCollectedAt: null,
      },
      select: {
        id: true,
        bookingNumber: true,
        payableAmount: true,
        cashDeclinedAt: true,
        cashDeclinedReason: true,
      },
    });

    for (const booking of uncollected) {
      discrepancies.push({
        kind: 'cash_completed_uncollected',
        reference: booking.bookingNumber,
        ours: '0.00',
        theirs: booking.payableAmount.toString(),
        variance: `-${booking.payableAmount.toString()}`,
        detail: booking.cashDeclinedAt
          ? `Customer declined to pay: ${booking.cashDeclinedReason ?? 'no reason given'}. The Pro is still owed commission.`
          : 'Completed with no collection recorded and no decline — the Pro may not have recorded it.',
      });
    }

    const bookingsScanned = await this.prisma.booking.count({
      where: {
        paymentMode: 'cash',
        status: 'completed',
        completedAt: { gte: from, lte: to },
      },
    });

    const carrying = await this.prisma.pro.findMany({
      where: { cashInHand: { gt: 0 } },
      select: { id: true, fullName: true, cashInHand: true },
    });

    for (const pro of carrying) {
      const [collected, handedOver] = await Promise.all([
        this.prisma.booking.aggregate({
          where: {
            proId: pro.id,
            paymentMode: 'cash',
            cashCollectedAt: { not: null },
          },
          _sum: { cashCollectedAmount: true },
        }),
        this.prisma.cashHandover.aggregate({
          where: { proId: pro.id, status: 'confirmed' },
          _sum: { confirmedAmount: true },
        }),
      ]);

      const expectedPaise =
        toPaise((collected._sum.cashCollectedAmount ?? 0).toString()) -
        toPaise((handedOver._sum.confirmedAmount ?? 0).toString());
      const actualPaise = toPaise(pro.cashInHand.toString());

      if (expectedPaise !== actualPaise) {
        discrepancies.push({
          kind: 'cash_balance_drift',
          reference: pro.id,
          ours: pro.cashInHand.toString(),
          theirs: fromPaise(expectedPaise),
          variance: fromPaise(actualPaise - expectedPaise),
          detail:
            `${pro.fullName ?? 'This Pro'}'s balance does not match collections less confirmed handovers. ` +
            'The bookings are the source; the balance is the cache.',
        });
      }
    }

    return {
      bookingsScanned,
      prosScanned: carrying.length,
      discrepancies,
    };
  }
}
