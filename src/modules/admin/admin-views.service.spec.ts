import { AdminViewsService } from './admin-views.service';

describe('AdminViewsService', () => {
  it('filters every customer 360 collection to the requesting admin city scope', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      id: 'customer-1',
      addresses: [],
      bookings: [],
      orders: [],
      reviews: [],
    });
    const prisma = {
      customerAddress: { count: jest.fn().mockResolvedValue(1) },
      customer: { findUnique },
      // Module 11's tables. The 360's support section is counts-only — a
      // triage screen loads numbers, and an admin who needs the thread opens
      // the ticket.
      supportTicket: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      sosAlert: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = new AdminViewsService(prisma as never, {} as never);

    const result = await service.customer360('customer-1', ['city-1']);

    // The stub this replaced returned `available: false` with a "module 11 is
    // not implemented yet" reason.
    expect(result.support).toMatchObject({ available: true, openTickets: 0 });

    const include = findUnique.mock.calls[0][0].include;
    expect(include.addresses.where).toEqual({ cityId: { in: ['city-1'] } });
    expect(include.bookings.where).toEqual({
      address: { cityId: { in: ['city-1'] } },
    });
    expect(include.orders.where).toEqual({
      booking: { address: { cityId: { in: ['city-1'] } } },
    });
    expect(include.reviews.where).toEqual({
      booking: { address: { cityId: { in: ['city-1'] } } },
    });
  });
});
