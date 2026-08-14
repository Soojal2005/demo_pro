import { Module } from '@nestjs/common';
import { RedisModule } from '../../redis/redis.module';
import { S3Module } from '../../storage/s3.module';
import { IdentityModule } from '../identity/identity.module';
import { ProsModule } from '../pros/pros.module';
import { BookingsModule } from '../bookings/bookings.module';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminController } from './admin.controller';
import { AdminJobsService } from './admin-jobs.service';
import { AdminViewsService } from './admin-views.service';
import { PlatformSettingsAdminService } from './platform-settings-admin.service';
import { ReportArtifactService } from './report-artifact.service';

@Module({
  imports: [IdentityModule, ProsModule, BookingsModule, RedisModule, S3Module],
  controllers: [AdminController],
  providers: [
    AdminAnalyticsService,
    AdminJobsService,
    AdminViewsService,
    PlatformSettingsAdminService,
    ReportArtifactService,
  ],
})
export class AdminModule {}
