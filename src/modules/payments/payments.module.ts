import { Inject, Logger, Module, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  buildRazorpayOptions,
  type RazorpayOptions,
} from '../../config/razorpay.config';
import { RedisModule } from '../../redis/redis.module';
import { BookingsModule } from '../bookings/bookings.module';
import {
  NoOpPaymentsService,
  PAYMENTS_PORT,
} from '../bookings/ports/payments.port';
import { IdentityModule } from '../identity/identity.module';
import { AdminPaymentsController } from './admin-payments.controller';
import { CashCollectionService } from './cash-collection.service';
import { CashEligibilityService } from './cash-eligibility.service';
import { CashHandoverService } from './cash-handover.service';
import { OrdersService } from './orders.service';
import { PaymentWebhookService } from './payment-webhook.service';
import { PaymentsController } from './payments.controller';
import { PaymentsWebhookController } from './payments-webhook.controller';
import {
  COMMISSION_REVERSAL_PORT,
  NoOpCommissionReversalService,
} from './ports/commission-reversal.port';
import { LEDGER_PORT, NoOpLedgerService } from './ports/ledger.port';
import { NoOpSupportService, SUPPORT_PORT } from './ports/support.port';
import { ProPaymentsController } from './pro-payments.controller';
import { RAZORPAY_OPTIONS, RazorpayClient } from './razorpay.client';
import { RealPaymentsAdapter } from './real-payments.adapter';
import { ReconciliationService } from './reconciliation.service';
import { RefundsService } from './refunds.service';

/**
 * Module 7 · Payments — two modes, and only one of them has a gateway.
 *
 * Owns `Order` and `CashHandover`, plus the cash columns on `Booking` and
 * `Pro.cashInHand`.
 *
 * **Registers itself into module 4's payments delegate at boot** (see the
 * constructor), exactly as module 5 does for dispatch. Nest resolves providers
 * per module, so re-binding `PAYMENTS_PORT` here would not reach
 * `BookingsService`; making `BookingsModule` import this one would invert the
 * dependency the port exists to prevent.
 *
 * Two dependencies do not exist yet and are consumed through ports this module
 * owns:
 *
 * - {@link LEDGER_PORT} → module 9. Double-entry rows, including the
 *   `cash_in_hand:<proId>` account.
 * - {@link SUPPORT_PORT} → module 11. The billing ticket for an unpaid job.
 * - {@link COMMISSION_REVERSAL_PORT} → module 8. A fully refunded job has to
 *   unwind the Pro's pay. Named for the reversal rather than for commission so
 *   it cannot be confused with module 4's `COMMISSION_PORT` at an inject site.
 *
 * Both no-ops fail **quietly**, unlike module 4's payments stub. That stub was
 * right to throw — a booking with a phantom order is unrecoverable. Here the
 * money has already moved, and refusing to record it would be the worse
 * outcome.
 *
 * **Without Razorpay credentials this module still loads**, registers nothing,
 * and leaves online bookings returning module 4's honest 501. Cash runs end to
 * end regardless, which is what lets a developer with no gateway keys work on
 * the whole product.
 */
@Module({
  imports: [IdentityModule, BookingsModule, RedisModule],
  controllers: [
    PaymentsController,
    PaymentsWebhookController,
    ProPaymentsController,
    AdminPaymentsController,
  ],
  providers: [
    {
      provide: RAZORPAY_OPTIONS,
      inject: [ConfigService],
      useFactory: (config: ConfigService): RazorpayOptions | undefined =>
        buildRazorpayOptions({
          NODE_ENV: config.get<string>('NODE_ENV'),
          RAZORPAY_KEY_ID: config.get<string>('RAZORPAY_KEY_ID'),
          RAZORPAY_KEY_SECRET: config.get<string>('RAZORPAY_KEY_SECRET'),
          RAZORPAY_WEBHOOK_SECRET: config.get<string>(
            'RAZORPAY_WEBHOOK_SECRET',
          ),
          RAZORPAY_BASE_URL: config.get<string>('RAZORPAY_BASE_URL'),
        }),
    },
    RazorpayClient,
    OrdersService,
    RefundsService,
    PaymentWebhookService,
    CashCollectionService,
    CashHandoverService,
    CashEligibilityService,
    ReconciliationService,
    RealPaymentsAdapter,
    { provide: LEDGER_PORT, useClass: NoOpLedgerService },
    { provide: SUPPORT_PORT, useClass: NoOpSupportService },
    {
      provide: COMMISSION_REVERSAL_PORT,
      useClass: NoOpCommissionReversalService,
    },
  ],
  // Module 5 reads the ceiling to keep cash work away from a Pro who is over
  // it. Module 8 registers its reverser into the delegate below, so the symbol
  // has to leave this module too.
  // Module 8 registers its reverser into COMMISSION_REVERSAL_PORT; module 9
  // registers the real ledger into LEDGER_PORT and reuses the reconciliation
  // engine rather than writing a second one.
  exports: [
    CashEligibilityService,
    ReconciliationService,
    COMMISSION_REVERSAL_PORT,
    LEDGER_PORT,
    // Module 11 registers the real ticket system into this delegate at boot.
    SUPPORT_PORT,
  ],
})
export class PaymentsModule {
  private readonly logger = new Logger(PaymentsModule.name);

  /**
   * Registers the real gateway into module 4's delegate the moment this module
   * is constructed — but **only when it is actually configured**.
   *
   * Presence of `PaymentsModule` in `AppModule` is therefore not the switch;
   * presence of credentials is. That distinction is what keeps a keyless
   * developer machine honest: online booking fails with "payments are not
   * available", which is true, rather than failing later at the gateway with
   * something that reads like an outage.
   */
  constructor(
    @Inject(PAYMENTS_PORT) delegate: NoOpPaymentsService,
    adapter: RealPaymentsAdapter,
    @Optional()
    @Inject(RAZORPAY_OPTIONS)
    options?: RazorpayOptions,
  ) {
    if (!options) {
      this.logger.warn(
        'Razorpay is not configured — online payments stay unavailable and ' +
          'cash bookings are unaffected. Set RAZORPAY_KEY_ID, ' +
          'RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET to enable them.',
      );
      return;
    }

    delegate.register(adapter);
  }
}
