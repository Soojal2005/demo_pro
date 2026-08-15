import type {
  CustomerBookingDetailDto,
  CustomerBookingDto,
} from './dto/customer-booking.dto';

/**
 * Turning a booking row into what a phone draws.
 *
 * Kept as pure functions beside the module rather than inside a service: they
 * hold no state, they are the one place the customer-facing shape is decided,
 * and a test can hand them a literal instead of standing up Nest.
 */

/** What `toCustomerBooking` needs loaded. Pass as `include` on every read. */
export const CUSTOMER_BOOKING_INCLUDE = {
  service: { select: { name: true, durationMinutes: true } },
  address: { select: { addressLine: true } },
  pro: { select: { fullName: true, ratingSum: true, ratingCount: true } },
  /*
   * Both directions live in this table, and only the customer's own is theirs
   * to see. The Pro's review of the household is deliberately not exposed —
   * see the note on `Review.comment`.
   */
  reviews: {
    where: { reviewerType: 'customer' },
    select: { rating: true, comment: true, tags: true, photoUrls: true },
    take: 1,
  },
} as const;

/**
 * The prefix `recordIdempotencyKey` files a key under.
 *
 * Idempotency keys are stored as rows in the status trail — it is already an
 * append-only log keyed by booking and actor, so it needed no second table.
 * The cost is that the trail contains entries that are not statuses, and a
 * client rendering it verbatim shows the customer a step called
 * "idempotency:HOM-000123-0". They are filtered out on the way past.
 */
const IDEMPOTENCY_EVENT_PREFIX = 'idempotency:';

/** `CUSTOMER_BOOKING_INCLUDE` plus the trail, for a booking being opened. */
export const CUSTOMER_BOOKING_DETAIL_INCLUDE = {
  ...CUSTOMER_BOOKING_INCLUDE,
  statusEvents: {
    orderBy: { occurredAt: 'asc' },
    select: { status: true, actorType: true, occurredAt: true },
  },
} as const;

/** True for a real transition, false for the bookkeeping rows beside them. */
const isStatusTransition = (event: { status: string }): boolean =>
  !event.status.startsWith(IDEMPOTENCY_EVENT_PREFIX);

/** Anything Prisma hands back for a `Decimal` column. */
type Money = { toString(): string } | null | undefined;

/**
 * A decimal column as a number, for display only.
 *
 * Rupee amounts are far inside the range a double represents exactly, so this
 * is safe for what it is used for — a figure on a card. Nothing that settles
 * money should come through here; that reads `flatPrice` off `BookingDto`,
 * which stays a string on purpose.
 */
const money = (value: Money): number | null =>
  value === null || value === undefined ? null : Number(value.toString());

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

/** JSON columns arrive as `unknown`; anything not an array of strings is none. */
const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];

/** The row shape these functions read. Structural, so tests need no Prisma. */
export interface CustomerBookingRow {
  id: string;
  bookingNumber: string;
  status: string;
  serviceId: string;
  bookingType: string;
  paymentStatus: string;
  flatPrice: { toString(): string };
  slotStartAt: Date | null;
  slotEndAt: Date | null;
  createdAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  cancelledByType: string | null;
  cancellationFeeAmount: Money;
  refundedAmount: Money;
  invoiceNumber: string | null;
  taxAmount: Money;
  startOtpCode: string | null;
  service: { name: string; durationMinutes: number | null } | null;
  address: { addressLine: string } | null;
  pro: {
    fullName: string | null;
    ratingSum: number;
    ratingCount: number;
  } | null;
  reviews: Array<{
    rating: number;
    comment: string | null;
    tags: unknown;
    photoUrls: unknown;
  }>;
}

export interface CustomerBookingDetailRow extends CustomerBookingRow {
  statusEvents: Array<{ status: string; actorType: string; occurredAt: Date }>;
}

export function toCustomerBooking(row: CustomerBookingRow): CustomerBookingDto {
  const review = row.reviews[0];

  return {
    id: row.id,
    reference: row.bookingNumber,
    status: row.status,
    /*
     * The service name is frozen nowhere, so this is whatever the catalogue
     * says today. Deliberate: a renamed service should read by its current
     * name in the history. The PRICE is the thing that must not drift, and
     * that one is frozen on the row.
     */
    title: row.service?.name ?? 'Service',
    serviceId: row.serviceId,
    durationMinutes:
      row.service?.durationMinutes ??
      minutesBetween(row.slotStartAt, row.slotEndAt),
    address: row.address?.addressLine ?? '',
    price: money(row.flatPrice) ?? 0,
    paymentStatus: row.paymentStatus,
    bookingType: row.bookingType,
    slotStartAt: iso(row.slotStartAt),
    slotEndAt: iso(row.slotEndAt),
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
    cancelledAt: iso(row.cancelledAt),
    cancelledByType: row.cancelledByType,
    cancellationFeeAmount: money(row.cancellationFeeAmount),
    refundedAmount: money(row.refundedAmount),
    invoiceNumber: row.invoiceNumber,
    taxAmount: money(row.taxAmount),
    /*
     * The code to read out, and only while there is somebody at the door to
     * read it to.
     *
     * Gated on `arrived` rather than simply sent whenever the column holds
     * something: before arrival there is nothing to authorise, and after the
     * job starts the code is spent — `verifyStartOtp` nulls it, and this gate
     * means even a row that somehow kept one cannot hand it back later. The
     * client keys its arrival panel off the presence of this field, so the
     * gate is also what switches that panel on.
     */
    startOtp: row.status === 'arrived' ? (row.startOtpCode ?? null) : null,
    /*
     * Null until someone is actually assigned. An unassigned booking with a
     * professional block would draw a card for a person who is not coming.
     */
    professional: row.pro
      ? { name: row.pro.fullName, rating: meanRating(row.pro) }
      : null,
    review: review
      ? {
          rating: review.rating,
          comment: review.comment,
          tags: stringList(review.tags),
          photoUrls: stringList(review.photoUrls),
        }
      : null,
  };
}

export function toCustomerBookingDetail(
  row: CustomerBookingDetailRow,
): CustomerBookingDetailDto {
  return {
    ...toCustomerBooking(row),
    timeline: row.statusEvents.filter(isStatusTransition).map((event) => ({
      status: event.status,
      by: event.actorType,
      at: event.occurredAt.toISOString(),
    })),
  };
}

/**
 * The duration the job was actually sold against.
 *
 * Only used when the service row could not be loaded. `slotEnd - slotStart` is
 * set at creation for instant bookings too, precisely so a later edit to
 * `Service.durationMinutes` cannot retroactively resize a booking.
 */
function minutesBetween(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

const meanRating = (pro: {
  ratingSum: number;
  ratingCount: number;
}): number | null =>
  pro.ratingCount > 0
    ? Math.round((pro.ratingSum / pro.ratingCount) * 10) / 10
    : null;
