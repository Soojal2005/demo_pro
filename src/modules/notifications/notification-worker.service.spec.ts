import { NotificationWorkerService } from './notification-worker.service';

describe('NotificationWorkerService', () => {
  const template = {
    key: 'dispatch.assignment_offered',
    isActive: true,
    isCritical: true,
    channels: ['push', 'sms'],
    pushTitle: 'New job',
    pushBody: 'Booking {{bookingNumber}}',
    whatsappTemplate: null,
    smsBody: 'Booking {{bookingNumber}}',
    retryLimit: 1,
    fallbackDelaySeconds: 0,
  };
  const outbox = {
    id: 'outbox-1',
    eventKey: 'dispatch.assigned',
    dedupeKey: 'dispatch:b1:attempt:1:pro',
    recipientType: 'pro',
    customerId: null,
    proId: 'pro-1',
    adminUserId: null,
    bookingId: '00000000-0000-4000-b000-000000000001',
    templateKey: template.key,
    variablesJson: { bookingNumber: 'HMG-1' },
    attemptCount: 1,
    customer: null,
    adminUser: null,
    pro: {
      id: 'pro-1',
      phone: '+919876543210',
      pushToken: 'device-token',
      pushPlatform: 'android',
    },
  };

  const build = () => {
    const prisma = {
      notificationOutbox: {
        findFirst: jest.fn().mockResolvedValue({ id: outbox.id }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(outbox),
        update: jest.fn().mockResolvedValue({}),
      },
      notificationTemplate: {
        findUnique: jest.fn().mockResolvedValue(template),
      },
      notificationLog: {
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'log-push' })
          .mockResolvedValueOnce({ id: 'log-sms' }),
        update: jest.fn().mockResolvedValue({}),
      },
      customer: { updateMany: jest.fn() },
      pro: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      adminUser: { updateMany: jest.fn() },
      $transaction: jest.fn().mockResolvedValue([]),
    };
    const providers = { send: jest.fn() };
    const config = {
      get: jest.fn((_key: string, fallback: string) => fallback),
    };
    return {
      prisma,
      providers,
      worker: new NotificationWorkerService(
        prisma as never,
        providers as never,
        config as never,
      ),
    };
  };

  it('marks an accepted push and completes the durable event', async () => {
    const { prisma, providers, worker } = build();
    providers.send.mockResolvedValue({
      accepted: true,
      provider: 'fcm',
      providerReference: 'projects/p/messages/1',
    });
    await expect(worker.runOnce()).resolves.toBe(true);
    expect(providers.send).toHaveBeenCalledTimes(1);
    expect(prisma.notificationLog.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'accepted' }),
      }),
    );
  });

  it('clears a permanently rejected token and immediately falls back to SMS', async () => {
    const { prisma, providers, worker } = build();
    providers.send
      .mockResolvedValueOnce({
        accepted: false,
        provider: 'fcm',
        permanentFailure: true,
        failureCode: 'messaging/registration-token-not-registered',
        failureReason: 'Token is stale',
      })
      .mockResolvedValueOnce({
        accepted: true,
        provider: 'sms_gateway',
        providerReference: 'sms-1',
      });
    await worker.runOnce();
    expect(prisma.pro.updateMany).toHaveBeenCalledWith({
      where: { id: 'pro-1', pushToken: 'device-token' },
      data: expect.objectContaining({ pushToken: null }),
    });
    expect(providers.send).toHaveBeenCalledTimes(2);
    expect(providers.send.mock.calls[1][0].channel).toBe('sms');
  });
});
