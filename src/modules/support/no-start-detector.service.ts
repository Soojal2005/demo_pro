import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import { SupportTicketsService } from './support-tickets.service';
import { SUPPORT_SETTINGS, systemSubject } from './support.types';

export interface NoStartSweepResult {
  scanned: number;
  raised: number;
  autoResolved: number;
}

/**
 * Features 11 to 13 — the no-start exception.
 *
 * ## What this closes
 *
 * US-4.14, "arrive but be unable to start", has been sitting at 🟡 with the
 * note _"Every input is recorded and the grace window is configured. **Nothing
 * watches it**."_ `no_start.graceWindowMinutes` has existed in module 15's
 * settings — defined, validated 1–240 — and been read by no code at all. This
 * service is its first consumer.
 *
 * ## Three properties worth knowing
 *
 * **`arrivedAt` cannot be moved.** Module 4 keeps it as the authoritative
 * *first* arrival and deliberately does not reset it on an `en_route →
 * arrived` repeat, precisely so a Pro cannot extend the window by stepping
 * away and coming back. This sweep inherits that guarantee, which is also why
 * the dedupe key needs no timestamp: one incident per booking, forever.
 *
 * **The window is read per city.** A single `now() - 30min` cutoff would apply
 * the wrong window everywhere a city overrides the default, so candidates are
 * grouped by city and each group gets its own cutoff.
 *
 * **The Pro is never told.** Feature 13 makes this a design rule rather than
 * an oversight: no notification is enqueued for anyone, the ticket is
 * `isInternal` in code and by CHECK constraint, and the spec file asserts both
 * rather than trusting them.
 */
@Injectable()
export class NoStartDetectorService {
  private readonly logger = new Logger(NoStartDetectorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly tickets: SupportTicketsService,
  ) {}

  async sweep(now: Date = new Date()): Promise<NoStartSweepResult> {
    const candidates = await this.prisma.booking.findMany({
      where: {
        status: 'arrived',
        startedAt: null,
        cancelledAt: null,
        arrivedAt: { not: null },
      },
      select: {
        id: true,
        bookingNumber: true,
        customerId: true,
        proId: true,
        arrivedAt: true,
        startOtpAttempts: true,
        address: { select: { cityId: true } },
      },
      // Bounded. A sweep that tries to fix a year of backlog in one pass
      // competes with live traffic for the same connection pool.
      take: 500,
      orderBy: { arrivedAt: 'asc' },
    });

    // One settings read per city rather than one per booking — the answer is
    // the same for every job in a city and the read is a database round trip.
    const graceByCity = new Map<string, number>();
    let raised = 0;

    for (const booking of candidates) {
      const cityId = booking.address.cityId;
      if (!graceByCity.has(cityId))
        graceByCity.set(
          cityId,
          await this.settings.getNumber(
            SUPPORT_SETTINGS.noStartGraceMinutes.key,
            SUPPORT_SETTINGS.noStartGraceMinutes.fallback,
            cityId,
          ),
        );

      const graceMinutes = graceByCity.get(cityId)!;
      const deadline = new Date(
        booking.arrivedAt!.getTime() + graceMinutes * 60_000,
      );
      if (now < deadline) continue;

      const ticket = await this.tickets.raiseSystemTicket({
        systemKey: `no_start:${booking.id}`,
        category: 'no_start',
        priority: 'high',
        bookingId: booking.id,
        customerId: booking.customerId,
        proId: booking.proId,
        subject: systemSubject('No start', booking.bookingNumber),
        body:
          `The Pro marked arrival at ${booking.arrivedAt!.toISOString()} and the ` +
          `job has not started ${graceMinutes} minutes later. Raised for ops; ` +
          'the Pro has not been notified.',
        contextJson: {
          graceWindowMinutes: graceMinutes,
          // Ops reading "30" cannot tell whether that was their city's setting
          // or the code's fallback — which is the first thing they ask when
          // the number looks wrong.
          graceSource: await this.graceSource(cityId),
          arrivedAt: booking.arrivedAt!.toISOString(),
          cityId,
          startOtpAttempts: booking.startOtpAttempts,
          detectedAt: now.toISOString(),
        } satisfies Prisma.InputJsonValue,
      });

      if (ticket) {
        raised += 1;
        this.logger.warn(
          `No-start incident on booking ${booking.bookingNumber}: arrived ` +
            `${booking.arrivedAt!.toISOString()}, grace ${graceMinutes}m, ` +
            `ticket ${ticket.id}.`,
        );
      }
    }

    return {
      scanned: candidates.length,
      raised,
      autoResolved: await this.closeResolvedIncidents(),
    };
  }

  /**
   * Closes no-start tickets whose booking has since moved on.
   *
   * An OTP that arrives late, a customer who was in the shower, a job ops
   * force-started — all of them produce a ticket that answers itself minutes
   * later. Leaving those open trains ops to ignore the queue, which costs more
   * than the ones that were real.
   */
  private async closeResolvedIncidents(): Promise<number> {
    const open = await this.prisma.supportTicket.findMany({
      where: {
        category: 'no_start',
        raisedByType: 'system',
        status: { in: ['open', 'in_progress', 'escalated'] },
        bookingId: { not: null },
      },
      select: { id: true, bookingId: true },
      take: 500,
    });
    if (open.length === 0) return 0;

    const bookings = await this.prisma.booking.findMany({
      where: { id: { in: open.map((ticket) => ticket.bookingId!) } },
      select: { id: true, status: true, startedAt: true },
    });
    const byId = new Map(bookings.map((booking) => [booking.id, booking]));

    let closed = 0;
    for (const ticket of open) {
      const booking = byId.get(ticket.bookingId!);
      if (!booking) continue;
      if (booking.status === 'arrived' && !booking.startedAt) continue;

      await this.tickets.autoResolveSystemTicket(
        ticket.id,
        booking.startedAt
          ? `Resolved automatically — the job started at ${booking.startedAt.toISOString()}.`
          : `Resolved automatically — the booking moved to ${booking.status}.`,
      );
      closed += 1;
    }
    return closed;
  }

  /** Whether the window came from the city, the global default, or the code. */
  private async graceSource(
    cityId: string,
  ): Promise<'city' | 'global' | 'fallback'> {
    const scoped = await this.prisma.platformSetting.findFirst({
      where: { key: SUPPORT_SETTINGS.noStartGraceMinutes.key, cityId },
      select: { id: true },
    });
    if (scoped) return 'city';

    const global = await this.prisma.platformSetting.findFirst({
      where: { key: SUPPORT_SETTINGS.noStartGraceMinutes.key, cityId: null },
      select: { id: true },
    });
    return global ? 'global' : 'fallback';
  }
}
