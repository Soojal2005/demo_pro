import { Module, forwardRef } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { ProsModule } from '../pros/pros.module';
import { AdminCatalogController } from './admin-catalog.controller';
import { AdminCatalogService } from './admin-catalog.service';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';
import { CatalogueController } from './catalogue.controller';
import { ServiceCatalogController } from './service-catalog.controller';
import { ServiceCatalogService } from './service-catalog.service';

/**
 * Module 3 · Service Catalog — the tree of what can be booked, and at what
 * price. Owns `ServiceCategory`, `Service` and `City`.
 *
 * `ServiceCatalogService` and `CatalogService` are the module's exported
 * interface. Booking, Dispatch, Commission and Pro Management consume the
 * catalogue through them and never touch these tables directly.
 */
@Module({
  // ProsModule via forwardRef: launching a city is gated on approved-Pro
  // supply (US-3.9), while Pro Management needs this module to validate
  // service assignments. The dependency really does run both ways.
  imports: [IdentityModule, forwardRef(() => ProsModule)],
  controllers: [
    CatalogController,
    CatalogueController,
    ServiceCatalogController,
    AdminCatalogController,
  ],
  providers: [CatalogService, ServiceCatalogService, AdminCatalogService],
  exports: [CatalogService, ServiceCatalogService],
})
export class CatalogModule {}
