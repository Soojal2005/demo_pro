import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { LedgerModule } from '../ledger/ledger.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * The admin console's first screen.
 *
 * Owns no tables. It reads across the other modules' data and answers one
 * question — "what needs a person today, and how is the week going" — in a
 * single call, so the console does not open with eight parallel list fetches it
 * only wanted the length of.
 *
 * Kept as its own module rather than added to an existing one because it
 * belongs to none of them, and because module 15 (Admin Console & Reporting) is
 * unbuilt: when its own dashboard arrives, deleting this directory is the whole
 * removal.
 */
@Module({
  imports: [IdentityModule, LedgerModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
