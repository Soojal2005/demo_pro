import { AdminJobsService } from './admin-jobs.service';

describe('AdminJobsService worker resilience', () => {
  it('contains a transient database failure instead of rejecting the timer tick', async () => {
    const prisma = {
      adminJob: {
        findFirst: jest
          .fn()
          .mockRejectedValue(new Error('Connection terminated unexpectedly')),
      },
    };
    const service = new AdminJobsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      (service as unknown as { tick(): Promise<void> }).tick(),
    ).resolves.toBeUndefined();
  });
});
