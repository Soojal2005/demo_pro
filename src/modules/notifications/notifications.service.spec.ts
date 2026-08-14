import { HttpException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  const build = () => {
    const prisma = {
      customer: { update: jest.fn().mockResolvedValue({}) },
      pro: { update: jest.fn().mockResolvedValue({}) },
      adminUser: { update: jest.fn().mockResolvedValue({}) },
      notificationTemplate: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn(),
      },
      notificationLog: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'WHATSAPP_WEBHOOK_SECRET' ? 'webhook-secret' : undefined,
      ),
    };
    return {
      prisma,
      service: new NotificationsService(prisma as never, config as never),
    };
  };

  it('overwrites the one stored device token for the authenticated actor', async () => {
    const { prisma, service } = build();
    const result = await service.registerPushToken(
      { id: 'pro-1', actorType: 'pro' },
      { token: 'fcm-token-with-enough-length', platform: 'android' },
    );
    expect(prisma.pro.update).toHaveBeenCalledWith({
      where: { id: 'pro-1' },
      data: expect.objectContaining({
        pushToken: 'fcm-token-with-enough-length',
        pushPlatform: 'android',
      }),
    });
    expect(result).toEqual(expect.objectContaining({ registered: true }));
  });

  it('rejects a channel whose required content is absent', async () => {
    const { prisma, service } = build();
    prisma.notificationTemplate.findUnique.mockResolvedValue({
      key: 'test',
      channels: ['push'],
      pushTitle: null,
      pushBody: null,
      whatsappTemplate: null,
      smsBody: null,
      allowedVariables: [],
    });
    await expect(
      service.updateTemplate('test', { isActive: true }, 'admin-1'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(prisma.notificationTemplate.update).not.toHaveBeenCalled();
  });

  it('verifies delivery webhooks over the unchanged raw body', () => {
    const { service } = build();
    const body = Buffer.from('{"providerReference":"wamid.1"}');
    const signature = createHmac('sha256', 'webhook-secret')
      .update(body)
      .digest('hex');
    expect(() =>
      service.verifyWebhookSignature('whatsapp', body, `sha256=${signature}`),
    ).not.toThrow();
    expect(() =>
      service.verifyWebhookSignature('whatsapp', body, 'sha256=bad'),
    ).toThrow(HttpException);
  });

  it('does not let a late failure move a delivered message backward', async () => {
    const { prisma, service } = build();
    await service.applyProviderStatus('whatsapp_business', {
      providerReference: 'wamid.1',
      status: 'failed',
      failureReason: 'late provider callback',
    });
    expect(prisma.notificationLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['queued', 'sending', 'accepted'] },
        }),
      }),
    );
  });

  it('extracts Meta WhatsApp delivery statuses by provider reference', async () => {
    const { prisma, service } = build();
    await service.applyWhatsAppPayload({
      entry: [
        {
          changes: [
            { value: { statuses: [{ id: 'wamid.2', status: 'delivered' }] } },
          ],
        },
      ],
    });
    expect(prisma.notificationLog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ providerReference: 'wamid.2' }),
      }),
    );
  });
});
