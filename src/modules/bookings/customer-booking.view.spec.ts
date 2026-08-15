import {
  type CustomerBookingDetailRow,
  type CustomerBookingRow,
  toCustomerBooking,
  toCustomerBookingDetail,
} from './customer-booking.view';

/** A Prisma Decimal, as far as the mapper is concerned. */
const decimal = (value: string) => ({ toString: () => value });

function row(overrides: Partial<CustomerBookingRow> = {}): CustomerBookingRow {
  return {
    id: 'bk-1',
    bookingNumber: 'HB-2026-000123',
    status: 'assigning',
    serviceId: 'svc-1',
    bookingType: 'instant',
    paymentStatus: 'unpaid',
    flatPrice: decimal('599.00'),
    slotStartAt: new Date('2026-08-15T09:30:00.000Z'),
    slotEndAt: new Date('2026-08-15T11:00:00.000Z'),
    createdAt: new Date('2026-08-15T09:00:00.000Z'),
    completedAt: null,
    cancelledAt: null,
    cancelledByType: null,
    cancellationFeeAmount: null,
    refundedAmount: null,
    invoiceNumber: null,
    taxAmount: null,
    startOtpCode: null,
    service: { name: 'Deep Home Cleaning', durationMinutes: 90 },
    address: { addressLine: '12 Vijay Nagar, Indore' },
    pro: null,
    reviews: [],
    ...overrides,
  };
}

describe('toCustomerBooking', () => {
  /*
   * The whole reason this mapper exists. The client reads `reference`,
   * `title`, `address` and `price`; the table has `bookingNumber`, a
   * `serviceId`, an `addressId` and a decimal string. Returning the row
   * unmapped left every card on the bookings tab blank.
   */
  it('resolves the joins the client draws a card from', () => {
    const view = toCustomerBooking(row());

    expect(view.reference).toBe('HB-2026-000123');
    expect(view.title).toBe('Deep Home Cleaning');
    expect(view.address).toBe('12 Vijay Nagar, Indore');
    expect(view.price).toBe(599);
    expect(view.durationMinutes).toBe(90);
  });

  it('sends timestamps as ISO strings, and absent ones as null', () => {
    const view = toCustomerBooking(row());

    expect(view.slotStartAt).toBe('2026-08-15T09:30:00.000Z');
    expect(view.createdAt).toBe('2026-08-15T09:00:00.000Z');
    expect(view.completedAt).toBeNull();
    expect(view.cancelledAt).toBeNull();
  });

  /* A booking nobody is assigned to yet must not carry a professional block —
     the client draws a card for whoever is in it. */
  it('has no professional until one is assigned', () => {
    expect(toCustomerBooking(row()).professional).toBeNull();
  });

  it('averages the assigned professional rating, and reports none as null', () => {
    const rated = toCustomerBooking(
      row({ pro: { fullName: 'Asha', ratingSum: 47, ratingCount: 10 } }),
    );
    expect(rated.professional).toEqual({ name: 'Asha', rating: 4.7 });

    const unrated = toCustomerBooking(
      row({ pro: { fullName: 'New Pro', ratingSum: 0, ratingCount: 0 } }),
    );
    expect(unrated.professional).toEqual({ name: 'New Pro', rating: null });
  });

  it('returns the customer own review, with its JSON columns as arrays', () => {
    const view = toCustomerBooking(
      row({
        reviews: [
          {
            rating: 5,
            comment: 'On time',
            tags: ['punctual', 'tidy'],
            photoUrls: [],
          },
        ],
      }),
    );

    expect(view.review).toEqual({
      rating: 5,
      comment: 'On time',
      tags: ['punctual', 'tidy'],
      photoUrls: [],
    });
  });

  /* `tags` and `photoUrls` are Json columns, so anything could be in them.
     A malformed row must not put a non-string into a list the client maps. */
  it('drops anything that is not a string out of the JSON lists', () => {
    const view = toCustomerBooking(
      row({
        reviews: [
          {
            rating: 4,
            comment: null,
            tags: 'not-an-array',
            photoUrls: [1, 'ok'],
          },
        ],
      }),
    );

    expect(view.review?.tags).toEqual([]);
    expect(view.review?.photoUrls).toEqual(['ok']);
  });

  /*
   * The arrival panel in the app switches on the presence of this field, so
   * when it is sent matters as much as what it holds.
   */
  describe('the start code', () => {
    it('is sent while the professional is at the door', () => {
      const view = toCustomerBooking(
        row({ status: 'arrived', startOtpCode: '481920' }),
      );
      expect(view.startOtp).toBe('481920');
    });

    it('is withheld before anyone has arrived', () => {
      const view = toCustomerBooking(
        row({ status: 'en_route', startOtpCode: '481920' }),
      );
      expect(view.startOtp).toBeNull();
    });

    /* Verifying it nulls the column; this gate means even a row that somehow
       kept one cannot hand it back after the job is under way. */
    it('is withheld once the job has started', () => {
      const view = toCustomerBooking(
        row({ status: 'started', startOtpCode: '481920' }),
      );
      expect(view.startOtp).toBeNull();
    });

    it('is null when none has been issued', () => {
      expect(toCustomerBooking(row({ status: 'arrived' })).startOtp).toBeNull();
    });
  });

  it('falls back to the sold slot length when the service is missing', () => {
    const view = toCustomerBooking(row({ service: null }));
    expect(view.durationMinutes).toBe(90);
  });

  it('reads money as numbers, including a cancellation fee and refund', () => {
    const view = toCustomerBooking(
      row({
        cancellationFeeAmount: decimal('50.00'),
        refundedAmount: decimal('549.00'),
        taxAmount: decimal('0.00'),
      }),
    );

    expect(view.cancellationFeeAmount).toBe(50);
    expect(view.refundedAmount).toBe(549);
    expect(view.taxAmount).toBe(0);
  });
});

describe('toCustomerBookingDetail', () => {
  it('renames the trail into what the detail screen reads', () => {
    const detail: CustomerBookingDetailRow = {
      ...row(),
      statusEvents: [
        {
          status: 'created',
          actorType: 'customer',
          occurredAt: new Date('2026-08-15T09:00:00.000Z'),
        },
        {
          status: 'assigning',
          actorType: 'system',
          occurredAt: new Date('2026-08-15T09:00:05.000Z'),
        },
      ],
    };

    expect(toCustomerBookingDetail(detail).timeline).toEqual([
      { status: 'created', by: 'customer', at: '2026-08-15T09:00:00.000Z' },
      { status: 'assigning', by: 'system', at: '2026-08-15T09:00:05.000Z' },
    ]);
  });

  /*
   * Idempotency keys are filed as rows in the same append-only trail. Rendered
   * verbatim the customer was shown a step called "idempotency:HOM-…-0" —
   * caught by driving a real booking through the API rather than by a unit
   * test, which is why there is now one.
   */
  it('keeps idempotency bookkeeping out of the customer trail', () => {
    const detail: CustomerBookingDetailRow = {
      ...row(),
      statusEvents: [
        {
          status: 'created',
          actorType: 'customer',
          occurredAt: new Date('2026-08-15T09:00:00.000Z'),
        },
        {
          status: 'idempotency:HOM12846-0',
          actorType: 'customer',
          occurredAt: new Date('2026-08-15T09:00:01.000Z'),
        },
      ],
    };

    expect(toCustomerBookingDetail(detail).timeline).toEqual([
      { status: 'created', by: 'customer', at: '2026-08-15T09:00:00.000Z' },
    ]);
  });
});
