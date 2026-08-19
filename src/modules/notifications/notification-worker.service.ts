import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationProviderService } from './notification-provider.service';
import {
  maskPhone,
  renderTemplate,
  type NotificationChannel,
} from './notification.types';

@Injectable()
export class NotificationWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationWorkerService.name);
  private readonly workerId = randomUUID();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: NotificationProviderService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (
      this.config.get<string>('NOTIFICATION_WORKER_ENABLED', 'true') === 'false'
    )
      return;
    void this.recoverInterrupted();
    const interval = Number(
      this.config.get<string>('NOTIFICATION_WORKER_INTERVAL_MS', '1000'),
    );
    this.timer = setInterval(() => void this.drain(), Math.max(250, interval));
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<boolean> {
    const row = await this.prisma.notificationOutbox.findFirst({
      where: { status: 'queued', availableAt: { lte: new Date() } },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!row) return false;
    const claimed = await this.prisma.notificationOutbox.updateMany({
      where: { id: row.id, status: 'queued' },
      data: {
        status: 'processing',
        lockedAt: new Date(),
        lockedBy: this.workerId,
        attemptCount: { increment: 1 },
      },
    });
    if (!claimed.count) return true;
    await this.process(row.id);
    return true;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let i = 0; i < 20 && (await this.runOnce()); i += 1) {
        // Bound each tick so health checks and API traffic retain capacity.
      }
    } catch (error) {
      this.logger.error(
        `Notification worker tick failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      this.running = false;
    }
  }

  private async process(id: string): Promise<void> {
    const outbox = await this.prisma.notificationOutbox.findUnique({
      where: { id },
      include: { customer: true, pro: true, adminUser: true },
    });
    if (!outbox) return;
    const template = await this.prisma.notificationTemplate.findUnique({
      where: { key: outbox.templateKey },
    });
    if (!template?.isActive) {
      await this.failOutbox(id, 'Notification template is missing or inactive');
      return;
    }
    const channels = Array.isArray(template.channels)
      ? template.channels.filter(
          (value): value is NotificationChannel =>
            typeof value === 'string' &&
            ['push', 'whatsapp', 'sms'].includes(value),
        )
      : [];
    const variables = this.stringVariables(outbox.variablesJson);
    const recipient = outbox.customer ?? outbox.pro ?? outbox.adminUser;
    if (!recipient) {
      await this.failOutbox(id, 'Notification recipient no longer exists');
      return;
    }
    let lastFailure = 'No delivery channel was usable';
    for (const channel of channels) {
      const bodySource =
        channel === 'sms'
          ? template.smsBody
          : (template.pushBody ?? template.smsBody);
      const missingTarget =
        (channel === 'push' && !recipient.pushToken) ||
        (channel !== 'push' && !recipient.phone) ||
        !bodySource;
      const attemptNumber = outbox.attemptCount;
      const log = await this.prisma.notificationLog.create({
        data: {
          outboxId: outbox.id,
          dedupeKey: outbox.dedupeKey,
          recipientType: outbox.recipientType,
          customerId: outbox.customerId,
          proId: outbox.proId,
          adminUserId: outbox.adminUserId,
          recipientMasked: maskPhone(recipient.phone),
          bookingId: outbox.bookingId,
          channel,
          provider:
            channel === 'push'
              ? recipient.pushPlatform === 'ios'
                ? 'apns_via_fcm'
                : 'fcm'
              : channel === 'whatsapp'
                ? 'whatsapp_business'
                : 'sms_gateway',
          templateKey: template.key,
          payloadJson: {
            title: template.pushTitle,
            body: bodySource ? renderTemplate(bodySource, variables) : null,
            variables,
          },
          status: missingTarget ? 'skipped' : 'sending',
          attemptNumber,
          failureCode: missingTarget ? 'DELIVERY_TARGET_MISSING' : null,
          failureReason: missingTarget
            ? 'The recipient has no usable address for this channel'
            : null,
        },
      });
      if (missingTarget) {
        lastFailure = 'The recipient has no usable delivery target';
        if (!template.isCritical) break;
        continue;
      }
      const result = await this.providers.send({
        channel,
        token: recipient.pushToken ?? undefined,
        platform: recipient.pushPlatform ?? undefined,
        phone: recipient.phone ?? undefined,
        title: template.pushTitle
          ? renderTemplate(template.pushTitle, variables)
          : undefined,
        body: renderTemplate(bodySource, variables),
        templateName: template.whatsappTemplate ?? undefined,
        variables,
        data: {
          notificationId: log.id,
          eventKey: outbox.eventKey,
          ...(outbox.bookingId ? { bookingId: outbox.bookingId } : {}),
        },
      });
      if (result.accepted) {
        await this.prisma.$transaction([
          this.prisma.notificationLog.update({
            where: { id: log.id },
            data: {
              status: 'accepted',
              provider: result.provider,
              providerReference: result.providerReference,
              sentAt: new Date(),
            },
          }),
          this.prisma.notificationOutbox.update({
            where: { id },
            data: {
              status: 'completed',
              processedAt: new Date(),
              lockedAt: null,
              lockedBy: null,
              failureReason: null,
            },
          }),
        ]);
        return;
      }
      lastFailure = result.failureReason ?? 'Provider rejected the message';
      await this.prisma.notificationLog.update({
        where: { id: log.id },
        data: {
          status: 'failed',
          provider: result.provider,
          failureCode: result.failureCode,
          failureReason: result.failureReason,
          failedAt: new Date(),
        },
      });
      if (channel === 'push' && result.permanentFailure && recipient.pushToken)
        await this.clearRejectedToken(outbox, recipient.pushToken);
      if (!template.isCritical) break;
    }
    if (outbox.attemptCount <= template.retryLimit) {
      const seconds = Math.max(
        template.fallbackDelaySeconds,
        Math.min(300, 2 ** outbox.attemptCount),
      );
      await this.prisma.notificationOutbox.update({
        where: { id },
        data: {
          status: 'queued',
          availableAt: new Date(Date.now() + seconds * 1000),
          lockedAt: null,
          lockedBy: null,
          failureReason: lastFailure,
        },
      });
    } else await this.failOutbox(id, lastFailure);
  }

  private async clearRejectedToken(
    outbox: {
      customerId: string | null;
      proId: string | null;
      adminUserId: string | null;
    },
    rejectedToken: string,
  ): Promise<void> {
    const data = {
      pushToken: null,
      pushPlatform: null,
      pushTokenUpdatedAt: new Date(),
    };
    if (outbox.customerId)
      await this.prisma.customer.updateMany({
        where: { id: outbox.customerId, pushToken: rejectedToken },
        data,
      });
    else if (outbox.proId)
      await this.prisma.pro.updateMany({
        where: { id: outbox.proId, pushToken: rejectedToken },
        data,
      });
    else if (outbox.adminUserId)
      await this.prisma.adminUser.updateMany({
        where: { id: outbox.adminUserId, pushToken: rejectedToken },
        data,
      });
  }

  private failOutbox(id: string, failureReason: string): Promise<unknown> {
    return this.prisma.notificationOutbox.update({
      where: { id },
      data: {
        status: 'failed',
        processedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        failureReason,
      },
    });
  }

  private async recoverInterrupted(): Promise<void> {
    // `onModuleInit` fires this without awaiting it, so anything thrown here
    // escapes as an unhandled rejection and takes the whole process down at
    // boot. Recovery is best-effort: `drain` picks the rows up on a later tick.
    try {
      await this.prisma.notificationOutbox.updateMany({
        where: {
          status: 'processing',
          lockedAt: { lt: new Date(Date.now() - 5 * 60 * 1000) },
        },
        data: {
          status: 'queued',
          lockedAt: null,
          lockedBy: null,
          failureReason: 'Recovered after an interrupted worker',
        },
      });
    } catch (error) {
      this.logger.error(
        `Could not recover interrupted notifications; the worker will keep draining the queue normally: ${error instanceof Error ? error.message : 'Unknown database error'}`,
      );
    }
  }

  private stringVariables(value: Prisma.JsonValue): Record<string, string> {
    if (!value || Array.isArray(value) || typeof value !== 'object') return {};
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        item === null
          ? ''
          : typeof item === 'object'
            ? JSON.stringify(item)
            : String(item),
      ]),
    );
  }
}
