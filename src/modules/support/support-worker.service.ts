import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import {
  NoStartDetectorService,
  type NoStartSweepResult,
} from './no-start-detector.service';

const WORKER_LOCK = 'jobs:support:sweep';

/**
 * The one unattended pass this module needs.
 *
 * **No new dependency.** `@nestjs/schedule` is still not in this codebase, and
 * `CommissionWorkerService` and `ProCountersService` already establish the
 * pattern: a self-rescheduling `setTimeout`, `unref`'d so it cannot hold the
 * process open, behind a Redis lock so several app instances do not all run
 * the same sweep.
 *
 * **Two minutes, not fifteen.** The commission sweeper runs quarter-hourly
 * because the hold window it watches is measured in hours. This one watches a
 * window whose configured floor is one minute — running every fifteen would
 * make a one-minute grace window mean sixteen.
 *
 * The pass is also an admin endpoint, per the house rule: a background job
 * nobody can trigger is a background job nobody can test.
 */
@Injectable()
export class SupportWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SupportWorkerService.name);
  private timer?: NodeJS.Timeout;

  private static readonly INTERVAL_MS = 2 * 60 * 1000;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly noStart: NoStartDetectorService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('SUPPORT_WORKER_ENABLED') === 'false') {
      this.logger.warn(
        'Support worker disabled. No-start incidents will not be detected — ' +
          'trigger the sweep from POST /admin/support/sweep.',
      );
      return;
    }
    this.schedule();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async runOnce(): Promise<NoStartSweepResult> {
    const locked = await this.redis.setIfAbsent(WORKER_LOCK, '1', 300);
    if (!locked) return { scanned: 0, raised: 0, autoResolved: 0 };

    try {
      return await this.noStart.sweep();
    } finally {
      await this.redis.del(WORKER_LOCK);
    }
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.runOnce()
        .catch((error: unknown) =>
          this.logger.error(
            `Support sweep failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          ),
        )
        .finally(() => this.schedule());
    }, SupportWorkerService.INTERVAL_MS);
    this.timer.unref();
  }
}
