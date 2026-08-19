import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiNoContentEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { RegisterPushTokenDto } from './dto/notification.dto';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Put('push-token')
  @ApiOperation({
    summary: 'Register or replace the current device push token',
  })
  @ApiOkEnvelope()
  register(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: RegisterPushTokenDto,
  ) {
    return this.notifications.registerPushToken(actor, dto);
  }

  @Delete('push-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentEnvelope()
  async clear(@CurrentUser() actor: AuthenticatedUser): Promise<void> {
    await this.notifications.clearPushToken(actor);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentEnvelope()
  async markRead(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<void> {
    await this.notifications.markRead(id, actor);
  }
}
