import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { GeocodingModule } from './geocoding/geocoding.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { RoutingModule } from './routing/routing.module';
import { BookingsModule } from './modules/bookings/bookings.module';
import { DispatchModule } from './modules/dispatch/dispatch.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { CommissionModule } from './modules/commission/commission.module';
import { CustomersModule } from './modules/customers/customers.module';
import { IdentityModule } from './modules/identity/identity.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { GeoModule } from './modules/geo/geo.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ProsModule } from './modules/pros/pros.module';
import { ReviewsModule } from './modules/reviews/reviews.module';
import { TrainingModule } from './modules/training/training.module';
import { AdminModule } from './modules/admin/admin.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';

// NODE_ENV picks the override file; `.env` is always the fallback beneath it.
// ConfigModule gives the FIRST file that defines a variable precedence, so the
// environment-specific file wins and `.env` fills in whatever it omits.
const nodeEnv = process.env.NODE_ENV ?? 'local';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: [`.env.${nodeEnv}`, '.env'],
    }),
    PrismaModule,
    GeocodingModule,
    // Global, like geocoding, and for the same reason: dispatch, bookings and
    // geo all need road travel time and none of them can own it.
    RoutingModule,
    HealthModule,
    CatalogModule,
    IdentityModule,
    CustomersModule,
    ProsModule,
    BookingsModule,
    // Payments and Geo before Dispatch: dispatch filters the candidate pool by
    // the cash ceiling and by area posting, and Nest instantiates in import
    // order. Both register into module 4's port delegates on construction.
    PaymentsModule,
    GeoModule,
    DispatchModule,
    // Last two, in this order: module 8 registers into module 4's completion
    // delegate and module 7's reversal delegate, and module 9 registers into
    // the ledger delegates of both 7 and 8 — so each must already exist.
    CommissionModule,
    LedgerModule,
    // Module 10. Reviews is a leaf; Training registers into module 6's
    // activation-gate delegate, so ProsModule must already be constructed —
    // it is, several lines above.
    ReviewsModule,
    TrainingModule,
    // Module 15 is an aggregation layer over the domain modules above. It is
    // last so it reuses their tables and services instead of owning copies.
    AdminModule,
    // The admin console's landing screen. Like AdminModule it owns no tables —
    // it counts rows the modules above already store. Kept separate because it
    // answers one screen's question, not a reporting need.
    DashboardModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
