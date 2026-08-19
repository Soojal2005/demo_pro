import { Module } from '@nestjs/common';
import { RedisModule } from '../../redis/redis.module';
import { S3Module } from '../../storage/s3.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CustomersModule } from '../customers/customers.module';
import { IdentityModule } from '../identity/identity.module';
import { ProsModule } from '../pros/pros.module';
import { AdminBookingsController } from './admin-bookings.controller';
import { BookingCancellationService } from './booking-cancellation.service';
import { BookingRescheduleService } from './booking-reschedule.service';
import { BookingEtaService } from './booking-eta.service';
import { BookingChatService } from './booking-chat.service';
import { BookingLifecycleService } from './booking-lifecycle.service';
import { BookingStateService } from './booking-state.service';
import { BookingTrackingService } from './booking-tracking.service';
import { TrackingBroadcasterService } from './tracking-broadcaster.service';
import { TrackingGateway } from './tracking.gateway';
import { BookingsController } from './bookings.controller';
import { BookingsService } from './bookings.service';
import { PlatformSettingsService } from './platform-settings.service';
import { ProBookingsController } from './pro-bookings.controller';
import {
  COMMISSION_PORT,
  NoOpCommissionService,
} from './ports/commission.port';
import { DISPATCH_PORT, NoOpDispatchService } from './ports/dispatch.port';
import { LOYALTY_PORT, NoOpLoyaltyService } from './ports/loyalty.port';
import { NoOpPaymentsService, PAYMENTS_PORT } from './ports/payments.port';
import {
  NoOpServiceabilityService,
  SERVICEABILITY_PORT,
} from './ports/serviceability.port';
import { RecurringPlansService } from './recurring-plans.service';

/**
 * Module 4 · Booking & Job Lifecycle — the spine.
 *
 * Owns `Booking`, `RecurringPlan`, `BookingStatusEvent`, `ChatMessage` and
 * `JobPhotoProof`.
 *
 * Two of its dependencies do not exist yet, so they are consumed through ports
 * this module owns rather than blocking on them:
 *
 * - {@link DISPATCH_PORT} → module 5. Bound to a no-op that leaves bookings in
 *   `assigning`; ops assigns by hand until the engine exists.
 * - {@link PAYMENTS_PORT} → module 7. Bound to a no-op that refuses online
 *   orders outright. **Cash bookings need neither**, which is why the whole
 *   lifecycle runs end to end today.
 * - {@link COMMISSION_PORT} → module 8. Bound to a no-op that logs. A job still
 *   completes without it; nobody gets paid for it, which the log says out loud.
 * - {@link LOYALTY_PORT} → module 16. Bound to a no-op that prices every
 *   booking at its flat price and earns nothing. The one port whose absence is
 *   *invisible* to the customer rather than merely survivable: they pay the
 *   advertised amount, which is never wrong, only ungenerous.
 *
 * Swapping in the real modules later means changing these two `provide`
 * lines and nothing else.
 */
@Module({
  imports: [
    IdentityModule,
    CatalogModule,
    CustomersModule,
    ProsModule,
    S3Module,
    // Live tracking reads the Pro GEO index module 6 writes to; nothing about
    // a live position is ever stored on the booking.
    RedisModule,
  ],
  controllers: [
    BookingsController,
    ProBookingsController,
    AdminBookingsController,
  ],
  providers: [
    BookingsService,
    BookingStateService,
    BookingEtaService,
    BookingLifecycleService,
    BookingCancellationService,
    BookingRescheduleService,
    BookingChatService,
    BookingTrackingService,
    TrackingGateway,
    TrackingBroadcasterService,
    RecurringPlansService,
    PlatformSettingsService,
    { provide: DISPATCH_PORT, useClass: NoOpDispatchService },
    { provide: PAYMENTS_PORT, useClass: NoOpPaymentsService },
    { provide: SERVICEABILITY_PORT, useClass: NoOpServiceabilityService },
    { provide: COMMISSION_PORT, useClass: NoOpCommissionService },
    { provide: LOYALTY_PORT, useClass: NoOpLoyaltyService },
  ],
  // PlatformSettingsService and the two ports are exported so modules 5 and 7
  // can read tunables and register their real implementations into the
  // delegates. Module 7 also needs DISPATCH_PORT: a captured payment is what
  // sends an online booking to dispatch, and it must go through the same door
  // module 4 uses rather than a second one.
  exports: [
    BookingsService,
    BookingStateService,
    PlatformSettingsService,
    DISPATCH_PORT,
    PAYMENTS_PORT,
    SERVICEABILITY_PORT,
    COMMISSION_PORT,
    LOYALTY_PORT,
  ],
})
export class BookingsModule {}
