import { DispatchService } from './dispatch.service';
import { DispatchWorkerService } from './dispatch-worker.service';

describe('DispatchWorkerService', () => {
  it('drains queued automatic assignments', async () => {
    const drain = jest.fn().mockResolvedValue([
      {
        bookingId: 'bk-1',
        outcome: 'assigned',
        attemptNumber: 1,
        assignedProId: 'pro-1',
        candidatesEvaluated: 1,
      },
    ]);
    const dispatch = {
      drain,
    } as unknown as DispatchService;
    const worker = new DispatchWorkerService(dispatch);

    await worker.runOnce();

    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('starts polling on module initialization and stops cleanly', async () => {
    jest.useFakeTimers();
    const drain = jest.fn().mockResolvedValue([]);
    const dispatch = {
      drain,
    } as unknown as DispatchService;
    const worker = new DispatchWorkerService(dispatch);

    worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(1);

    worker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(drain).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
