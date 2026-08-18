import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import type { SosAlert } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionCode } from '../identity/constants/permission-code';
import { NotificationsService } from '../notifications/notifications.service';
import type { RaiseSosDto, ResolveSosDto } from './dto/sos.dto';
import {
  SUPPORT_EVENTS,
  SUPPORT_TEMPLATES,
  type SosContextSnapshot,
  type SosOutcome,
  type SosRaiserType,
} from './support.types';

/**
 * An alert with its acknowledgement latency attached.
 *
 * Derived on read rather than stored, so it cannot drift from the two
 * timestamps it comes from — and declared on the signature rather than cast at
 * the call site, so the controller and the tests see the same shape the
 * service actually returns.
 */
export type AlertWithResponseTime = SosAlert & {
  responseSeconds: number | null;
};

/**
 * Two-sided SOS — features 1 to 5.
 *
 * ## Why this is not a ticket
 *
 * Feature 5 says an SOS "bypasses normal ticket queuing". This module reads
 * that as three concrete mechanisms rather than a priority flag:
 *
 * 1. **It is not a ticket at all.** Separate table, separate route, separate
 *    permission, separate ops screen. It never enters ticket assignment, never
 *    gets a category, never waits behind a billing query. The queue is not
 *    jumped — it is not entered.
 * 2. **Fan-out is to people, not to a screen.** Every admin holding
 *    `safety.sos.respond` whose city scope covers the booking is notified
 *    directly, and an alert that matches nobody escalates to every holder of
 *    the permission rather than going quiet.
 * 3. **The alert and its notifications commit together.** One transaction. A
 *    committed alert nobody was told about is the failure this prevents.
 */
@Injectable()
export class SosService {
  private readonly logger = new Logger(SosService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------
  // Raising
  // -------------------------------------------------------------------

  /**
   * One tap, from either side.
   *
   * `raisedByType` comes from the token, never from the body — a DTO field
   * would let a customer file an alert as a Pro.
   *
   * Note what is **not** here: no rate limit, no cooldown, no "you already
   * have an open alert" rejection. A person pressing an SOS button twice is
   * telling us something; answering the second press with a 429 is the one
   * failure mode this endpoint cannot have.
   */
  async raise(
    actor: AuthenticatedUser,
    raisedByType: SosRaiserType,
    dto: RaiseSosDto,
  ): Promise<SosAlert> {
    const booking = dto.bookingId
      ? await this.loadOwnedBooking(dto.bookingId, actor.id, raisedByType)
      : null;

    const snapshot = this.buildSnapshot(booking);
    const cityId =
      booking?.address.cityId ?? (await this.actorCity(actor, raisedByType));
    const responders = await this.respondersFor(cityId);

    const alert = await this.prisma.$transaction(async (tx) => {
      const created = await tx.sosAlert.create({
        data: {
          raisedByType,
          customerId:
            raisedByType === 'customer'
              ? actor.id
              : (booking?.customerId ?? null),
          proId: raisedByType === 'pro' ? actor.id : (booking?.proId ?? null),
          bookingId: booking?.id ?? null,
          lat: dto.lat ?? null,
          lng: dto.lng ?? null,
          contextSnapshot: {
            ...snapshot,
            note: dto.note ?? null,
          },
        },
      });

      for (const responder of responders) {
        await this.notifications.enqueue(
          {
            eventKey: SUPPORT_EVENTS.sosRaised,
            dedupeKey: `${SUPPORT_EVENTS.sosRaised}:${created.id}:${responder.id}`,
            templateKey: SUPPORT_TEMPLATES.sosRaisedAdmin,
            recipientType: 'admin',
            recipientId: responder.id,
            bookingId: booking?.id,
            variables: {
              alertId: created.id,
              raisedBy: raisedByType,
              bookingNumber: snapshot.bookingNumber,
              addressLine: snapshot.addressText,
              lat: dto.lat ?? snapshot.addressLat,
              lng: dto.lng ?? snapshot.addressLng,
            },
          },
          tx,
        );
      }

      return created;
    });

    if (responders.length === 0) {
      // Loud, because the alert itself succeeded and a quiet log here would
      // mean a safety alert sitting in a table nobody is watching.
      this.logger.error(
        `SOS ${alert.id} raised with NO admin holding ${PermissionCode.SOS_RESPOND}. ` +
          'Nobody has been notified — grant the permission to an on-duty role.',
      );
    } else {
      this.logger.warn(
        `SOS ${alert.id} raised by ${raisedByType} ${actor.id}; ` +
          `${responders.length} responder(s) notified.`,
      );
    }

    return alert;
  }

  // -------------------------------------------------------------------
  // Ops
  // -------------------------------------------------------------------

  async listForAdmin(status?: string): Promise<AlertWithResponseTime[]> {
    const alerts = await this.prisma.sosAlert.findMany({
      where: status ? { status } : {},
      // Open first, then oldest first inside each group: an alert that has
      // been waiting eleven minutes outranks one raised thirty seconds ago.
      orderBy: [{ status: 'asc' }, { raisedAt: 'asc' }],
      take: 200,
    });
    return alerts.map((alert) => this.withResponseTime(alert));
  }

  async getForAdmin(id: string): Promise<AlertWithResponseTime> {
    const alert = await this.prisma.sosAlert.findUnique({ where: { id } });
    if (!alert) throw apiError('SOS alert not found', HttpStatus.NOT_FOUND);
    return this.withResponseTime(alert);
  }

  /** What the raiser can see of their own alerts. No ops notes, no snapshot. */
  async listForRaiser(
    actorId: string,
    raisedByType: SosRaiserType,
  ): Promise<Partial<SosAlert>[]> {
    return this.prisma.sosAlert.findMany({
      where:
        raisedByType === 'customer'
          ? { customerId: actorId, raisedByType: 'customer' }
          : { proId: actorId, raisedByType: 'pro' },
      select: {
        id: true,
        status: true,
        raisedAt: true,
        acknowledgedAt: true,
        resolvedAt: true,
        bookingId: true,
      },
      orderBy: { raisedAt: 'desc' },
      take: 20,
    });
  }

  /**
   * Acknowledgement is **idempotent**.
   *
   * Two responders opening the same alert at the same time is the expected
   * case, not the exceptional one. The first one to write owns the record, and
   * the second gets it back unchanged — so the response-time metric is not
   * rewritten by whoever clicked last.
   */
  async acknowledge(
    id: string,
    adminId: string,
  ): Promise<AlertWithResponseTime> {
    const alert = await this.getForAdmin(id);
    if (alert.status !== 'open') return alert;

    const updated = await this.prisma.sosAlert.updateMany({
      where: { id, status: 'open' },
      data: {
        status: 'acknowledged',
        acknowledgedByAdminId: adminId,
        acknowledgedAt: new Date(),
      },
    });

    const fresh = await this.getForAdmin(id);
    if (updated.count > 0) await this.notifyRaiserOfAcknowledgement(fresh);
    return fresh;
  }

  /**
   * Closing an alert requires that somebody first admits to having seen it.
   *
   * `false_alarm` is a real outcome rather than a failure to respond — a
   * pocket tap closed honestly is better data than one closed as `resolved`.
   */
  async resolve(
    id: string,
    adminId: string,
    dto: ResolveSosDto,
  ): Promise<AlertWithResponseTime> {
    const alert = await this.getForAdmin(id);

    if (alert.status === 'open')
      throw apiError(
        'Acknowledge the alert before closing it — a resolution with no ' +
          'acknowledgement records a response that never happened.',
        HttpStatus.CONFLICT,
      );

    if (alert.status !== 'acknowledged')
      throw apiError('This alert is already closed', HttpStatus.CONFLICT);

    const updated = await this.prisma.sosAlert.update({
      where: { id },
      data: {
        status: dto.outcome satisfies SosOutcome,
        resolvedByAdminId: adminId,
        resolvedAt: new Date(),
        resolutionNotes: dto.resolutionNotes,
      },
    });
    return this.withResponseTime(updated);
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  /**
   * Admins who should be woken up, in city-scope order.
   *
   * `Role.permissionCodes` is a Json array, so the filter happens in memory —
   * there are tens of admin rows, not millions, and a `Json` containment query
   * would tie this to Postgres operator syntax Prisma renders inconsistently.
   *
   * **The fallback is deliberate.** If no scoped responder matches — an alert
   * with no booking, or a city with nobody on duty — every holder of the
   * permission is notified instead. An over-broad safety alert is a nuisance;
   * an unrouted one is the feature not working.
   */
  private async respondersFor(
    cityId: string | null,
  ): Promise<{ id: string }[]> {
    const admins = await this.prisma.adminUser.findMany({
      where: { isActive: true },
      select: {
        id: true,
        cityScopeJson: true,
        role: { select: { permissionCodes: true } },
      },
    });

    const permitted = admins.filter((admin) => {
      const codes = admin.role.permissionCodes;
      return Array.isArray(codes) && codes.includes(PermissionCode.SOS_RESPOND);
    });

    if (!cityId) return permitted.map(({ id }) => ({ id }));

    const scoped = permitted.filter((admin) => {
      const scope = admin.cityScopeJson;
      // An empty scope array means platform-wide, per the AdminUser doc
      // comment — those admins see everything and must be included.
      if (!Array.isArray(scope) || scope.length === 0) return true;
      return scope.includes(cityId);
    });

    return (scoped.length > 0 ? scoped : permitted).map(({ id }) => ({ id }));
  }

  private async loadOwnedBooking(
    bookingId: string,
    actorId: string,
    raisedByType: SosRaiserType,
  ) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        address: true,
        service: { select: { name: true } },
        customer: { select: { id: true, fullName: true, phone: true } },
        pro: {
          select: { id: true, fullName: true, phone: true, employeeCode: true },
        },
      },
    });

    if (!booking) throw apiError('Booking not found', HttpStatus.NOT_FOUND);

    const owns =
      raisedByType === 'customer'
        ? booking.customerId === actorId
        : booking.proId === actorId;

    // Non-disclosure, as everywhere else in this codebase: 404 rather than
    // 403, so a probe cannot enumerate bookings it does not own.
    if (!owns) throw apiError('Booking not found', HttpStatus.NOT_FOUND);

    return booking;
  }

  /** The city to route by when there is no booking to read one from. */
  private async actorCity(
    actor: AuthenticatedUser,
    raisedByType: SosRaiserType,
  ): Promise<string | null> {
    if (raisedByType === 'pro') {
      const pro = await this.prisma.pro.findUnique({
        where: { id: actor.id },
        select: { cityId: true },
      });
      return pro?.cityId ?? null;
    }

    const address = await this.prisma.customerAddress.findFirst({
      where: { customerId: actor.id, isDefault: true },
      select: { cityId: true },
    });
    return address?.cityId ?? null;
  }

  private buildSnapshot(
    booking: Awaited<ReturnType<SosService['loadOwnedBooking']>> | null,
  ): SosContextSnapshot {
    const capturedAt = new Date().toISOString();
    if (!booking)
      return {
        bookingId: null,
        bookingNumber: null,
        bookingStatus: null,
        serviceName: null,
        cityId: null,
        scheduledFor: null,
        arrivedAt: null,
        startedAt: null,
        addressText: null,
        addressLat: null,
        addressLng: null,
        customer: null,
        pro: null,
        capturedAt,
      };

    return {
      bookingId: booking.id,
      bookingNumber: booking.bookingNumber,
      bookingStatus: booking.status,
      serviceName: booking.service.name,
      cityId: booking.address.cityId,
      scheduledFor: booking.slotStartAt?.toISOString() ?? null,
      arrivedAt: booking.arrivedAt?.toISOString() ?? null,
      startedAt: booking.startedAt?.toISOString() ?? null,
      addressText: booking.address.addressLine,
      addressLat: booking.address.pinLat,
      addressLng: booking.address.pinLng,
      customer: {
        id: booking.customer.id,
        name: booking.customer.fullName,
        phone: booking.customer.phone,
      },
      pro: booking.pro
        ? {
            id: booking.pro.id,
            name: booking.pro.fullName,
            phone: booking.pro.phone,
            employeeCode: booking.pro.employeeCode,
          }
        : null,
      capturedAt,
    };
  }

  /**
   * Tells the raiser somebody is on it.
   *
   * Non-fatal on purpose: a notification failure must never roll back an
   * acknowledgement that genuinely happened.
   */
  private async notifyRaiserOfAcknowledgement(alert: SosAlert): Promise<void> {
    const recipientId =
      alert.raisedByType === 'customer' ? alert.customerId : alert.proId;
    if (!recipientId) return;

    try {
      await this.notifications.enqueue({
        eventKey: SUPPORT_EVENTS.sosAcknowledged,
        dedupeKey: `${SUPPORT_EVENTS.sosAcknowledged}:${alert.id}`,
        templateKey: SUPPORT_TEMPLATES.sosAcknowledgedRaiser,
        recipientType: alert.raisedByType === 'customer' ? 'customer' : 'pro',
        recipientId,
        bookingId: alert.bookingId ?? undefined,
        variables: { alertId: alert.id },
      });
    } catch (error) {
      this.logger.error(
        `Could not notify the raiser of SOS ${alert.id}: ` +
          (error instanceof Error ? error.message : 'unknown error'),
      );
    }
  }

  /**
   * `acknowledgedAt − raisedAt`, in seconds.
   *
   * Computed rather than stored. An acknowledgement target nobody can measure
   * is a target nobody meets, and a derived number cannot drift from the two
   * timestamps it comes from.
   */
  private withResponseTime(alert: SosAlert): AlertWithResponseTime {
    return {
      ...alert,
      responseSeconds: alert.acknowledgedAt
        ? Math.round(
            (alert.acknowledgedAt.getTime() - alert.raisedAt.getTime()) / 1000,
          )
        : null,
    };
  }
}
