import { Inject, Logger, Module } from '@nestjs/common';
import { RedisModule } from '../../redis/redis.module';
import { BookingsModule } from '../bookings/bookings.module';
import {
  LOYALTY_PORT,
  NoOpLoyaltyService,
} from '../bookings/ports/loyalty.port';
import { IdentityModule } from '../identity/identity.module';
import { PaymentsModule } from '../payments/payments.module';
import {
  NoOpSubscriptionService,
  SUBSCRIPTION_PORT,
} from '../payments/ports/subscription.port';
import { AdminLoyaltyController } from './admin-loyalty.controller';
import { LoyaltyPortAdapter } from './loyalty-port.adapter';
import { LoyaltyWorkerService } from './loyalty-worker.service';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';
import { SubscriptionPortAdapter } from './subscription-port.adapter';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsService } from './subscriptions.service';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * Module 16 · Loyalty — Homingo Coins, subscription plans, and Refer & Earn.
 *
 * Owns `CustomerWallet`, `WalletTransaction`, `SubscriptionPlan`,
 * `CustomerSubscription`, `ReferralCode` and `Referral`.
 *
 * ## The one rule that shapes all three features
 *
 * **Nothing pays out for an intention; everything pays out for a completed
 * job.** Coins are earned on completion, not on booking. A referral rewards
 * when the referee's first job finishes, not when they sign up. A subscription
 * is worth nothing until its payment is confirmed. Each of those is the
 * cheapest available defence against the same attack — a signup, a booking and
 * a checkout intent all cost an attacker nothing, and a completed job costs
 * them a real payment at a real address a real Pro visited.
 *
 * ## How it attaches to the platform
 *
 * Through one port, `LOYALTY_PORT`, which **module 4 owns**. This module
 * imports `BookingsModule`; module 4 knows nothing about this one. That
 * direction is forced: the discount has to be computed before the booking row
 * is written, and module 16 reads module 4's `PlatformSettingsService` for its
 * own tunables — an import both ways would be a cycle Nest refuses to build.
 *
 * The port is bound to a no-op inside `BookingsModule`, so a deployment
 * without this module prices every booking at its flat price, earns nothing,
 * and cancels under the plain policy. That is exactly how the platform behaved
 * before module 16 existed, which is what makes this module removable.
 *
 * ## What it changed outside its own folder
 *
 * Five files, each a one-line consequence of `Booking` gaining a
 * `payableAmount` that differs from `flatPrice`. They are listed in
 * `docs/MODULE_16_LOYALTY_PLAN.md` §8, and every one of them is the same fix:
 * charge, collect and reconcile what the customer actually owes.
 */
@Module({
  imports: [
    IdentityModule,
    // For `PlatformSettingsService` — this module does not add a second reader
    // for the tunables module 4 already owns — and for the port delegate.
    BookingsModule,
    // For `OrdersService`, to open a Razorpay checkout for a plan, and for
    // module 7's `SUBSCRIPTION_PORT` delegate, which is how a captured payment
    // gets back here to activate it. No cycle: `PaymentsModule` imports
    // `BookingsModule` and knows nothing about this one.
    PaymentsModule,
    // The sweep's lock, so several app instances do not all expire the same
    // coins.
    RedisModule,
  ],
  controllers: [
    WalletController,
    SubscriptionsController,
    ReferralsController,
    AdminLoyaltyController,
  ],
  providers: [
    WalletService,
    SubscriptionsService,
    ReferralsService,
    LoyaltyPortAdapter,
    SubscriptionPortAdapter,
    LoyaltyWorkerService,
  ],
  exports: [WalletService, SubscriptionsService, ReferralsService],
})
export class LoyaltyModule {
  private readonly logger = new Logger(LoyaltyModule.name);

  constructor(
    @Inject(LOYALTY_PORT) bookings: NoOpLoyaltyService,
    adapter: LoyaltyPortAdapter,
    @Inject(SUBSCRIPTION_PORT) payments: NoOpSubscriptionService,
    subscriptionAdapter: SubscriptionPortAdapter,
  ) {
    /**
     * Both unconditional, like module 11's registration and unlike module 7's
     * gateway. There is no credential to be absent — a coin is a row.
     *
     * The second one is what makes online plan checkout work: module 7 can now
     * price a plan and activate it on capture without importing this module.
     * Whether a card can actually be charged still depends on Razorpay being
     * configured, which is module 7's own gate.
     */
    bookings.register(adapter);
    payments.register(subscriptionAdapter);

    this.logger.log(
      'Loyalty registered — Homingo Coins, subscriptions and referrals are live.',
    );
  }
}
