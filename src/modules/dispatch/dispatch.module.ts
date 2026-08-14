import { Inject, Module } from '@nestjs/common';
import { RedisModule } from '../../redis/redis.module';
import { BookingsModule } from '../bookings/bookings.module';
import {
  DISPATCH_PORT,
  NoOpDispatchService,
} from '../bookings/ports/dispatch.port';
import { GeoModule } from '../geo/geo.module';
import { IdentityModule } from '../identity/identity.module';
import { PaymentsModule } from '../payments/payments.module';
import { ProsModule } from '../pros/pros.module';
import { AdminDispatchController } from './admin-dispatch.controller';
import { DispatchScoringService } from './dispatch-scoring.service';
import { DispatchService } from './dispatch.service';
import { DispatchWorkerService } from './dispatch-worker.service';
import { ProDispatchController } from './pro-dispatch.controller';
import { RealDispatchAdapter } from './real-dispatch.adapter';
import {
  RoutedTravelTimeService,
  TRAVEL_TIME_PORT,
} from './ports/travel-time.port';

/**
 * Module 5 · Dispatch Engine — matching bookings to Pros.
 *
 * Owns only `AssignmentCandidate`. The assignment itself is written onto
 * `Booking`, which is the v10 decision that removed the `Assignment` table.
 *
 * **This module registers the real engine into module 4's port delegate** at
 * boot (see the constructor). Nest resolves providers per module, so simply
 * re-binding `DISPATCH_PORT` here would not reach `BookingsService`; the
 * delegate is what makes the swap work without module 4 ever importing
 * module 5.
 *
 * Travel time is still a port: Geo & Routing (module 13) does not exist, and
 * the haversine stand-in is good enough to *rank* candidates but not to quote
 * an ETA, which is why module 4's tracking view still returns a null ETA.
 */
@Module({
  // Two imports, each for exactly one filter on the candidate pool:
  //   PaymentsModule → the cash ceiling (module 7, feature 16)
  //   GeoModule      → which Pros are posted to the booking's area (module 13)
  // Both are filters. Neither touches the ranking, which is still distance,
  // rotation and smoothed rating.
  imports: [
    IdentityModule,
    RedisModule,
    ProsModule,
    BookingsModule,
    PaymentsModule,
    GeoModule,
  ],
  controllers: [ProDispatchController, AdminDispatchController],
  providers: [
    DispatchService,
    DispatchScoringService,
    DispatchWorkerService,
    RealDispatchAdapter,
    { provide: TRAVEL_TIME_PORT, useClass: RoutedTravelTimeService },
  ],
  exports: [DispatchService],
})
export class DispatchModule {
  /**
   * Registers the real engine into module 4's delegate the moment this module
   * is constructed. Presence of `DispatchModule` in `AppModule` is therefore
   * the entire switch between manual and automatic assignment.
   */
  constructor(
    @Inject(DISPATCH_PORT) delegate: NoOpDispatchService,
    adapter: RealDispatchAdapter,
  ) {
    delegate.register(adapter);
  }
}
