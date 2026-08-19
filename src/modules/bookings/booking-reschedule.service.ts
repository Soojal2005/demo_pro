import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Booking, BookingReschedule } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ServiceCatalogService } from '../catalog/service-catalog.service';
import type { BookingStatus } from './booking.types';
import { BookingStateService } from './booking-state.service';
import { BookingsService } from './bookings.service';
import { decideReschedule, hoursUntil } from './cancellation-policy';
import { DISPATCH_PORT, type DispatchPort } from './ports/dispatch.port';
import { LOYALTY_PORT, type LoyaltyPort } from './ports/loyalty.port';
import { PlatformSettingsService } from './platform-settings.service';

export interface ReschedulePreview {
  allowed: boolean;
  refusal: string | null;
  message: string;
  hoursUntilSlot: number | null;
  reschedulesRemaining: number;
  freeRescheduleHours: number;
  currentSlotStartAt: Date | null;
  /** The soonest slot that would be accepted, so the picker can start there. */
  earliestNewSlotAt: Date;
}

/**
 * Moving a booking's slot.
 *
 * Split out of `BookingLifecycleService` rather than added to it, on the same
 * grounds `BookingCancellationService` was: this is a policy decision with its
 * own rules, its own audit row and its own reasons to refuse, and folding it
 * into the state machine would bury all three among the transitions.
 *
 * Two rules shape everything here:
 *
 * - **A reschedule is not a cancellation.** Nothing is refunded, no fee is
 *   charged, the price stays frozen, coins stay spent and the booking keeps its
 *   number. Only the slot moves.
 * - **A Pro can no more move a job than cancel one.** Principle 2 of the
 *   cancellation flow, applied to the other half of the same decision — the
 *   `requestedByType` CHECK constraint refuses `pro` outright.
 */
@Injectable()
export class BookingRescheduleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly state: BookingStateService,
    private readonly catalog: ServiceCatalogService,
    private readonly settings: PlatformSettingsService,
    @Inject(DISPATCH_PORT) private readonly dispatch: DispatchPort,
    @Inject(LOYALTY_PORT) private readonly loyalty: LoyaltyPort,
  ) {}

  /**
   * "Can I move this, and until when is it free?" — asked by the app before it
   * opens a date picker, so a customer is never offered a slot the next call
   * would refuse.
   */
  async preview(
    customerId: string,
    bookingId: string,
    now = new Date(),
  ): Promise<ReschedulePreview> {
    const booking = await this.bookings.getOwnedBooking(customerId, bookingId);
    const config = await this.readConfig(customerId);

    // Probed with a slot that is deliberately valid, so the answer is about
    // *this booking* rather than about a date the customer has not picked yet.
    const probe = new Date(
      now.getTime() + (config.freeRescheduleHours + 1) * 3_600_000,
    );

    const decision = decideReschedule({
      status: booking.status as BookingStatus,
      bookingType: booking.bookingType,
      slotStartAt: booking.slotStartAt,
      newSlotStartAt: probe,
      rescheduleCount: booking.rescheduleCount,
      allowance: config.allowance,
      freeRescheduleHours: config.freeRescheduleHours,
      now,
    });

    return {
      allowed: decision.allowed,
      refusal: decision.refusal,
      message: decision.message,
      hoursUntilSlot: decision.hoursUntilSlot,
      reschedulesRemaining: decision.reschedulesRemaining,
      freeRescheduleHours: config.freeRescheduleHours,
      currentSlotStartAt: booking.slotStartAt,
      earliestNewSlotAt: new Date(
        now.getTime() + config.freeRescheduleHours * 3_600_000,
      ),
    };
  }

  /** The customer's own path. */
  async rescheduleAsCustomer(
    customerId: string,
    bookingId: string,
    newSlotStartAt: Date,
    reason?: string,
  ): Promise<Booking> {
    const booking = await this.bookings.getOwnedBooking(customerId, bookingId);
    return this.move(booking, newSlotStartAt, 'customer', customerId, reason);
  }

  /**
   * Ops.
   *
   * Reaches the same rules rather than bypassing them, and that is deliberate:
   * the cutoff exists because of what a Pro's committed afternoon costs, and
   * that cost does not change because an admin is the one clicking. Ops moving
   * a job inside the window is the reassignment path, not this one.
   *
   * The one thing ops does bypass is the **allowance** — a customer who has
   * used their two moves can still be helped by a human.
   */
  async rescheduleAsOps(
    adminId: string,
    bookingId: string,
    newSlotStartAt: Date,
    reason: string,
  ): Promise<Booking> {
    const booking = await this.bookings.getByIdOrFail(bookingId);
    return this.move(booking, newSlotStartAt, 'ops', adminId, reason, {
      ignoreAllowance: true,
    });
  }

  // ------------------------------------------------------------------

  private async move(
    booking: Booking,
    newSlotStartAt: Date,
    requestedByType: 'customer' | 'ops',
    requestedById: string,
    reason?: string,
    options: { ignoreAllowance?: boolean } = {},
  ): Promise<Booking> {
    const now = new Date();
    const config = await this.readConfig(booking.customerId);

    const decision = decideReschedule({
      status: booking.status as BookingStatus,
      bookingType: booking.bookingType,
      slotStartAt: booking.slotStartAt,
      newSlotStartAt,
      rescheduleCount: booking.rescheduleCount,
      allowance: options.ignoreAllowance
        ? Number.MAX_SAFE_INTEGER
        : config.allowance,
      freeRescheduleHours: config.freeRescheduleHours,
      now,
    });

    if (!decision.allowed) {
      throw apiError(
        decision.message,
        decision.refusal === 'NEW_SLOT_IN_THE_PAST' ||
          decision.refusal === 'NEW_SLOT_INSIDE_CUTOFF' ||
          decision.refusal === 'SAME_SLOT'
          ? HttpStatus.BAD_REQUEST
          : HttpStatus.CONFLICT,
        [
          {
            field: 'slotStartAt',
            message: decision.message,
            code: `RESCHEDULE_${decision.refusal}`,
          },
        ],
      );
    }

    // The duration is re-read from the catalogue rather than reused from the
    // old slot, because `slotEnd - slotStart` is what the job was sold against
    // (US-3.6) and a service whose duration changed since should not have its
    // old window silently carried forward onto a new date.
    const service = await this.catalog.assertBookable(booking.serviceId);
    const newSlotEndAt = new Date(
      newSlotStartAt.getTime() + service.durationMinutes * 60_000,
    );

    // A booking that already had a Pro is going back into the pool: the
    // assignment was for a time that no longer exists, and holding it would
    // block that Pro's new afternoon for a job that moved off it.
    const wasAssigned = ['assigned', 'assigning'].includes(booking.status);
    if (booking.proId) {
      await this.dispatch.closeAssignment(
        booking.id,
        `Rescheduled to ${newSlotStartAt.toISOString()}`,
      );
    }

    const previousSlot = booking.slotStartAt ?? booking.createdAt;

    const [updated] = await this.prisma.$transaction([
      this.prisma.booking.update({
        where: { id: booking.id },
        data: {
          slotStartAt: newSlotStartAt,
          slotEndAt: newSlotEndAt,
          rescheduleCount: { increment: 1 },
          // Written on the first move only, so the original promise survives
          // however many moves follow.
          ...(booking.originalSlotStartAt
            ? {}
            : { originalSlotStartAt: previousSlot }),
          // A scheduled job that lost its Pro goes back to `assigning`;
          // dispatch re-runs against the new time. An unassigned booking keeps
          // whatever status it had.
          //
          // Written directly rather than through `BookingStateService`, which
          // is the one place in this module that does so. Two reasons, and
          // both matter: the slot, the counter and the `BookingReschedule` row
          // have to move in the **same transaction** as the status, and
          // `transition()` opens its own; and the edge is fixed rather than
          // computed — `RESCHEDULABLE_STATUSES` means a booking with a `proId`
          // here is always `assigned`, and `assigned → assigning` is a legal
          // transition the state machine already allows. The status event is
          // still appended below, so the timeline is not short-changed.
          ...(booking.proId
            ? {
                status: 'assigning',
                proId: null,
                assignedAt: null,
                acknowledgedAt: null,
                ackDeadlineAt: null,
                assignmentOutcome: 'rescheduled',
              }
            : {}),
          // An instant booking that gets a slot is a scheduled one now.
          bookingType:
            booking.bookingType === 'instant'
              ? 'scheduled'
              : booking.bookingType,
        },
      }),
      this.prisma.bookingReschedule.create({
        data: {
          bookingId: booking.id,
          fromSlotStartAt: previousSlot,
          toSlotStartAt: newSlotStartAt,
          toSlotEndAt: newSlotEndAt,
          hoursBeforeSlot: (hoursUntil(booking.slotStartAt, now) ?? 0).toFixed(
            2,
          ),
          requestedByType,
          requestedById,
          reason: reason ?? null,
          // Always free. The policy refuses a late move rather than pricing
          // one — see `decideReschedule`. The column exists so a later
          // paid-reschedule policy has somewhere to land without a migration.
          feeAmount: '0',
        },
      }),
    ]);

    // The move lands in the booking's own timeline too, so a support agent
    // reading the status events sees the gap explained rather than a booking
    // that mysteriously returned to `assigning`.
    //
    // Not a status *transition*: `rescheduled` is not one of the nine states,
    // and adding a tenth for something that does not change what happens next
    // would be a state-machine edit to record an annotation. The detail —
    // from, to, who, how many hours' notice — lives on the `BookingReschedule`
    // row written above, which is what `BookingStatusEvent` has no column for.
    await this.state.recordEvent(
      booking.id,
      updated.status,
      requestedByType === 'ops' ? 'ops' : 'customer',
      requestedById,
    );

    if (wasAssigned || booking.proId) {
      // Re-dispatch against the new time. Non-fatal: a booking sitting in
      // `assigning` is exactly what ops' manual assignment screen is for, and
      // the customer's slot has already moved either way.
      await this.dispatch.requestAssignment(booking.id).catch(() => undefined);
    }

    return updated;
  }

  private async readConfig(customerId: string): Promise<{
    allowance: number;
    freeRescheduleHours: number;
  }> {
    const [maxReschedules, freeRescheduleHours, perks] = await Promise.all([
      this.settings.getNumber('booking.maxReschedules', 2),
      this.settings.getNumber('booking.freeRescheduleHours', 6),
      this.loyalty.perksFor(customerId),
    ]);

    return {
      allowance:
        Math.max(0, Math.floor(maxReschedules)) + perks.extraReschedules,
      freeRescheduleHours: Math.max(0, freeRescheduleHours),
    };
  }

  /** The move history for one booking — ops and support read this. */
  listFor(bookingId: string): Promise<BookingReschedule[]> {
    return this.prisma.bookingReschedule.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
