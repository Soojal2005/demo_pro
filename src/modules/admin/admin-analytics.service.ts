import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { apiError } from '../../common/utils';
import type { AdminAnalyticsQueryDto } from './dto/admin.dto';

export interface Range {
  from: Date;
  to: Date;
}

@Injectable()
export class AdminAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  range(query: AdminAnalyticsQueryDto): Range {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to)
      throw apiError('from must be before to', HttpStatus.BAD_REQUEST);
    if (to.getTime() - from.getTime() > 2 * 365 * 86_400_000)
      throw apiError(
        'Date range cannot exceed two years',
        HttpStatus.BAD_REQUEST,
      );
    return { from, to };
  }

  scopedCities(
    requested: string[] | undefined,
    allowed: string[] | undefined,
  ): string[] | undefined {
    if (!allowed?.length) return requested;
    if (requested?.some((id) => !allowed.includes(id)))
      throw apiError('Outside your city scope', HttpStatus.FORBIDDEN);
    return requested?.length ? requested : allowed;
  }

  async bookings(query: AdminAnalyticsQueryDto, allowedCityIds?: string[]) {
    const { from, to } = this.range(query);
    const cityIds = this.scopedCities(query.cityIds, allowedCityIds);
    const where: Prisma.BookingWhereInput = {
      createdAt: { gte: from, lt: to },
      ...(query.proIds?.length ? { proId: { in: query.proIds } } : {}),
      ...(query.serviceIds?.length
        ? { serviceId: { in: query.serviceIds } }
        : {}),
      ...(cityIds?.length ? { address: { cityId: { in: cityIds } } } : {}),
    };
    const rows = await this.prisma.booking.findMany({
      where,
      include: {
        address: {
          select: {
            cityId: true,
            city: { select: { name: true, timezone: true } },
          },
        },
        customer: {
          select: { id: true, createdAt: true, fullName: true, phone: true },
        },
        pro: { select: { id: true, fullName: true, employeeCode: true } },
        service: { select: { id: true, name: true } },
        commission: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!query.customerSegments?.length) return rows;
    const segments = await this.customerSegments(
      [...new Set(rows.map((row) => row.customerId))],
      to,
    );
    return rows.filter((row) =>
      query.customerSegments!.includes(
        segments.get(row.customerId) ?? 'never_booked',
      ),
    );
  }

  async overview(query: AdminAnalyticsQueryDto, allowedCityIds?: string[]) {
    const rows = await this.bookings(query, allowedCityIds);
    const completed = rows.filter((row) => row.status === 'completed');
    const cancelled = rows.filter((row) => row.status === 'cancelled');
    const gmv = completed.reduce((sum, row) => sum + Number(row.flatPrice), 0);
    // Marketing may compare this with GMV, but it must not mistake the
    // catalogue split for money retained. Refunds and incentives reduce the
    // platform's share; a missing commission row contributes nothing rather
    // than overstating revenue from unpaid work.
    const platformRevenue = completed.reduce(
      (sum, row) =>
        sum +
        (row.commission
          ? Number(row.flatPrice) -
            Number(row.refundedAmount ?? 0) -
            Number(row.commission.commissionAmount) -
            Number(row.commission.incentiveAmount)
          : 0),
      0,
    );
    const customers = new Set(completed.map((row) => row.customerId));
    return {
      range: this.range(query),
      bookings: {
        requested: rows.length,
        completed: completed.length,
        cancelled: cancelled.length,
        completionRate: rows.length ? completed.length / rows.length : 0,
      },
      customers: { completedUnique: customers.size },
      money: {
        currency: 'INR',
        gmv: gmv.toFixed(2),
        netPlatformRevenue: platformRevenue.toFixed(2),
      },
      dispatch: {
        noSupply: rows.filter((row) => row.assignmentOutcome === 'no_supply')
          .length,
        exhausted: rows.filter((row) => row.assignmentOutcome === 'exhausted')
          .length,
        averageAssignmentSeconds: average(
          rows
            .filter((row) => row.assignedAt)
            .map(
              (row) =>
                (row.assignedAt!.getTime() - row.createdAt.getTime()) / 1000,
            ),
        ),
      },
    };
  }

  async cities(query: AdminAnalyticsQueryDto, allowedCityIds?: string[]) {
    const rows = await this.bookings(query, allowedCityIds);
    const grouped = new Map<string, typeof rows>();
    for (const row of rows)
      grouped.set(row.address.cityId, [
        ...(grouped.get(row.address.cityId) ?? []),
        row,
      ]);
    return [...grouped.entries()].map(([cityId, cityRows]) => {
      const completed = cityRows.filter((row) => row.status === 'completed');
      return {
        cityId,
        cityName: cityRows[0]?.address.city.name,
        bookings: cityRows.length,
        completed: completed.length,
        cancelled: cityRows.filter((row) => row.status === 'cancelled').length,
        noSupply: cityRows.filter(
          (row) => row.assignmentOutcome === 'no_supply',
        ).length,
        gmv: completed
          .reduce((sum, row) => sum + Number(row.flatPrice), 0)
          .toFixed(2),
        netPlatformRevenue: completed
          .reduce(
            (sum, row) =>
              sum +
              (row.commission
                ? Number(row.flatPrice) -
                  Number(row.refundedAmount ?? 0) -
                  Number(row.commission.commissionAmount) -
                  Number(row.commission.incentiveAmount)
                : 0),
            0,
          )
          .toFixed(2),
      };
    });
  }

  async retention(query: AdminAnalyticsQueryDto, allowedCityIds?: string[]) {
    const { from, to } = this.range(query);
    const cityIds = this.scopedCities(query.cityIds, allowedCityIds);
    const rows = await this.prisma.booking.findMany({
      where: {
        status: 'completed',
        completedAt: { lte: to },
        ...(query.proIds?.length ? { proId: { in: query.proIds } } : {}),
        ...(query.serviceIds?.length
          ? { serviceId: { in: query.serviceIds } }
          : {}),
        ...(cityIds?.length ? { address: { cityId: { in: cityIds } } } : {}),
      },
      select: { customerId: true, completedAt: true },
      orderBy: { completedAt: 'asc' },
    });
    const byCustomer = new Map<string, Date[]>();
    for (const row of rows)
      byCustomer.set(row.customerId, [
        ...(byCustomer.get(row.customerId) ?? []),
        row.completedAt!,
      ]);
    const segments = query.customerSegments?.length
      ? await this.customerSegments([...byCustomer.keys()], to)
      : null;
    const cohorts = {
      days30: 0,
      days60: 0,
      days90: 0,
      eligible30: 0,
      eligible60: 0,
      eligible90: 0,
      customers: 0,
    };
    for (const [customerId, dates] of byCustomer) {
      const first = dates[0];
      if (first < from || first >= to) continue;
      if (
        segments &&
        !query.customerSegments!.includes(
          segments.get(customerId) ?? 'never_booked',
        )
      )
        continue;
      cohorts.customers++;
      for (const days of [30, 60, 90] as const) {
        const deadline = first.getTime() + days * 86_400_000;
        if (deadline > to.getTime()) continue;
        cohorts[`eligible${days}`]++;
        if (dates.some((date) => date > first && date.getTime() <= deadline))
          cohorts[`days${days}`]++;
      }
    }
    return {
      ...cohorts,
      rates: {
        days30: ratio(cohorts.days30, cohorts.eligible30),
        days60: ratio(cohorts.days60, cohorts.eligible60),
        days90: ratio(cohorts.days90, cohorts.eligible90),
      },
    };
  }

  async reportRows(
    type: string,
    query: AdminAnalyticsQueryDto,
    allowedCityIds?: string[],
  ): Promise<Record<string, unknown>[]> {
    if (type === 'retention')
      return [await this.retention(query, allowedCityIds)];
    if (type === 'city_performance')
      return await this.cities(query, allowedCityIds);
    const rows = await this.bookings(query, allowedCityIds);
    if (type === 'commission')
      return rows
        .filter((row) => row.commission)
        .map((row) => ({
          bookingNumber: row.bookingNumber,
          completedAt: row.completedAt,
          city: row.address.city.name,
          service: row.service.name,
          proId: row.proId,
          pro: row.pro?.fullName,
          grossPrice: row.flatPrice.toString(),
          commissionType: row.commission!.commissionType,
          commissionValue: row.commission!.commissionValue.toString(),
          proAmount: row.commission!.commissionAmount.toString(),
          platformAmount: row.commission!.platformAmount.toString(),
          status: row.commission!.status,
        }));
    return rows.map((row) => ({
      bookingNumber: row.bookingNumber,
      createdAt: row.createdAt,
      status: row.status,
      city: row.address.city.name,
      service: row.service.name,
      customerId: row.customerId,
      proId: row.proId,
      assignmentOutcome: row.assignmentOutcome,
      assignmentAttempt: row.assignmentAttempt,
      assignedAt: row.assignedAt,
      acknowledgedAt: row.acknowledgedAt,
      completedAt: row.completedAt,
      cancelledAt: row.cancelledAt,
      paymentMode: row.paymentMode,
      amount: row.flatPrice.toString(),
    }));
  }

  private async customerSegments(
    customerIds: string[],
    asOf: Date,
  ): Promise<Map<string, string>> {
    const [settings, customers] = await Promise.all([
      this.prisma.platformSetting.findMany({
        where: {
          key: {
            in: [
              'reporting.customerActiveDays',
              'reporting.customerLapsedDays',
            ],
          },
          cityId: null,
        },
      }),
      this.prisma.customer.findMany({
        where: { id: { in: customerIds } },
        select: {
          id: true,
          createdAt: true,
          bookings: {
            where: { status: 'completed', completedAt: { lte: asOf } },
            select: { completedAt: true },
            orderBy: { completedAt: 'asc' },
          },
        },
      }),
    ]);
    const activeDays = Number(
      settings.find((row) => row.key.endsWith('ActiveDays'))?.value ?? 30,
    );
    const lapsedDays = Number(
      settings.find((row) => row.key.endsWith('LapsedDays'))?.value ?? 90,
    );
    const result = new Map<string, string>();
    for (const customer of customers) {
      const dates = customer.bookings
        .map((booking) => booking.completedAt!)
        .filter(Boolean);
      const age = (asOf.getTime() - customer.createdAt.getTime()) / 86_400_000;
      if (!dates.length)
        result.set(customer.id, age <= activeDays ? 'new' : 'never_booked');
      else {
        const sinceLatest =
          (asOf.getTime() - dates[dates.length - 1].getTime()) / 86_400_000;
        result.set(
          customer.id,
          sinceLatest > lapsedDays
            ? 'lapsed'
            : sinceLatest > activeDays
              ? 'at_risk'
              : dates.length >= 2
                ? 'repeat'
                : 'active',
        );
      }
    }
    return result;
  }
}

const average = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const ratio = (part: number, whole: number): number =>
  whole ? part / whole : 0;
