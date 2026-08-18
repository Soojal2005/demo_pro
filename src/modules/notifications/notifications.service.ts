import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { apiError } from '../../common/utils';
import { Prisma, type NotificationLog } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  NotificationQueryDto,
  ProviderDeliveryWebhookDto,
  RegisterPushTokenDto,
  UpdateNotificationTemplateDto,
} from './dto/notification.dto';
import {
  NOTIFICATION_CHANNELS,
  maskPhone,
  recipientForeignKey,
  type NotificationIntent,
  type NotificationTx,
} from './notification.types';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async registerPushToken(actor: AuthenticatedUser, dto: RegisterPushTokenDto) {
    const updatedAt = new Date();
    const data = {
      pushToken: dto.token,
      pushPlatform: dto.platform,
      pushTokenUpdatedAt: updatedAt,
    };
    if (actor.actorType === 'customer')
      await this.prisma.customer.update({ where: { id: actor.id }, data });
    else if (actor.actorType === 'pro')
      await this.prisma.pro.update({ where: { id: actor.id }, data });
    else await this.prisma.adminUser.update({ where: { id: actor.id }, data });
    return { registered: true, platform: dto.platform, updatedAt };
  }

  clearPushToken(actor: AuthenticatedUser): Promise<unknown> {
    const data = {
      pushToken: null,
      pushPlatform: null,
      pushTokenUpdatedAt: new Date(),
    };
    if (actor.actorType === 'customer')
      return this.prisma.customer.update({ where: { id: actor.id }, data });
    if (actor.actorType === 'pro')
      return this.prisma.pro.update({ where: { id: actor.id }, data });
    return this.prisma.adminUser.update({ where: { id: actor.id }, data });
  }

  async enqueue(
    intent: NotificationIntent,
    tx: NotificationTx = this.prisma,
  ): Promise<void> {
    try {
      await tx.notificationOutbox.create({
        data: {
          eventKey: intent.eventKey,
          dedupeKey: intent.dedupeKey,
          recipientType: intent.recipientType,
          ...recipientForeignKey(intent.recipientType, intent.recipientId),
          bookingId: intent.bookingId,
          templateKey: intent.templateKey,
          variablesJson: intent.variables,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        return;
      throw error;
    }
  }

  listTemplates() {
    return this.prisma.notificationTemplate.findMany({
      orderBy: { key: 'asc' },
    });
  }

  async updateTemplate(
    key: string,
    dto: UpdateNotificationTemplateDto,
    adminId: string,
  ) {
    const current = await this.prisma.notificationTemplate.findUnique({
      where: { key },
    });
    if (!current)
      throw new NotFoundException('Notification template not found');

    /**
     * Only the keys the caller actually sent.
     *
     * `tsconfig` targets ES2023, so `useDefineForClassFields` is on and every
     * declared-but-omitted DTO property exists on the instance as an **own**
     * property valued `undefined`. A plain `{ ...current, ...dto }` therefore
     * erases every field the caller left out, which made a partial PATCH
     * impossible: `{"channels":["push"]}` alone blanked `pushTitle` and
     * `pushBody` in the candidate and was rejected with "Push templates
     * require title and body".
     *
     * Prisma ignores `undefined`, so the write below was always safe — this
     * only ever corrupted the object that validation ran against, which is
     * why it presented as a spurious 400 rather than as data loss.
     */
    const patch = Object.fromEntries(
      Object.entries(dto).filter(([, value]) => value !== undefined),
    ) as Partial<UpdateNotificationTemplateDto>;

    this.validateTemplate({ ...current, ...patch });

    return this.prisma.notificationTemplate.update({
      where: { key },
      data: { ...patch, updatedByAdminId: adminId },
    });
  }

  listLogs(query: NotificationQueryDto, actor: AuthenticatedUser) {
    const scope = actor.cityScope ?? [];
    if (scope.length && !query.cityId)
      throw apiError(
        'A city-scoped admin must filter notifications by cityId',
        HttpStatus.FORBIDDEN,
      );
    if (query.cityId && scope.length && !scope.includes(query.cityId))
      throw apiError('Outside your city scope', HttpStatus.FORBIDDEN);
    return this.prisma.notificationLog.findMany({
      where: {
        ...(query.bookingId ? { bookingId: query.bookingId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.channel ? { channel: query.channel } : {}),
        ...(query.cityId
          ? {
              OR: [
                { booking: { address: { cityId: query.cityId } } },
                { pro: { cityId: query.cityId } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  async listBookingLogs(
    bookingId: string,
    actor: AuthenticatedUser,
  ): Promise<NotificationLog[]> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: { address: { select: { cityId: true } } },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    const scope = actor.cityScope ?? [];
    if (scope.length && !scope.includes(booking.address.cityId))
      throw apiError('Outside your city scope', HttpStatus.FORBIDDEN);
    return this.prisma.notificationLog.findMany({
      where: { bookingId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async retry(logId: string): Promise<void> {
    const log = await this.prisma.notificationLog.findUnique({
      where: { id: logId },
      include: { outbox: true },
    });
    if (!log) throw new NotFoundException('Notification log not found');
    if (!['failed', 'skipped'].includes(log.status))
      throw new ConflictException(
        'Only a failed or skipped notification can be retried',
      );
    if (!log.outbox)
      throw new ConflictException(
        'This provider delivery has no retryable event',
      );
    await this.prisma.notificationOutbox.create({
      data: {
        eventKey: log.outbox.eventKey,
        dedupeKey: `${log.outbox.dedupeKey}:manual:${randomUUID()}`,
        recipientType: log.outbox.recipientType,
        customerId: log.outbox.customerId,
        proId: log.outbox.proId,
        adminUserId: log.outbox.adminUserId,
        bookingId: log.outbox.bookingId,
        templateKey: log.outbox.templateKey,
        variablesJson: log.outbox.variablesJson as Prisma.InputJsonValue,
      },
    });
  }

  async markRead(id: string, actor: AuthenticatedUser): Promise<void> {
    const relation = recipientForeignKey(actor.actorType, actor.id);
    const result = await this.prisma.notificationLog.updateMany({
      where: { id, ...relation },
      data: { status: 'read', readAt: new Date() },
    });
    if (!result.count) throw new NotFoundException('Notification not found');
  }

  async recordOtpDelivery(input: {
    dedupeKey: string;
    templateKey: string;
    providerReference: string;
    phone: string;
    recipientType: 'customer' | 'pro' | 'admin';
    recipientId?: string;
    bookingId?: string;
    channel?: 'whatsapp' | 'sms';
  }): Promise<void> {
    try {
      await this.prisma.notificationLog.create({
        data: {
          dedupeKey: input.dedupeKey,
          recipientType: input.recipientType,
          ...(input.recipientId
            ? recipientForeignKey(input.recipientType, input.recipientId)
            : {}),
          recipientMasked: maskPhone(input.phone),
          bookingId: input.bookingId,
          channel: input.channel ?? 'whatsapp',
          provider: 'slide',
          templateKey: input.templateKey,
          payloadJson: { kind: 'otp', secretStored: false },
          status: 'accepted',
          providerReference: input.providerReference,
          sentAt: new Date(),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      )
        return;
      throw error;
    }
  }

  async applyProviderStatus(
    provider: 'whatsapp_business' | 'sms_gateway',
    dto: ProviderDeliveryWebhookDto,
  ): Promise<void> {
    const eligible =
      dto.status === 'failed'
        ? ['queued', 'sending', 'accepted']
        : dto.status === 'delivered'
          ? ['queued', 'sending', 'accepted']
          : ['queued', 'sending', 'accepted', 'delivered'];
    const data = {
      status: dto.status,
      failureCode: dto.failureCode,
      failureReason: dto.failureReason,
      deliveredAt: dto.status === 'delivered' ? new Date() : undefined,
      failedAt: dto.status === 'failed' ? new Date() : undefined,
      readAt: dto.status === 'read' ? new Date() : undefined,
    };
    await this.prisma.notificationLog.updateMany({
      where: {
        provider,
        providerReference: dto.providerReference,
        status: { in: eligible },
      },
      data,
    });
  }

  async applyWhatsAppPayload(body: unknown): Promise<void> {
    if (!body || typeof body !== 'object') return;
    const entries = (body as { entry?: unknown }).entry;
    if (!Array.isArray(entries)) return;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      const changes = (entry as { changes?: unknown }).changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        if (!change || typeof change !== 'object') continue;
        const value = (change as { value?: unknown }).value;
        if (!value || typeof value !== 'object') continue;
        const statuses = (value as { statuses?: unknown }).statuses;
        if (!Array.isArray(statuses)) continue;
        for (const item of statuses) {
          if (!item || typeof item !== 'object') continue;
          const status = item as {
            id?: unknown;
            status?: unknown;
            errors?: Array<{ code?: unknown; title?: unknown }>;
          };
          if (typeof status.id !== 'string') continue;
          if (!['delivered', 'read', 'failed'].includes(String(status.status)))
            continue;
          const providerError = status.errors?.[0];
          const errorCode = providerError?.code;
          const errorTitle = providerError?.title;
          await this.applyProviderStatus('whatsapp_business', {
            providerReference: status.id,
            status: status.status as 'delivered' | 'read' | 'failed',
            failureCode:
              typeof errorCode === 'string' || typeof errorCode === 'number'
                ? `${errorCode}`
                : undefined,
            failureReason:
              typeof errorTitle === 'string' ? errorTitle : undefined,
          });
        }
      }
    }
  }

  verifyWhatsAppChallenge(
    mode: string | undefined,
    token: string | undefined,
    challenge: string | undefined,
  ): string {
    const configured = this.config.get<string>('WHATSAPP_VERIFY_TOKEN');
    if (
      mode !== 'subscribe' ||
      !configured ||
      token !== configured ||
      !challenge
    )
      throw apiError('Invalid webhook verification', HttpStatus.FORBIDDEN);
    return challenge;
  }

  verifyWebhookSignature(
    provider: 'whatsapp' | 'sms',
    rawBody: Buffer | string | undefined,
    signature: string | undefined,
  ): void {
    const secret = this.config.get<string>(
      provider === 'whatsapp'
        ? 'WHATSAPP_WEBHOOK_SECRET'
        : 'SMS_WEBHOOK_SECRET',
    );
    if (!secret || !rawBody || !signature)
      throw apiError('Unsigned webhook delivery', HttpStatus.UNAUTHORIZED);
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const supplied = signature.replace(/^sha256=/, '');
    const left = Buffer.from(expected);
    const right = Buffer.from(supplied);
    if (left.length !== right.length || !timingSafeEqual(left, right))
      throw apiError('Invalid webhook signature', HttpStatus.UNAUTHORIZED);
  }

  private validateTemplate(template: {
    channels: unknown;
    pushTitle?: string | null;
    pushBody?: string | null;
    whatsappTemplate?: string | null;
    smsBody?: string | null;
    allowedVariables: unknown;
  }): void {
    if (
      !Array.isArray(template.channels) ||
      !template.channels.length ||
      template.channels.some(
        (channel) =>
          typeof channel !== 'string' ||
          !NOTIFICATION_CHANNELS.includes(
            channel as (typeof NOTIFICATION_CHANNELS)[number],
          ),
      )
    )
      throw apiError('Template has invalid channels', HttpStatus.BAD_REQUEST);
    if (
      template.channels.includes('push') &&
      (!template.pushTitle || !template.pushBody)
    )
      throw apiError(
        'Push templates require title and body',
        HttpStatus.BAD_REQUEST,
      );
    if (template.channels.includes('whatsapp') && !template.whatsappTemplate)
      throw apiError(
        'WhatsApp routing requires an approved template name',
        HttpStatus.BAD_REQUEST,
      );
    if (template.channels.includes('sms') && !template.smsBody)
      throw apiError('SMS routing requires a body', HttpStatus.BAD_REQUEST);
    const allowed = Array.isArray(template.allowedVariables)
      ? template.allowedVariables
      : [];
    const sources = [template.pushTitle, template.pushBody, template.smsBody];
    for (const source of sources) {
      if (!source) continue;
      const variables = [...source.matchAll(/\{\{([a-zA-Z0-9_]+)}}/g)].map(
        (match) => match[1],
      );
      const unknown = variables.find((name) => !allowed.includes(name));
      if (unknown)
        throw apiError(
          `Template uses undeclared variable ${unknown}`,
          HttpStatus.BAD_REQUEST,
        );
    }
  }
}
