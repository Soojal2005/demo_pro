import type { Booking } from '../../prisma/client';

/**
 * What a Pro is allowed to read off their own job row.
 *
 * `startOtpCode` is stripped, and that is the first reason this file exists.
 * The code is the customer's half of a two-party handshake: the Pro is meant
 * to be *told* it at the door, which is what makes starting the job consent
 * rather than a formality (see `BookingLifecycleService.verifyStartOtp`). A
 * Pro app that can read the digits out of its own job payload can start a job
 * nobody consented to — and the whole trust anchor, `startedAt`, and the
 * commission that hangs off it, rest on that not being possible.
 *
 * `getAssignedBooking` deliberately still returns the raw row, because the
 * lifecycle service needs the stored code to compare against. Nothing that
 * crosses the wire to a Pro may carry it.
 *
 * `startOtpProviderRef` goes with it — a dead Slide reference from when the
 * code was an SMS, of no use to a phone and no business on a Pro surface.
 */
export type ProBookingView = Omit<
  Booking,
  'startOtpCode' | 'startOtpProviderRef'
>;

export function toProBooking(row: Booking): ProBookingView {
  const view: Partial<Booking> = { ...row };
  delete view.startOtpCode;
  delete view.startOtpProviderRef;
  return view as ProBookingView;
}

export const toProBookings = (rows: Booking[]): ProBookingView[] =>
  rows.map(toProBooking);

/**
 * The second reason: a job the Pro cannot travel to is not a job.
 *
 * The bare row carries `addressId`, `customerId` and `serviceId` and nothing
 * else, so a Pro app rendering it could show a UUID where the street should
 * be. The customer side has had `CUSTOMER_BOOKING_INCLUDE` since module 4; the
 * Pro side never got its mirror, and no other Pro-facing route resolves a
 * customer address — so the job card had no way to say where to go.
 *
 * Pass this as `include` on every Pro-facing booking read.
 *
 * ## What is in it, and what is deliberately not
 *
 * `address` carries the pin as well as the text: `pinLat`/`pinLng` are what
 * the Pro is routed to, the street line is what they read out to a security
 * guard, and `landmark` is what actually finds the door.
 *
 * `customer` carries **`fullName` only**. Not the phone number — US-4.8 is
 * explicit that neither side sees the other's, which is the entire reason the
 * booking chat thread exists rather than an exchange of numbers. A number here
 * would quietly undo that, and the Pro persona doc lists contact detail among
 * the things a Pro does not get. `ratingSum`/`ratingCount` are the household's
 * counters, mirroring what the customer app already shows about the Pro — the
 * tag-level detail behind them stays on `GET customer-advisory`, which is
 * aggregated and names nobody.
 *
 * `service` carries the name and the sold duration.
 *
 * **The sum to collect on a cash job is `payableAmount`, not `flatPrice`.**
 * They were the same number until module 16; they are not any more. A customer
 * who put coins or a plan discount against a ₹500 job owes ₹350 at the door,
 * and a Pro insisting on ₹500 because the app told them to is the argument
 * this note exists to prevent. `CashCollectionService` reads the same column
 * and takes no amount parameter, so the app cannot disagree with the ledger —
 * but the Pro still has to be shown the right figure.
 */
export const PRO_JOB_INCLUDE = {
  service: { select: { name: true, durationMinutes: true } },
  address: {
    select: {
      addressLine: true,
      landmark: true,
      pinLat: true,
      pinLng: true,
    },
  },
  customer: { select: { fullName: true, ratingSum: true, ratingCount: true } },
} as const;

/** A booking read with `PRO_JOB_INCLUDE`. Structural, so tests need no Prisma. */
export interface ProJobRow extends Booking {
  service: { name: string; durationMinutes: number | null } | null;
  address: {
    addressLine: string;
    landmark: string | null;
    pinLat: number;
    pinLng: number;
  } | null;
  customer: {
    fullName: string | null;
    ratingSum: number;
    ratingCount: number;
  } | null;
}

export interface ProJobView extends ProBookingView {
  service: ProJobRow['service'];
  address: ProJobRow['address'];
  customer: ProJobRow['customer'];
}

export function toProJob(row: ProJobRow): ProJobView {
  return {
    ...toProBooking(row),
    service: row.service,
    address: row.address,
    customer: row.customer,
  };
}

export const toProJobs = (rows: ProJobRow[]): ProJobView[] =>
  rows.map(toProJob);
