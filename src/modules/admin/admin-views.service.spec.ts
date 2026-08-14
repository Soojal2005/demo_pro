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
    };
    const service = new AdminViewsService(prisma as never, {} as never);

    await service.customer360('customer-1', ['city-1']);

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
