import { AdminAnalyticsService } from './admin-analytics.service';

describe('AdminAnalyticsService', () => {
  it('does not count immature retention cohorts in a rate denominator', async () => {
    const prisma = {
      booking: {
        findMany: jest.fn().mockResolvedValue([
          {
            customerId: 'mature-repeat',
            completedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
          {
            customerId: 'mature-repeat',
            completedAt: new Date('2026-01-20T00:00:00.000Z'),
          },
          {
            customerId: 'immature',
            completedAt: new Date('2026-04-25T00:00:00.000Z'),
          },
        ]),
      },
    };

    const result = await new AdminAnalyticsService(prisma as never).retention({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-05-01T00:00:00.000Z',
    });

    expect(result).toEqual(
      expect.objectContaining({ customers: 2, eligible30: 1, days30: 1 }),
    );
    expect(result.rates.days30).toBe(1);
  });

  it('reports GMV separately from platform revenue after refunds, Pro commission and incentives', async () => {
    const prisma = {
      booking: {
        findMany: jest.fn().mockResolvedValue([
          {
            status: 'completed',
            flatPrice: '1000.00',
            refundedAmount: '100.00',
            customerId: 'customer-1',
            assignmentOutcome: 'assigned',
            assignedAt: new Date('2026-01-01T00:00:10.000Z'),
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            commission: {
              commissionAmount: '600.00',
              incentiveAmount: '50.00',
            },
          },
        ]),
      },
    };

    const result = await new AdminAnalyticsService(prisma as never).overview({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });

    expect(result.money).toEqual({
      currency: 'INR',
      gmv: '1000.00',
      netPlatformRevenue: '250.00',
    });
  });
});
