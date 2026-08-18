import { HttpStatus, Injectable } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';
import { sumRupees } from './commission-calculator';
import { DeductionsService } from './deductions.service';
import type {
  AdminCommissionQueryDto,
  PayoutQueryDto,
  PayoutSummaryQueryDto,
} from './dto/earnings.dto';

/**
 * The finance console's read side.
 *
 * Nothing here mutates. Kept apart from the services that do, so the endpoints
 * an admin browses with cannot accidentally acquire a write path.
 */
@Injectable()
export class CommissionAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deductions: DeductionsService,
  ) {}

  async commissions(query: AdminCommissionQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      ...(query.proId ? { proId: query.proId } : {}),
      ...(query.bookingId ? { bookingId: query.bookingId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            computedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.bookingCommission.count({ where }),
      this.prisma.bookingCommission.findMany({
        where,
        include: {
          pro: { select: { id: true, fullName: true, phone: true } },
          booking: {
            select: {
              bookingNumber: true,
              completedAt: true,
              service: { select: { name: true } },
            },
          },
        },
        orderBy: { computedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      page,
      limit,
      total,
      items: rows.map((row) => ({
        id: row.id,
        proId: row.proId,
        proName: row.pro.fullName ?? row.pro.phone,
        bookingNumber: row.booking.bookingNumber,
        serviceName: row.booking.service.name,
        completedAt: row.booking.completedAt,
        computedAt: row.computedAt,
        status: row.status,
        customerPaid: row.customerFlatAmount.toString(),
        rate: {
          type: row.commissionType,
          value: row.commissionValue.toString(),
        },
        proEarned: row.commissionAmount.toString(),
        platformKept: row.platformAmount.toString(),
        incentive: row.incentiveAmount.toString(),
        deduction: row.deductionAmount.toString(),
        netPayable: row.netPayable.toString(),
        durationMinutes: row.actualDurationMinutes,
        reversedAt: row.reversedAt,
        reversalReason: row.reversalReason,
        payoutId: row.payoutId,
      })),
    };
  }

  async commission(id: string) {
    const row = await this.prisma.bookingCommission.findUnique({
      where: { id },
      include: {
        pro: { select: { id: true, fullName: true, phone: true } },
        booking: {
          select: {
            id: true,
            bookingNumber: true,
            completedAt: true,
            startedAt: true,
            flatPrice: true,
            paymentMode: true,
            service: { select: { id: true, name: true } },
          },
        },
        deductions: true,
        creditedIncentives: {
          include: { incentive: { select: { name: true } } },
        },
      },
    });
    if (!row) throw apiError('Commission not found', HttpStatus.NOT_FOUND);
    return row;
  }

  async payouts(query: PayoutQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.proId ? { proId: query.proId } : {}),
      ...(query.cityId ? { pro: { cityId: query.cityId } } : {}),
    };

    const [total, rows] = await Promise.all([
      this.prisma.commissionPayout.count({ where }),
      this.prisma.commissionPayout.findMany({
        where,
        include: {
          pro: { select: { id: true, fullName: true, phone: true } },
          bankAccount: {
            select: { accountNumberMasked: true, upiId: true },
          },
          _count: { select: { commissions: true } },
        },
        orderBy: [{ periodEnd: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      page,
      limit,
      total,
      items: rows.map((row) => ({
        id: row.id,
        proId: row.proId,
        proName: row.pro.fullName ?? row.pro.phone,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        jobCount: row._count.commissions,
        commissionAmount: row.commissionAmount.toString(),
        incentiveAmount: row.incentiveAmount.toString(),
        deductionAmount: row.deductionAmount.toString(),
        netAmount: row.netAmount.toString(),
        status: row.status,
        approvedAt: row.approvedAt,
        disbursedAt: row.disbursedAt,
        paidAt: row.paidAt,
        payoutReference: row.payoutReference,
        payoutMode: row.payoutMode,
        attemptCount: row.attemptCount,
        // Finance sees the gateway's own words. The Pro never does — their
        // honest version is the status.
        failureReason: row.failureReason,
        destination:
          row.bankAccount.upiId ?? row.bankAccount.accountNumberMasked,
      })),
    };
  }

  async payoutDetail(id: string) {
    const payout = await this.prisma.commissionPayout.findUnique({
      where: { id },
      include: {
        pro: { select: { id: true, fullName: true, phone: true } },
        bankAccount: true,
        approvedByAdmin: { select: { id: true, fullName: true } },
        disbursedByAdmin: { select: { id: true, fullName: true } },
      },
    });
    if (!payout) throw apiError('Payout not found', HttpStatus.NOT_FOUND);
    return payout;
  }

  async payoutCommissions(id: string) {
    await this.payoutDetail(id);

    const [commissions, deductions] = await Promise.all([
      this.prisma.bookingCommission.findMany({
        where: { payoutId: id },
        include: {
          booking: {
            select: {
              bookingNumber: true,
              completedAt: true,
              service: { select: { name: true } },
            },
          },
        },
        orderBy: { computedAt: 'asc' },
      }),
      this.prisma.payoutDeduction.findMany({
        where: { consumedByPayoutId: id },
      }),
    ]);

    return { commissions, deductions };
  }

  /** The finance dashboard. One query per status bucket, no derived cache. */
  async payoutSummary(query: PayoutSummaryQueryDto) {
    const window =
      query.from || query.to
        ? {
            periodEnd: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {};

    const grouped = await this.prisma.commissionPayout.groupBy({
      by: ['status'],
      where: window,
      _count: true,
      _sum: { netAmount: true },
    });

    const of = (status: string) => {
      const row = grouped.find((entry) => entry.status === status);
      return {
        count: row?._count ?? 0,
        net: sumRupees([(row?._sum.netAmount ?? '0').toString()]),
      };
    };

    const draft = of('draft');
    const approved = of('approved');
    const processing = of('processing');
    const paid = of('paid');
    const failed = of('failed');

    const outstanding = await this.prisma.payoutDeduction.findMany({
      where: { waivedAt: null, fullyConsumedAt: null },
      select: { amount: true, consumedAmount: true },
    });

    return {
      draftCount: draft.count,
      draftNet: draft.net,
      awaitingDisbursementCount: approved.count,
      awaitingDisbursementNet: approved.net,
      processingCount: processing.count,
      paidCount: paid.count,
      paidNet: paid.net,
      failedCount: failed.count,
      failedNet: failed.net,
      outstandingDeductions: sumRupees(
        outstanding.map((row) => row.amount.toString()),
      ),
    };
  }

  /**
   * US-8.8 — services that can be booked and cannot pay.
   *
   * Activation is meant to make this impossible (US-3.11), so a non-empty
   * result is an alert rather than a report: every completed job on one of
   * these is work somebody did for nothing, and it stays that way until the
   * rate is set and the sweeper is run.
   */
  async servicesMissingCommission() {
    const services = await this.prisma.service.findMany({
      where: {
        OR: [{ commissionType: null }, { commissionValue: null }],
      },
      select: { id: true, name: true, isActive: true },
    });
    if (services.length === 0) return [];

    const counts = await this.prisma.booking.groupBy({
      by: ['serviceId'],
      where: {
        serviceId: { in: services.map((row) => row.id) },
        status: 'completed',
        commission: null,
      },
      _count: true,
    });

    return (
      services
        .map((service) => ({
          serviceId: service.id,
          serviceName: service.name,
          isActive: service.isActive,
          unpaidCompletedJobs:
            counts.find((row) => row.serviceId === service.id)?._count ?? 0,
        }))
        // Active services with unpaid work first: that is the order somebody
        // fixing this should work in.
        .sort(
          (a, b) =>
            Number(b.isActive) - Number(a.isActive) ||
            b.unpaidCompletedJobs - a.unpaidCompletedJobs,
        )
    );
  }

  async deductionsForPro(proId: string) {
    const [rows, outstandingTotal] = await Promise.all([
      this.prisma.payoutDeduction.findMany({
        where: { proId },
        include: {
          sourceCommission: {
            select: { booking: { select: { bookingNumber: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.deductions.outstandingTotal(proId),
    ]);

    // Mapped, not spread. Returning the Prisma rows straight out published
    // `consumedAmount`/`createdAt`/`consumedByPayoutId` under names the
    // documented `DeductionLineDto` does not use, so a client generated from
    // `/docs/json` read `recovered` and `bookingNumber` as `undefined` — on a
    // money screen, silently. It also leaked `dedupeKey` and the admin ids.
    return {
      outstandingTotal,
      items: rows.map((row) => ({
        id: row.id,
        amount: row.amount.toString(),
        recovered: row.consumedAmount.toString(),
        kind: row.kind,
        reason: row.reason,
        bookingNumber: row.sourceCommission?.booking.bookingNumber ?? null,
        raisedAt: row.createdAt,
        settledAt: row.fullyConsumedAt,
        payoutId: row.consumedByPayoutId,
        // Admin-only. The Pro-facing statement filters waived rows out; this
        // one keeps them and says so, so nobody raises the same debt twice.
        waivedAt: row.waivedAt,
        waiveReason: row.waiveReason,
      })),
    };
  }
}
