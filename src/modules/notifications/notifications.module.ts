import { Global, Module } from '@nestjs/common';
import { FirebaseModule } from '../../firebase/firebase.module';
import { IdentityModule } from '../identity/identity.module';
import { AdminNotificationsController } from './admin-notifications.controller';
import { NotificationProviderService } from './notification-provider.service';
import { NotificationWebhooksController } from './notification-webhooks.controller';
import { NotificationWorkerService } from './notification-worker.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  imports: [IdentityModule, FirebaseModule],
  controllers: [
    NotificationsController,
    AdminNotificationsController,
    NotificationWebhooksController,
  ],
  providers: [
    NotificationsService,
    NotificationProviderService,
    NotificationWorkerService,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
