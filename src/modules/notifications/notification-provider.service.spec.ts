import { NotificationProviderService } from './notification-provider.service';

describe('NotificationProviderService', () => {
  it('uses deterministic provider-shaped mock acceptance without external calls', async () => {
    const config = { get: jest.fn().mockReturnValue('mock') };
    const firebase = { sendPush: jest.fn() };
    const provider = new NotificationProviderService(
      config as never,
      firebase as never,
    );
    const result = await provider.send({
      channel: 'push',
      token: 'device-token',
      platform: 'ios',
      title: 'Arrival',
      body: 'Your Pro arrived',
      variables: {},
      data: {},
    });
    expect(result).toEqual(
      expect.objectContaining({ accepted: true, provider: 'apns_via_fcm' }),
    );
    expect(firebase.sendPush).not.toHaveBeenCalled();
  });

  it('classifies an unregistered FCM token as permanent', async () => {
    const config = {
      get: jest.fn((key: string, fallback?: string) =>
        key === 'NOTIFICATION_PROVIDER_MODE' ? 'live' : fallback,
      ),
    };
    const firebase = {
      sendPush: jest.fn().mockRejectedValue({
        code: 'messaging/registration-token-not-registered',
        message: 'stale token',
      }),
    };
    const provider = new NotificationProviderService(
      config as never,
      firebase as never,
    );
    await expect(
      provider.send({
        channel: 'push',
        token: 'device-token',
        platform: 'android',
        title: 'Job',
        body: 'New job',
        variables: {},
        data: {},
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        accepted: false,
        permanentFailure: true,
      }),
    );
  });
});
