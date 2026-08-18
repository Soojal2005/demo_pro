import {
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Booking, Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ServiceCatalogService } from '../catalog/service-catalog.service';
import { CustomersService } from '../customers/customers.service';
import type { BookingStatus, PaymentMode } from './booking.types';
import { BookingStateService } from './booking-state.service';
import {
  CUSTOMER_BOOKING_DETAIL_INCLUDE,
  CUSTOMER_BOOKING_INCLUDE,
  toCustomerBooking,
  toCustomerBookingDetail,
} from './customer-booking.view';
import { CreateBookingDto } from './dto/create-booking.dto';
import type {
  CustomerBookingDetailDto,
  CustomerBookingDto,
} from './dto/customer-booking.dto';
import { DISPATCH_PORT, type DispatchPort } from './ports/dispatch.port';
import { PAYMENTS_PORT, type PaymentsPort } from './ports/payments.port';
import {
  SERVICEABILITY_PORT,
  type ServiceabilityPort,
} from './ports/serviceability.port';

/** Statuses that mean the booking is still live work rather than history. */
const LIVE_STATUSES: BookingStatus[] = [
  'created',
  'awaiting_payment',
  'assigning',
  'assigned',
  'en_route',
  'arrived',
  'started',
];

@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: BookingStateService,
    private readonly catalog: ServiceCatalogService,
    private readonly customers: CustomersService,
    @Inject(DISPATCH_PORT) private readonly dispatch: DispatchPort,
    @Inject(PAYMENTS_PORT) private readonly payments: PaymentsPort,
    @Inject(SERVICEABILITY_PORT)
    private readonly serviceability: ServiceabilityPort,
  ) {}

  // ------------------------------------------------------------------
  // Creation
  // ------------------------------------------------------------------

  /**
   * Instant or scheduled, cash or online.
   *
   * Four things are settled here and never revisited: the price, the expected
   * duration, the payment mode and the slot. All four are read from the
   * catalogue and the clock — none is taken from the client, because all four
   * decide what the customer is charged and when someone turns up.
   *
   * `idempotencyKey` makes a retried request return the original booking
   * rather than creating a second one. A double-tap on a slow connection is
   * the common case, not the exotic one.
   */
  async create(
    customerId: string,
    dto: CreateBookingDto,
    idempotencyKey?: string,
  ): Promise<Booking> {
    if (idempotencyKey) {
      const existing = await this.findByIdempotencyKey(
        customerId,
        idempotencyKey,
      );
      if (existing) return existing;
    }

    // Ownership first: an address that belongs to someone else must be
    // indistinguishable from one that does not exist.
    const address = await this.customers.getAddressForCustomer(
      customerId,
      dto.addressId,
    );

    const { serviceable } = await this.customers.checkServiceability(
      address.cityId,
    );
    if (!serviceable) {
      throw apiError(
        'We are not operating in this city yet',
        HttpStatus.CONFLICT,
        [
          {
            field: 'addressId',
            message: 'City is not currently serviceable',
            code: 'CITY_NOT_SERVICEABLE',
          },
        ],
      );
    }

    // Refuses a draft or retired service, and a service under a hidden
    // category — the catalogue owns that judgement, not this module.
    const service = await this.catalog.assertBookable(dto.serviceId);

    const bookingType = dto.slotStartAt ? 'scheduled' : 'instant';
    this.assertServiceSupports(service, bookingType);

    if (dto.slotStartAt && dto.slotStartAt.getTime() <= Date.now()) {
      throw apiError(
        'A scheduled slot must be in the future',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'slotStartAt',
            message: 'Must be later than now',
            code: 'SLOT_IN_THE_PAST',
          },
        ],
      );
    }

    // The area gate, from the address's own pin — never from anything the
    // client sent. `checkServiceability` above answered the city question;
    // this answers the finer one, "is this service live at this pin", and
    // returns the area to freeze onto the booking.
    //
    // It re-resolves rather than reading `address.areaId`, because areas can
    // be redrawn between saving an address and booking against it.
    const { areaId } = await this.serviceability.resolveForBooking({
      lat: address.pinLat,
      lng: address.pinLng,
      serviceId: service.id,
      cityId: address.cityId,
    });

    // Both cash gates, enforced server-side because `paymentMode` is frozen
    // the moment the row below is written and no route can change it after.
    // The port answers permissively until module 7 registers, so cash keeps
    // working on a deployment with no gateway configured.
    if (dto.paymentMode === 'cash') {
      await this.payments.assertCashAllowed(service.id, address.cityId);
    }

    const slotStartAt = dto.slotStartAt ?? new Date();
    const slotEndAt = new Date(
      slotStartAt.getTime() + service.durationMinutes * 60_000,
    );

    const booking = await this.createWithUniqueBookingNumber({
      customerId,
      serviceId: service.id,
      addressId: address.id,
      // Frozen like flatPrice: areas get redrawn, and this booking must
      // keep saying where it was taken.
      areaId,
      bookingType,
      slotStartAt,
      slotEndAt,
      // Frozen here, and never recomputed from the live catalogue again.
      flatPrice: service.flatPrice,
      paymentMode: dto.paymentMode,
      paymentStatus: 'unpaid',
      status: 'created',
    });

    await this.state.recordEvent(booking.id, 'created', 'customer', customerId);

    return this.advanceAfterCreation(booking);
  }

  /**
   * One tap, same service and address, new booking.
   *
   * Rotation still applies: `rebookedFromBookingId` records the lineage but
   * the Pro is deliberately not copied. A rebook is not a request for the same
   * person — dispatch decides that, and deprioritising a household's last Pro
   * is the whole point of rule 3.
   */
  async rebook(customerId: string, sourceBookingId: string): Promise<Booking> {
    const source = await this.getOwnedBooking(customerId, sourceBookingId);

    const created = await this.create(customerId, {
      serviceId: source.serviceId,
      addressId: source.addressId,
      paymentMode: source.paymentMode as PaymentMode,
    });

    return this.prisma.booking.update({
      where: { id: created.id },
      data: { rebookedFromBookingId: source.id },
    });
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  listForCustomer(customerId: string): Promise<Booking[]> {
    return this.prisma.booking.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /**
   * The admin listing this module launched without — support and ops had no
   * way to browse bookings at all, only look one up by an id they already
   * had. Same shape as the other admin list endpoints in this codebase:
   * optional filters, newest first, capped rather than paginated.
   *
   * `allowedCityIds` mirrors ProsService.findMany's pattern. Booking has no
   * direct cityId; scope is applied via the delivery address's city, since
   * that is where the job actually happens (not the customer's other saved
   * addresses, which may span cities the customer has lived in).
   */
  listForAdmin(
    query: {
      search?: string;
      status?: BookingStatus;
      customerId?: string;
      proId?: string;
    },
    allowedCityIds?: string[],
  ): Promise<Booking[]> {
    return this.prisma.booking.findMany({
      where: {
        // Applied here rather than in the console, because `take` below caps
        // the result: filtering the returned page would answer "no such
        // booking" for anything older than the hundredth.
        ...(query.search && {
          bookingNumber: { contains: query.search, mode: 'insensitive' },
        }),
        status: query.status,
        customerId: query.customerId,
        proId: query.proId,
        ...(allowedCityIds?.length && {
          address: { cityId: { in: allowedCityIds } },
        }),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  listLiveForCustomer(customerId: string): Promise<Booking[]> {
    return this.prisma.booking.findMany({
      where: { customerId, status: { in: LIVE_STATUSES } },
      orderBy: { slotStartAt: 'asc' },
    });
  }

  // ------------------------------------------------------------------
  // Customer-facing reads
  //
  // Same rows, resolved into what a phone draws — see customer-booking.view.
  // They live here rather than in a view service so the `where` clauses and
  // LIVE_STATUSES have exactly one definition; a second copy is how a booking
  // ends up live in one list and missing from the other.
  // ------------------------------------------------------------------

  async listViewForCustomer(customerId: string): Promise<CustomerBookingDto[]> {
    const rows = await this.prisma.booking.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: CUSTOMER_BOOKING_INCLUDE,
    });
    return rows.map(toCustomerBooking);
  }

  async listLiveViewForCustomer(
    customerId: string,
  ): Promise<CustomerBookingDto[]> {
    const rows = await this.prisma.booking.findMany({
      where: { customerId, status: { in: LIVE_STATUSES } },
      orderBy: { slotStartAt: 'asc' },
      include: CUSTOMER_BOOKING_INCLUDE,
    });
    return rows.map(toCustomerBooking);
  }

  /**
   * One booking the caller owns, with its trail.
   *
   * Ownership is part of the `where` rather than checked after the read, so a
   * booking belonging to somebody else is a 404 and not a 403 — which would
   * confirm the id exists.
   */
  async getOwnedBookingDetailView(
    customerId: string,
    bookingId: string,
  ): Promise<CustomerBookingDetailDto> {
    const row = await this.prisma.booking.findFirst({
      where: { id: bookingId, customerId },
      include: CUSTOMER_BOOKING_DETAIL_INCLUDE,
    });
    if (!row) throw new NotFoundException('Booking not found');
    return toCustomerBookingDetail(row);
  }

  /**
   * A booking that was just written, in the shape the client reads.
   *
   * Create and cancel both need this: the row they have in hand came back
   * without its relations, and the client cannot draw a card from ids.
   */
  async viewOf(
    customerId: string,
    bookingId: string,
  ): Promise<CustomerBookingDetailDto> {
    return this.getOwnedBookingDetailView(customerId, bookingId);
  }

  /** Backs the payment-hold expiry sweep — US-4.6. */
  findAwaitingPaymentBefore(cutoff: Date): Promise<Booking[]> {
    return this.prisma.booking.findMany({
      where: { status: 'awaiting_payment', createdAt: { lt: cutoff } },
      take: 500,
    });
  }

  listForPro(proId: string): Promise<Booking[]> {
    return this.prisma.booking.findMany({
      where: { proId, status: { in: LIVE_STATUSES } },
      orderBy: { slotStartAt: 'asc' },
    });
  }

  async getOwnedBooking(
    customerId: string,
    bookingId: string,
  ): Promise<Booking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    // Someone else's booking id reads exactly like one that never existed.
    if (!booking || booking.customerId !== customerId) {
      throw apiError('Booking not found', HttpStatus.NOT_FOUND);
    }
    return booking;
  }

  async getAssignedBooking(proId: string, bookingId: string): Promise<Booking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking || booking.proId !== proId) {
      throw apiError('Booking not found', HttpStatus.NOT_FOUND);
    }
    return booking;
  }

  async getByIdOrFail(bookingId: string): Promise<Booking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) throw apiError('Booking not found', HttpStatus.NOT_FOUND);
    return booking;
  }

  /**
   * Everything a disputed job needs, in one call.
   *
   * US-4.24 is explicit that this is a design constraint and not a UI one:
   * "if reconstruction takes four tabs, disputes get settled on the customer's
   * word instead of the record."
   */
  async reconstruct(bookingId: string): Promise<
    Booking & {
      statusEvents: unknown[];
      photoProofs: unknown[];
      chatMessages: unknown[];
    }
  > {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        statusEvents: { orderBy: { occurredAt: 'asc' } },
        photoProofs: { orderBy: { capturedAt: 'asc' } },
        chatMessages: { orderBy: { sentAt: 'asc' } },
      },
    });
    if (!booking) throw apiError('Booking not found', HttpStatus.NOT_FOUND);
    return booking;
  }

  // ------------------------------------------------------------------
  // Admin assignment — the ops override alongside module 5
  // ------------------------------------------------------------------

  /**
   * The one gate every hand-placed assignment passes through.
   *
   * An ops override skips dispatch's *ranking* — who is nearest, whose turn it
   * is, who is rated well. It does not get to skip the facts that make an
   * assignment possible at all, which is what these five checks are. Dispatch
   * applies the same ones before it scores anyone
   * (`DispatchScoringService.findEligiblePros` and `computeFreeWindow`); this
   * is that floor, restated for the manual path.
   *
   * Deliberately no force flag: `reassignByAdmin` has never had one, and two
   * admin routes with different rules is how this drifted apart in the first
   * place. If ops ever needs an escape hatch, both paths get it together.
   */
  private async assertProEligible(
    booking: {
      id: string;
      serviceId: string;
      slotStartAt: Date | null;
      slotEndAt: Date | null;
    },
    cityId: string,
    proId: string,
  ): Promise<void> {
    const pro = await this.prisma.pro.findUnique({
      where: { id: proId },
      include: {
        services: {
          where: { serviceId: booking.serviceId, isActive: true },
          select: { id: true },
        },
      },
    });
    if (
      !pro ||
      pro.status !== 'approved' ||
      !pro.isAvailable ||
      pro.cityId !== cityId ||
      !pro.services.length
    ) {
      throw apiError(
        'The selected Pro is not currently eligible for this booking',
        HttpStatus.CONFLICT,
      );
    }

    // A Pro cannot be in two places. Only committed work occupies time — there
    // is no roster, so `isAvailable` above is the whole of "on duty".
    if (booking.slotStartAt && booking.slotEndAt) {
      const overlap = await this.prisma.booking.count({
        where: {
          id: { not: booking.id },
          proId: pro.id,
          status: { in: ['assigned', 'en_route', 'arrived', 'started'] },
          slotStartAt: { lt: booking.slotEndAt },
          slotEndAt: { gt: booking.slotStartAt },
        },
      });
      if (overlap) {
        throw apiError(
          'The selected Pro has a committed booking in this window',
          HttpStatus.CONFLICT,
        );
      }
    }
  }

  /**
   * Ops places a Pro on a booking that is still looking for one.
   *
   * Predates dispatch, and stays now that dispatch exists because US-5.14
   * requires a manual override from the Live Dispatch screen regardless. What
   * it no longer does is accept any Pro id at all: it was written when there
   * was no engine to be consistent with, and went years without the checks
   * dispatch and reassignment both apply.
   */
  async assignPro(
    bookingId: string,
    proId: string,
    adminId: string,
    reason?: string,
  ): Promise<Booking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { address: { select: { cityId: true } } },
    });
    if (!booking) throw apiError('Booking not found', HttpStatus.NOT_FOUND);

    await this.assertProEligible(booking, booking.address.cityId, proId);

    return this.state.transition({
      bookingId,
      to: 'assigned',
      actorType: 'ops',
      actorId: adminId,
      expectedFrom: ['assigning'],
      data: {
        pro: { connect: { id: proId } },
        assignedAt: new Date(),
        assignmentAttempt: { increment: 1 },
        // Not `acknowledged`: the Pro was told, not asked. Claiming otherwise
        // put a consent in the record that never happened, and — because the
        // acknowledgement endpoint requires `pending_ack` — locked the Pro out
        // of ever confirming the job they had just been handed.
        assignmentOutcome: 'ops_assigned',
        overriddenByAdmin: { connect: { id: adminId } },
        overrideReason: reason ?? 'Manual assignment by ops',
      },
    });
  }

  /**
   * Replace an assignment or return it to the dispatch queue. This is kept in
   * the booking domain so the admin console does not become a second writer of
   * booking state.
   */
  async reassignByAdmin(
    bookingId: string,
    input: {
      mode: 'specific_pro' | 'redispatch';
      proId?: string;
      reason: string;
    },
    adminId: string,
    allowedCityIds?: string[],
  ): Promise<Booking> {
    const reason = input.reason.trim();
    if (reason.length < 10) {
      throw apiError(
        'A reassignment reason of at least 10 characters is required',
        HttpStatus.BAD_REQUEST,
      );
    }
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { address: { select: { cityId: true } } },
    });
    if (!booking) throw apiError('Booking not found', HttpStatus.NOT_FOUND);
    if (
      allowedCityIds?.length &&
      !allowedCityIds.includes(booking.address.cityId)
    ) {
      throw apiError('Outside your city scope', HttpStatus.FORBIDDEN);
    }
    if (!['assigned', 'en_route'].includes(booking.status)) {
      throw apiError(
        'Only an assigned or en-route booking can be reassigned',
        HttpStatus.CONFLICT,
      );
    }

    if (input.mode === 'specific_pro') {
      await this.assertProEligible(
        booking,
        booking.address.cityId,
        input.proId!,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.booking.update({
        where: { id: booking.id },
        data:
          input.mode === 'redispatch'
            ? {
                status: 'assigning',
                proId: null,
                assignedAt: null,
                notifiedAt: null,
                ackDeadlineAt: null,
                acknowledgedAt: null,
                assignmentOutcome: 'ops_reassigned',
                overriddenByAdminId: adminId,
                overrideReason: reason,
              }
            : {
                status: 'assigned',
                proId: input.proId!,
                assignedAt: new Date(),
                notifiedAt: null,
                ackDeadlineAt: null,
                acknowledgedAt: null,
                assignmentAttempt: { increment: 1 },
                assignmentOutcome: 'ops_reassigned',
                overriddenByAdminId: adminId,
                overrideReason: reason,
              },
      });
      await tx.bookingStatusEvent.create({
        data: {
          bookingId: booking.id,
          status: next.status,
          actorType: 'ops',
          actorId: adminId,
        },
      });
      return next;
    });
    if (input.mode === 'redispatch')
      await this.dispatch.requestAssignment(booking.id);
    return updated;
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * The fork feature 8's linear state list could not express: cash dispatches
   * straight away, online has to be paid for first.
   */
  private async advanceAfterCreation(booking: Booking): Promise<Booking> {
    if (booking.paymentMode === 'cash') {
      const assigning = await this.state.transition({
        bookingId: booking.id,
        to: 'assigning',
        actorType: 'system',
        actorId: 'system',
        expectedFrom: ['created'],
      });
      await this.dispatch.requestAssignment(booking.id);
      return assigning;
    }

    const awaiting = await this.state.transition({
      bookingId: booking.id,
      to: 'awaiting_payment',
      actorType: 'system',
      actorId: 'system',
      expectedFrom: ['created'],
    });

    // Throws today: Payments is not built. The booking survives in
    // awaiting_payment, which is the honest state for it to be in.
    await this.payments.createOrder(booking.id, booking.flatPrice.toString());

    return awaiting;
  }

  private assertServiceSupports(
    service: { supportsInstant: boolean; supportsScheduled: boolean },
    bookingType: 'instant' | 'scheduled',
  ): void {
    const supported =
      bookingType === 'instant'
        ? service.supportsInstant
        : service.supportsScheduled;

    if (!supported) {
      throw apiError(
        `This service cannot be booked ${bookingType === 'instant' ? 'instantly' : 'for a future slot'}`,
        HttpStatus.CONFLICT,
        [
          {
            field: 'serviceId',
            message: `Service does not support ${bookingType} booking`,
            code: 'BOOKING_TYPE_UNSUPPORTED',
          },
        ],
      );
    }
  }

  /**
   * `HB-<year>-<sequence>`, from a Postgres sequence so concurrent creation
   * cannot collide. Mirrors `generateEmployeeCode` — deliberately not random,
   * because the point is a human reading it down a phone line.
   */
  private async generateBookingNumber(): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ nextval: bigint }[]>`
      SELECT nextval('booking_number_seq') AS nextval
    `;
    const year = new Date().getUTCFullYear();
    return `HB-${year}-${rows[0].nextval.toString().padStart(6, '0')}`;
  }

  /**
   * Sequences normally make booking numbers collision-free, but PostgreSQL
   * does not advance a sequence when data is imported with explicit numbers.
   * If that leaves production one or more values behind, consume the stale
   * values and retry instead of returning a 500 to the customer.
   */
  private async createWithUniqueBookingNumber(
    data: Omit<Prisma.BookingUncheckedCreateInput, 'bookingNumber'>,
  ): Promise<Booking> {
    const maxAttempts = 10;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.booking.create({
          data: { ...data, bookingNumber: await this.generateBookingNumber() },
        });
      } catch (error) {
        if (!this.isBookingNumberCollision(error) || attempt === maxAttempts) {
          throw error;
        }
      }
    }

    throw new Error('Could not allocate a unique booking number');
  }

  private isBookingNumberCollision(error: unknown): boolean {
    const known = error as {
      code?: string;
      meta?: { target?: string | string[] };
    };
    if (known.code !== 'P2002') return false;

    const target = known.meta?.target;
    return Array.isArray(target)
      ? target.includes('bookingNumber')
      : target?.includes('bookingNumber') === true;
  }

  /**
   * Idempotency without a dedicated table: the key is recorded as a status
   * event on the booking it created, so a replay finds it by lookup.
   *
   * A separate `IdempotencyKey` table would be the textbook answer, but the
   * ERD has no such table and inventing one would repeat the mistake conflicts
   * #1 and #13 record.
   */
  private async findByIdempotencyKey(
    customerId: string,
    key: string,
  ): Promise<Booking | null> {
    const event = await this.prisma.bookingStatusEvent.findFirst({
      where: { status: `idempotency:${key}`, actorId: customerId },
      include: { booking: true },
    });
    return event?.booking ?? null;
  }

  /** Called by the controller after a successful create. */
  async recordIdempotencyKey(
    bookingId: string,
    customerId: string,
    key: string,
  ): Promise<void> {
    await this.state.recordEvent(
      bookingId,
      `idempotency:${key}`,
      'customer',
      customerId,
    );
  }

  /** Shared by the cancellation and lifecycle services. */
  static get liveStatuses(): BookingStatus[] {
    return LIVE_STATUSES;
  }

  /** Prisma `where` fragment for "still live", reused across services. */
  static liveWhere(): Prisma.BookingWhereInput {
    return { status: { in: LIVE_STATUSES } };
  }
}
