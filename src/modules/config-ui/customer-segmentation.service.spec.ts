import { CustomerSegmentationService } from './customer-segmentation.service';

describe('CustomerSegmentationService', () => {
  const settings = {
    getNumber: jest.fn((key: string) =>
      Promise.resolve(key.endsWith('ActiveDays') ? 30 : 90),
    ),
  };

  it('classifies guests as anonymous', async () => {
    const prisma = {
      customer: {
        findUnique: jest.fn().mockResolvedValue({
          createdAt: new Date('2026-01-01'),
          status: 'guest',
          bookings: [],
        }),
      },
    };
    await expect(
      new CustomerSegmentationService(
        prisma as never,
        settings as never,
      ).segmentFor('guest', undefined, new Date('2026-02-01')),
    ).resolves.toBe('anonymous');
  });

  it('classifies recent repeat customers from completed bookings', async () => {
    const prisma = {
      customer: {
        findUnique: jest.fn().mockResolvedValue({
          createdAt: new Date('2025-01-01'),
          status: 'verified',
          bookings: [
            { completedAt: new Date('2026-01-01') },
            { completedAt: new Date('2026-01-20') },
          ],
        }),
      },
    };
    await expect(
      new CustomerSegmentationService(
        prisma as never,
        settings as never,
      ).segmentFor('customer-1', 'city-1', new Date('2026-02-01')),
    ).resolves.toBe('repeat');
  });
});
