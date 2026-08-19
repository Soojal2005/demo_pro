import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import type { UiSegment } from './ui-config.types';

@Injectable()
export class CustomerSegmentationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
  ) {}

  async segmentFor(
    customerId: string,
    cityId?: string,
    asOf = new Date(),
  ): Promise<UiSegment> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        createdAt: true,
        status: true,
        bookings: {
          where: { status: 'completed', completedAt: { lte: asOf } },
          select: { completedAt: true },
          orderBy: { completedAt: 'asc' },
        },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (customer.status === 'guest') return 'anonymous';

    const [activeDays, lapsedDays] = await Promise.all([
      this.settings.getNumber('reporting.customerActiveDays', 30, cityId),
      this.settings.getNumber('reporting.customerLapsedDays', 90, cityId),
    ]);
    const day = 86_400_000;
    const accountAgeDays =
      (asOf.getTime() - customer.createdAt.getTime()) / day;
    const completions = customer.bookings
      .map((booking) => booking.completedAt)
      .filter((date): date is Date => date !== null);
    if (!completions.length)
      return accountAgeDays <= activeDays ? 'new' : 'never_booked';
    const sinceLatest =
      (asOf.getTime() - completions[completions.length - 1].getTime()) / day;
    if (sinceLatest > lapsedDays) return 'lapsed';
    if (sinceLatest > activeDays) return 'at_risk';
    return completions.length >= 2 ? 'repeat' : 'active';
  }
}
