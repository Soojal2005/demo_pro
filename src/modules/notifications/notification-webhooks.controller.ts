import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiNoContentEnvelope } from '../../common/swagger/api-envelope.decorator';
import { ProviderDeliveryWebhookDto } from './dto/notification.dto';
import { NotificationsService } from './notifications.service';

type RawBodyRequest = FastifyRequest & { rawBody?: Buffer };

@ApiTags('Webhooks — Notifications')
@Controller('webhooks/notifications')
export class NotificationWebhooksController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get('whatsapp')
  @ApiOperation({ summary: 'Complete WhatsApp Business webhook verification' })
  verifyWhatsApp(
    @Query('hub.mode') mode: string | undefined,
    @Query('hub.verify_token') token: string | undefined,
    @Query('hub.challenge') challenge: string | undefined,
    @Res() reply: FastifyReply,
  ): void {
    reply
      .type('text/plain')
      .send(this.notifications.verifyWhatsAppChallenge(mode, token, challenge));
  }

  @Post('whatsapp')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Receive signed WhatsApp delivery status' })
  @ApiNoContentEnvelope()
  async whatsapp(
    @Req() request: RawBodyRequest,
    @Headers('x-hub-signature-256') signature: string | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    this.notifications.verifyWebhookSignature(
      'whatsapp',
      request.rawBody,
      signature,
    );
    await this.notifications.applyWhatsAppPayload(body);
  }

  @Post('sms')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Receive signed SMS delivery status' })
  @ApiNoContentEnvelope()
  async sms(
    @Req() request: RawBodyRequest,
    @Headers('x-sms-signature') signature: string | undefined,
    @Body() dto: ProviderDeliveryWebhookDto,
  ): Promise<void> {
    this.notifications.verifyWebhookSignature(
      'sms',
      request.rawBody,
      signature,
    );
    await this.notifications.applyProviderStatus('sms_gateway', dto);
  }
}
