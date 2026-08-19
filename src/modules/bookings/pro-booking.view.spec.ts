import type { Booking } from '../../prisma/client';
import {
  PRO_JOB_INCLUDE,
  toProBooking,
  toProBookings,
  toProJob,
  toProJobs,
  type ProJobRow,
} from './pro-booking.view';

const bookingRow = (overrides: Partial<Booking> = {}): Booking =>
  ({
    id: 'bk-1',
    bookingNumber: 'HMG-000812',
    customerId: 'cust-1',
    serviceId: 'svc-1',
    addressId: 'addr-1',
    status: 'arrived',
    proId: 'pro-1',
    startOtpCode: '481902',
    startOtpProviderRef: 'slide-legacy-ref',
    startOtpAttempts: 0,
    arrivedAt: new Date('2026-08-19T09:00:00.000Z'),
    ...overrides,
  }) as unknown as Booking;

const jobRow = (overrides: Partial<ProJobRow> = {}): ProJobRow => ({
  ...bookingRow(),
  service: { name: 'Deep clean — 2BHK', durationMinutes: 120 },
  address: {
    addressLine: 'Flat 402, Sunrise Apartments, Vijay Nagar',
    landmark: 'Opposite the water tank',
    pinLat: 22.7196,
    pinLng: 75.8577,
  },
  customer: { fullName: 'Asha Menon', ratingSum: 14, ratingCount: 3 },
  ...overrides,
});

describe('toProBooking', () => {
  /**
   * The reason the whole file exists. A Pro who can read the code out of their
   * own job payload can start a job the customer never consented to, and
   * `startedAt` — the only basis for commission — stops meaning anything.
   */
  it('strips the customer’s start code', () => {
    const view = toProBooking(bookingRow());

    expect(view).not.toHaveProperty('startOtpCode');
    expect(JSON.stringify(view)).not.toContain('481902');
  });

  it('strips the legacy provider reference', () => {
    expect(toProBooking(bookingRow())).not.toHaveProperty(
      'startOtpProviderRef',
    );
  });

  it('keeps the attempt counter, which the app has to show', () => {
    expect(toProBooking(bookingRow()).startOtpAttempts).toBe(0);
  });

  it('does not mutate the row it was handed', () => {
    const row = bookingRow();
    toProBooking(row);
    expect(row.startOtpCode).toBe('481902');
  });

  it('maps a list', () => {
    expect(
      toProBookings([bookingRow(), bookingRow({ id: 'bk-2' })]),
    ).toHaveLength(2);
  });
});

describe('toProJob', () => {
  it('resolves where to go, so the card is not a UUID', () => {
    const view = toProJob(jobRow());

    expect(view.address).toEqual({
      addressLine: 'Flat 402, Sunrise Apartments, Vijay Nagar',
      landmark: 'Opposite the water tank',
      pinLat: 22.7196,
      pinLng: 75.8577,
    });
    expect(view.service?.name).toBe('Deep clean — 2BHK');
    expect(view.customer?.fullName).toBe('Asha Menon');
  });

  it('still strips the start code', () => {
    expect(toProJob(jobRow())).not.toHaveProperty('startOtpCode');
  });

  /**
   * US-4.8: neither side sees the other's number. The booking chat is the
   * whole substitute, so a phone appearing here would quietly undo it — and
   * the select is the only place that can be got wrong.
   */
  it('carries no customer phone number, in the view or the include', () => {
    expect(toProJob(jobRow()).customer).not.toHaveProperty('phone');
    expect(PRO_JOB_INCLUDE.customer.select).not.toHaveProperty('phone');
  });

  it('tolerates the nullable relations Prisma types as optional', () => {
    const view = toProJob(
      jobRow({ address: null, customer: null, service: null }),
    );

    expect(view.address).toBeNull();
    expect(view.customer).toBeNull();
    expect(view.service).toBeNull();
  });

  it('maps a list', () => {
    expect(toProJobs([jobRow(), jobRow({ id: 'bk-2' })])).toHaveLength(2);
  });
});
