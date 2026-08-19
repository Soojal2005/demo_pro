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
            // Undiscounted, so the two bases coincide and this test stays
            // about refunds, commission and incentives.
            payableAmount: '1000.00',
            discountAmount: '0.00',
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
      discountGiven: '0.00',
      netRevenue: '1000.00',
      netPlatformRevenue: '250.00',
    });
  });

  it('does not count a discount as platform revenue', async () => {
    /*
     * The bug this guards against survives a merge untouched: computing the
     * platform's share from `flatPrice` charges commission against ₹1,000 the
     * platform never received, and reports a margin ₹200 better than reality
     * on every discounted booking.
     *
     * GMV stays gross on purpose — it is the catalogue value of what was sold,
     * and keeping it comparable across months is the whole point of the
     * acronym. `discountGiven` is the bridge, so the gap between the two is a
     * reported figure rather than something finance has to chase.
     */
    const prisma = {
      booking: {
        findMany: jest.fn().mockResolvedValue([
          {
            status: 'completed',
            flatPrice: '1000.00',
            payableAmount: '800.00',
            discountAmount: '200.00',
            refundedAmount: null,
            customerId: 'customer-1',
            assignmentOutcome: 'assigned',
            assignedAt: new Date('2026-01-01T00:00:10.000Z'),
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            commission: {
              commissionAmount: '600.00',
              incentiveAmount: '0.00',
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
      discountGiven: '200.00',
      netRevenue: '800.00',
      // 800 charged − 600 commission. Reading flatPrice would say 400.
      netPlatformRevenue: '200.00',
    });
  });
});
