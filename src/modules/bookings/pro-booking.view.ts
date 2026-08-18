import type { Booking } from '../../prisma/client';

/**
 * What a Pro is allowed to read off their own job row.
 *
 * `startOtpCode` is stripped, and that is the entire reason this file exists.
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
