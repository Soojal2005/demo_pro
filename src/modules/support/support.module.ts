import { Inject, Logger, Module } from '@nestjs/common';
import { RedisModule } from '../../redis/redis.module';
import { BookingsModule } from '../bookings/bookings.module';
import { IdentityModule } from '../identity/identity.module';
import {
  NoOpSupportService,
  SUPPORT_PORT,
} from '../payments/ports/support.port';
import { PaymentsModule } from '../payments/payments.module';
import { AdminSosController } from './admin-sos.controller';
import { AdminSupportController } from './admin-support.controller';
import { CustomerSupportController } from './customer-support.controller';
import { DisputeEvidenceService } from './dispute-evidence.service';
import { NoStartDetectorService } from './no-start-detector.service';
import { ProSupportController } from './pro-support.controller';
import { SosService } from './sos.service';
import { SupportPortAdapter } from './support-port.adapter';
import { SupportTicketsService } from './support-tickets.service';
import { SupportWorkerService } from './support-worker.service';

/**
 * Module 11 · Safety & Support.
 *
 * ## What this module unblocked
 *
 * Four modules had already written their half against a stub:
 *
 * - Module 7's `SUPPORT_PORT` logged a warning and returned. An unpaid cash
 *   job now raises a real billing ticket.
 * - `no_start.graceWindowMinutes` had been defined and validated in module
 *   15's settings and read by **no code at all**. US-4.14 sat at 🟡 with the
 *   note "the grace window is configured, nothing watches it". Now something
 *   does.
 * - Module 15's Customer/Pro 360 returned `support: { available: false }`.
 * - Module 4's `reconstruct()` was built for US-4.24 and had no dispute
 *   screen to serve.
 *
 * ## Imports
 *
 * `BookingsModule` for `BookingsService.reconstruct()` and the read-only
 * `PlatformSettingsService` — the grace window is a tunable, and this module
 * does not add a second reader for it. `PaymentsModule` for the port delegate.
 * `RedisModule` for the sweep's lock. `NotificationsModule` is `@Global()`, so
 * there is nothing to import for it.
 */
@Module({
  imports: [IdentityModule, BookingsModule, PaymentsModule, RedisModule],
  controllers: [
    CustomerSupportController,
    ProSupportController,
    AdminSosController,
    AdminSupportController,
  ],
  providers: [
    SosService,
    SupportTicketsService,
    NoStartDetectorService,
    SupportWorkerService,
    DisputeEvidenceService,
    SupportPortAdapter,
  ],
  exports: [SupportTicketsService, SosService],
})
export class SupportModule {
  private readonly logger = new Logger(SupportModule.name);

  constructor(
    @Inject(SUPPORT_PORT) payments: NoOpSupportService,
    adapter: SupportPortAdapter,
  ) {
    /**
     * Unconditional, like the ledger's registration and unlike module 7's
     * gateway. There is no credential to be absent — a ticket is a row.
     */
    payments.register(adapter);

    this.logger.log(
      'Safety & Support registered — SOS, tickets, and no-start detection are live.',
    );
  }
}
