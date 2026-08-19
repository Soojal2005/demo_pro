import { HttpStatus, Injectable } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';
import { BookingsService } from '../bookings/bookings.service';

/**
 * Feature 14 — dispute resolution backed by the evidence the system already
 * holds.
 *
 * ## This assembles nothing it does not have to
 *
 * `BookingsService.reconstruct()` already returns the status timeline with
 * coordinates, the geo-stamped photo proofs and the chat thread in one call —
 * it was built for US-4.24, which made one-call reconstruction a design
 * constraint. This service calls it and adds the two things it does not
 * carry. A second evidence assembler is how two tabs of a dispute screen end
 * up disagreeing about the same job.
 *
 * ## Why `routeTrail` is an object rather than null
 *
 * `Booking.routeTrail` exists as a column and is **always null today** —
 * nothing accumulates a GPS trail until module 13's second instalment. An
 * empty array here would read as "the Pro went nowhere", which is a claim, and
 * a wrong one. So it is reported unavailable, the way module 15's 360 labels
 * its missing sections rather than presenting misleading emptiness.
 */
@Injectable()
export class DisputeEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
  ) {}

  async forTicket(ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      select: { id: true, bookingId: true, category: true },
    });
    if (!ticket) throw apiError('Ticket not found', HttpStatus.NOT_FOUND);

    if (!ticket.bookingId)
      throw apiError(
        'This ticket is not about a booking, so there is no job to ' +
          'reconstruct.',
        HttpStatus.CONFLICT,
      );

    return this.forBooking(ticket.bookingId, ticket.id);
  }

  async forBooking(bookingId: string, ticketId?: string) {
    const booking = await this.bookings.reconstruct(bookingId);

    const reviews = await this.prisma.review.findMany({
      // Customer direction only. A Pro's note about a household is internal,
      // tag-only and drives nothing (module 10's asymmetry) — surfacing it as
      // evidence against the customer would invert that on the one screen
      // where it would actually be acted on.
      where: { bookingId, reviewerType: 'customer' },
      select: {
        id: true,
        rating: true,
        comment: true,
        photoUrls: true,
        createdAt: true,
      },
    });

    return {
      ticketId: ticketId ?? null,
      bookingId,
      bookingNumber: booking.bookingNumber,
      status: booking.status,

      /** Arrival, OTP-verified start and completion, each with coordinates. */
      statusTimeline: booking.statusEvents,
      /** The Pro's mandatory geo-stamped completion photos. */
      photoProof: booking.photoProofs,
      /** What was said during the job. */
      chatLog: booking.chatMessages,
      /** The customer's own photos, if they left any. */
      customerReviews: reviews,

      routeTrail: booking.routeTrail
        ? { available: true, trail: booking.routeTrail }
        : {
            available: false,
            reason:
              'No route trail is recorded. Nothing accumulates a GPS trail ' +
              'until module 13 instalment 2 — an empty trail would read as ' +
              '"the Pro went nowhere", which is a claim this API will not make.',
          },

      /** The two facts a dispute usually turns on, surfaced rather than buried. */
      trustAnchors: {
        startWasOtpVerified: booking.startOtpVerifiedByProId !== null,
        forceStartedByOps: booking.overriddenByAdminId !== null,
        arrivedAt: booking.arrivedAt,
        startedAt: booking.startedAt,
        completedAt: booking.completedAt,
        actualDurationMinutes: booking.actualDurationMinutes ?? null,
      },
    };
  }
}
