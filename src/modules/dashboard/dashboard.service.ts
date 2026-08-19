import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionCode } from '../identity/constants/permission-code';
import { LedgerBalancesService } from '../ledger/ledger-balances.service';
import {
  ONGOING_STATUSES,
  UPCOMING_STATUSES,
  type ApplicationBreakdown,
  type BookingBreakdown,
  type DailyBookings,
  type DashboardSummary,
  type MoneySnapshot,
  type NeedsAttention,
  type Trend,
} from './dashboard.types';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The first screen an admin opens, answered in one call.
 *
 * ## Why it counts rather than lists
 *
 * The console used to derive its figures by fetching a list and reading
 * `.length`. Every admin list in this codebase is capped — bookings and
 * customers at 100 — so that approach could not report a number above the cap
 * and silently reported the cap instead. Everything here is a `count()`, so the
 * figures are true at any size and stay cheap.
 *
 * ## Why sections are optional
 *
 * The dashboard spans domains that different roles are allowed to see. Guarding
 * the route with a single permission would 403 the whole page for ops; guarding
 * it with none would show them revenue. So the route is open to any admin and
 * this service decides, per section, from the caller's own role.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerBalancesService,
  ) {}

  async summary(input: {
    roleId?: string;
    cityScope?: string[];
    days: number;
  }): Promise<DashboardSummary> {
    const granted = await this.permissionsOf(input.roleId);
    const can = (code: string): boolean => granted.has(code);

    const now = new Date();
    const since = new Date(now.getTime() - input.days * DAY_MS);

    // Every figure is scoped the same way the underlying screens are: a
    // city-scoped admin sees their city's numbers, not the platform's.
    const cities = input.cityScope?.length ? input.cityScope : undefined;
    const bookingWhere: Prisma.BookingWhereInput = cities
      ? { address: { cityId: { in: cities } } }
      : {};
    const proWhere: Prisma.ProWhereInput = cities
      ? { cityId: { in: cities } }
      : {};

    const [needsAttention, totals, bookings, applications, chart, money] =
      await Promise.all([
        this.needsAttention(can, bookingWhere, proWhere),
        this.totals(can, since, bookingWhere, proWhere),
        can(PermissionCode.BOOKING_READ)
          ? this.bookingBreakdown(bookingWhere)
          : undefined,
        can(PermissionCode.PRO_APPLICATION_REVIEW)
          ? this.applicationBreakdown(proWhere)
          : undefined,
        can(PermissionCode.BOOKING_READ)
          ? this.chart(input.days, since, bookingWhere)
          : undefined,
        can(PermissionCode.LEDGER_READ) ? this.money() : undefined,
      ]);

    return {
      days: input.days,
      needsAttention,
      totals,
      bookings,
      applications,
      chart,
      money,
    };
  }

  /** The caller's grants, read the same way `PermissionsGuard` reads them. */
  private async permissionsOf(roleId?: string): Promise<Set<string>> {
    if (!roleId) return new Set();
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    return new Set((role?.permissionCodes as string[] | undefined) ?? []);
  }

  private async needsAttention(
    can: (code: string) => boolean,
    bookingWhere: Prisma.BookingWhereInput,
    proWhere: Prisma.ProWhereInput,
  ): Promise<Partial<NeedsAttention>> {
    const [stuck, cash, applications, payouts, reviews] = await Promise.all([
      can(PermissionCode.DISPATCH_OVERRIDE)
        ? this.prisma.booking.count({
            where: {
              ...bookingWhere,
              assignmentOutcome: { in: ['no_supply', 'exhausted'] },
            },
          })
        : undefined,
      can(PermissionCode.CASH_HANDOVER_CONFIRM)
        ? this.prisma.cashHandover.count({
            where: { status: 'declared', pro: proWhere },
          })
        : undefined,
      can(PermissionCode.PRO_APPLICATION_REVIEW)
        ? this.prisma.proApplication.count({
            where: {
              pro: proWhere,
              queueStatus: { in: ['pending', 'docs_review', 'call_pending'] },
            },
          })
        : undefined,
      can(PermissionCode.PAYOUT_READ)
        ? this.prisma.commissionPayout.count({ where: { status: 'failed' } })
        : undefined,
      // The moderation queue as module 10 defines it: still visible, and rated
      // badly enough that somebody should read it.
      can(PermissionCode.REVIEW_MODERATE)
        ? this.prisma.review.count({
            where: { isHidden: false, rating: { lte: 2 }, pro: proWhere },
          })
        : undefined,
    ]);

    return {
      ...(stuck !== undefined && { stuckBookings: stuck }),
      ...(cash !== undefined && { cashHandoversPending: cash }),
      ...(applications !== undefined && { applicationsWaiting: applications }),
      ...(payouts !== undefined && { payoutsFailed: payouts }),
      ...(reviews !== undefined && { reviewsToModerate: reviews }),
    };
  }

  /**
   * Each total paired with what it was `days` ago.
   *
   * "Previous" is the same count with `createdAt` cut at the earlier date — so
   * the delta reads as "how much this grew this week", which is a fact rather
   * than a projection.
   */
  private async totals(
    can: (code: string) => boolean,
    since: Date,
    bookingWhere: Prisma.BookingWhereInput,
    proWhere: Prisma.ProWhereInput,
  ): Promise<Partial<DashboardSummary['totals']>> {
    const trend = async (
      count: (where: object) => Promise<number>,
      where: object,
    ): Promise<Trend> => {
      const [current, previous] = await Promise.all([
        count(where),
        count({ ...where, createdAt: { lt: since } }),
      ]);
      return { current, previous };
    };

    const [customers, pros, bookings, completed] = await Promise.all([
      can(PermissionCode.CUSTOMER_MODERATE)
        ? trend((w) => this.prisma.customer.count({ where: w }), {})
        : undefined,
      can(PermissionCode.PRO_MODERATE)
        ? trend((w) => this.prisma.pro.count({ where: w }), proWhere)
        : undefined,
      can(PermissionCode.BOOKING_READ)
        ? trend((w) => this.prisma.booking.count({ where: w }), bookingWhere)
        : undefined,
      can(PermissionCode.BOOKING_READ)
        ? trend((w) => this.prisma.booking.count({ where: w }), {
            ...bookingWhere,
            status: 'completed',
          })
        : undefined,
    ]);

    return {
      ...(customers && { customers }),
      ...(pros && { pros }),
      ...(bookings && { bookings }),
      ...(completed && { completedBookings: completed }),
    };
  }

  private async bookingBreakdown(
    where: Prisma.BookingWhereInput,
  ): Promise<BookingBreakdown> {
    const rows = await this.prisma.booking.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    const of = (status: string): number =>
      rows.find((row) => row.status === status)?._count._all ?? 0;
    const sum = (statuses: readonly string[]): number =>
      statuses.reduce((total, status) => total + of(status), 0);

    return {
      upcoming: sum(UPCOMING_STATUSES),
      ongoing: sum(ONGOING_STATUSES),
      completed: of('completed'),
      cancelled: of('cancelled'),
    };
  }

  private async applicationBreakdown(
    proWhere: Prisma.ProWhereInput,
  ): Promise<ApplicationBreakdown> {
    const rows = await this.prisma.proApplication.groupBy({
      by: ['queueStatus'],
      where: { pro: proWhere },
      _count: { _all: true },
    });
    const of = (status: string): number =>
      rows.find((row) => row.queueStatus === status)?._count._all ?? 0;

    return {
      pending: of('pending'),
      docsReview: of('docs_review'),
      callPending: of('call_pending'),
      changesRequested: of('changes_requested'),
      approved: of('approved'),
      rejected: of('rejected'),
    };
  }

  /**
   * One row per day, zero-filled.
   *
   * The gaps matter: a day with no bookings has to appear as a zero, not go
   * missing, or the chart silently compresses a quiet Sunday out of existence
   * and every line beside it lies about when things happened.
   */
  private async chart(
    days: number,
    since: Date,
    where: Prisma.BookingWhereInput,
  ): Promise<DailyBookings[]> {
    const rows = await this.prisma.booking.findMany({
      where: { ...where, createdAt: { gte: since } },
      select: { createdAt: true, status: true },
    });

    const empty = (): Omit<DailyBookings, 'date'> => ({
      upcoming: 0,
      ongoing: 0,
      completed: 0,
      cancelled: 0,
    });

    const buckets = new Map<string, Omit<DailyBookings, 'date'>>();
    for (let day = days - 1; day >= 0; day--) {
      buckets.set(dayKey(new Date(Date.now() - day * DAY_MS)), empty());
    }

    for (const row of rows) {
      const bucket = buckets.get(dayKey(row.createdAt));
      if (!bucket) continue;
      if ((UPCOMING_STATUSES as readonly string[]).includes(row.status)) {
        bucket.upcoming += 1;
      } else if ((ONGOING_STATUSES as readonly string[]).includes(row.status)) {
        bucket.ongoing += 1;
      } else if (row.status === 'completed') bucket.completed += 1;
      else if (row.status === 'cancelled') bucket.cancelled += 1;
    }

    return [...buckets].map(([date, counts]) => ({ date, ...counts }));
  }

  private async money(): Promise<MoneySnapshot> {
    const books = await this.ledger.dashboard();
    return {
      collectedToday: books.today.collected,
      refundedToday: books.today.refunded,
      netToday: books.today.net,
      grossRevenue: books.allTime.grossRevenue,
      owedToPros: books.owedToPros,
      cashHeldByPros: books.cashHeldByPros,
    };
  }
}

/** `YYYY-MM-DD` in local time, which is what the chart's axis is labelled in. */
function dayKey(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
