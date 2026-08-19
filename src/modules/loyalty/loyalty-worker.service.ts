import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../../redis/redis.service';
import { ReferralsService } from './referrals.service';
import { SubscriptionsService } from './subscriptions.service';
import { WalletService } from './wallet.service';

const WORKER_LOCK = 'jobs:loyalty:sweep';

export interface LoyaltySweepResult {
  coinCreditsExpired: number;
  coinsExpired: number;
  subscriptionsExpired: number;
  referralsPaid: number;
  referralsExpired: number;
}

/**
 * Module 16's one unattended pass.
 *
 * **No new dependency.** `@nestjs/schedule` is still not in this codebase;
 * `CommissionWorkerService`, `LedgerWorkerService` and `SupportWorkerService`
 * all establish the pattern this copies — a self-rescheduling `setTimeout`,
 * `unref`'d so it cannot hold the process open, behind a Redis lock so several
 * app instances do not all run the same sweep.
 *
 * **Hourly, not every two minutes.** Support's sweep watches a window measured
 * in minutes; everything here is measured in days. A coin that lapses at
 * midnight and is written down at 00:47 has cost nobody anything, and polling
 * four hundred times as often to shorten that would be work for its own sake.
 *
 * The pass is also an admin endpoint, per the house rule: a background job
 * nobody can trigger is a background job nobody can test.
 */
@Injectable()
export class LoyaltyWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LoyaltyWorkerService.name);
  private timer?: NodeJS.Timeout;

  private static readonly INTERVAL_MS = 60 * 60 * 1000;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly wallet: WalletService,
    private readonly subscriptions: SubscriptionsService,
    private readonly referrals: ReferralsService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('LOYALTY_WORKER_ENABLED') === 'false') {
      this.logger.warn(
        'Loyalty worker disabled. Coins and subscriptions will not lapse and ' +
          'stuck referrals will not retry — trigger the sweep from ' +
          'POST /admin/loyalty/sweep.',
      );
      return;
    }
    this.schedule();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * All four passes, in an order chosen so each sees the others' results:
   * subscriptions lapse before referrals are retried (a referral credit reads
   * no subscription state, but the reverse ordering would leave a just-expired
   * plan multiplying a coin credit for an hour), and coins expire last so a
   * credit paid earlier in this same run gets its full life.
   *
   * Each pass is independently failure-tolerant: one throwing must not stop
   * the others, because they are unrelated and all of them are owed.
   */
  async runOnce(): Promise<LoyaltySweepResult> {
    const empty: LoyaltySweepResult = {
      coinCreditsExpired: 0,
      coinsExpired: 0,
      subscriptionsExpired: 0,
      referralsPaid: 0,
      referralsExpired: 0,
    };

    const locked = await this.redis.setIfAbsent(WORKER_LOCK, '1', 600);
    if (!locked) return empty;

    try {
      const result = { ...empty };

      try {
        const subscriptions = await this.subscriptions.expireLapsed();
        result.subscriptionsExpired = subscriptions.expired;
      } catch (error) {
        this.log('subscription expiry', error);
      }

      try {
        const referrals = await this.referrals.sweep();
        result.referralsPaid = referrals.paid;
        result.referralsExpired = referrals.expired;
      } catch (error) {
        this.log('referral sweep', error);
      }

      try {
        const coins = await this.wallet.expireLapsedCoins();
        result.coinCreditsExpired = coins.expired;
        result.coinsExpired = coins.coins;
      } catch (error) {
        this.log('coin expiry', error);
      }

      return result;
    } finally {
      await this.redis.del(WORKER_LOCK);
    }
  }

  private log(pass: string, error: unknown): void {
    this.logger.error(
      `Loyalty ${pass} failed; the next sweep will retry.`,
      error instanceof Error ? error.stack : String(error),
    );
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      void this.runOnce()
        .catch((error: unknown) =>
          this.logger.error(
            `Loyalty sweep failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          ),
        )
        .finally(() => this.schedule());
    }, LoyaltyWorkerService.INTERVAL_MS);
    this.timer.unref();
  }
}
