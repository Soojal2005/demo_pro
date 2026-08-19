import { Module } from '@nestjs/common';
import { S3Module } from '../../storage/s3.module';
import { BookingsModule } from '../bookings/bookings.module';
import { IdentityModule } from '../identity/identity.module';
import { AdminUiConfigController } from './admin-ui-config.controller';
import { CustomerSegmentationService } from './customer-segmentation.service';
import { OptionalCustomerAuthGuard } from './optional-customer-auth.guard';
import { PublicUiConfigController } from './public-ui-config.controller';
import { UiConfigService } from './ui-config.service';
import { UiTreeValidatorService } from './ui-tree-validator.service';

@Module({
  imports: [IdentityModule, BookingsModule, S3Module],
  controllers: [AdminUiConfigController, PublicUiConfigController],
  providers: [
    UiConfigService,
    UiTreeValidatorService,
    CustomerSegmentationService,
    OptionalCustomerAuthGuard,
  ],
})
export class ConfigUiModule {}
