import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DispatchService } from './dispatch.service';

/**
 * Continuously consumes the Redis dispatch queue.
 *
 * Booking creation deliberately only enqueues work so the customer request is
 * not held open while candidates are scored. That queue still needs an
 * in-process consumer, however; without one, assignments only happen when an
 * admin manually calls the drain endpoint.
 *
 * Several application instances may run this worker safely. Redis LPOP gives
 * one instance each queued item and DispatchService's per-booking lock guards
 * duplicate entries.
 */
@Injectable()
export class DispatchWorkerService implements OnModuleInit, OnModuleDestroy {
  private static readonly POLL_INTERVAL_MS = 1_000;

  private readonly logger = new Logger(DispatchWorkerService.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly dispatch: DispatchService) {}

  onModuleInit(): void {
    this.stopped = false;
    this.schedule(0);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Public so the unattended path can be tested without waiting on a timer. */
  async runOnce(): Promise<void> {
    const results = await this.dispatch.drain();
    if (results.length > 0) {
      this.logger.log(`Processed ${results.length} queued booking(s).`);
    }
  }

  private schedule(delayMs = DispatchWorkerService.POLL_INTERVAL_MS): void {
    if (this.stopped) return;

    this.timer = setTimeout(() => {
      void this.runOnce()
        .catch((error: unknown) =>
          this.logger.error(
            `Dispatch queue pass failed: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          ),
        )
        .finally(() => this.schedule());
    }, delayMs);
    this.timer.unref();
  }
}
