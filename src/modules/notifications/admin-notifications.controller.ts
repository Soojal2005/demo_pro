import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiNoContentEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import {
  NotificationQueryDto,
  UpdateNotificationTemplateDto,
} from './dto/notification.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('Admin — Notifications')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/notifications')
export class AdminNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermissions(PermissionCode.NOTIFICATION_READ)
  @ApiNoContentEnvelope()
  list(
    @Query() query: NotificationQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.notifications.listLogs(query, actor);
  }

  @Get('templates')
  @RequirePermissions(PermissionCode.NOTIFICATION_READ)
  @ApiOkEnvelope()
  templates() {
    return this.notifications.listTemplates();
  }

  @Patch('templates/:key')
  @RequirePermissions(PermissionCode.NOTIFICATION_TEMPLATE_MANAGE)
  @ApiOkEnvelope()
  updateTemplate(
    @Param('key') key: string,
    @Body() dto: UpdateNotificationTemplateDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.notifications.updateTemplate(key, dto, actor.id);
  }

  @Get('bookings/:bookingId')
  @RequirePermissions(PermissionCode.NOTIFICATION_READ)
  @ApiOkEnvelope()
  bookingHistory(
    @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.notifications.listBookingLogs(bookingId, actor);
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions(PermissionCode.NOTIFICATION_RETRY)
  @ApiOperation({ summary: 'Retry one failed or skipped provider delivery' })
  @ApiOkEnvelope()
  async retry(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<void> {
    await this.notifications.retry(id);
  }
}
