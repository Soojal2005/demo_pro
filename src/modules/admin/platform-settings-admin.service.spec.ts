import { HttpException, HttpStatus } from '@nestjs/common';
import { PlatformSettingsAdminService } from './platform-settings-admin.service';

const statusOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
  throw new Error('Expected rejection');
};

describe('PlatformSettingsAdminService', () => {
  it('shows the city override and effective source without hiding the global value', async () => {
    const prisma = {
      platformSetting: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'global',
            key: 'assignment.ackWindowSeconds',
            cityId: null,
            value: '30',
          },
          {
            id: 'city',
            key: 'assignment.ackWindowSeconds',
            cityId: 'city-1',
            value: '45',
          },
        ]),
      },
    };
    const [result] = await new PlatformSettingsAdminService(
      prisma as never,
    ).list('city-1', 'assignment.ackWindowSeconds');
    expect(result).toEqual(
      expect.objectContaining({ effectiveValue: '45', source: 'city' }),
    );
    expect(result.global?.value).toBe('30');
  });

  it('rejects unknown keys instead of persisting magic strings', async () => {
    const prisma = { platformSetting: {} };
    expect(
      await statusOf(
        new PlatformSettingsAdminService(prisma as never).upsert(
          'made.up',
          '1',
          undefined,
          'admin-1',
          'Testing an unknown setting key',
        ),
      ),
    ).toBe(HttpStatus.BAD_REQUEST);
  });

  it('prevents the active lifecycle threshold from crossing lapsed', async () => {
    const prisma = {
      platformSetting: {
        findFirst: jest.fn().mockResolvedValue({ value: '90' }),
      },
    };
    expect(
      await statusOf(
        new PlatformSettingsAdminService(prisma as never).upsert(
          'reporting.customerActiveDays',
          '100',
          undefined,
          'admin-1',
          'Testing lifecycle threshold validation',
        ),
      ),
    ).toBe(HttpStatus.BAD_REQUEST);
  });

  it('rejects fractional values for settings consumed as counts', async () => {
    const prisma = { platformSetting: {} };
    expect(
      await statusOf(
        new PlatformSettingsAdminService(prisma as never).upsert(
          'dispatch.maxAttempts',
          '2.5',
          undefined,
          'admin-1',
          'Testing fractional count rejection',
        ),
      ),
    ).toBe(HttpStatus.BAD_REQUEST);
  });

  it('requires explicit impact confirmation for rating-prior changes', async () => {
    const prisma = { platformSetting: {} };
    expect(
      await statusOf(
        new PlatformSettingsAdminService(prisma as never).upsert(
          'dispatch.ratingPriorMean',
          '4.2',
          undefined,
          'admin-1',
          'Adjusting the platform cold-start prior',
        ),
      ),
    ).toBe(HttpStatus.BAD_REQUEST);
  });

  it('writes the setting and its before/after revision atomically', async () => {
    const tx = {
      platformSetting: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'setting-1',
          key: 'assignment.ackWindowSeconds',
          cityId: null,
          value: '120',
        }),
        update: jest.fn().mockResolvedValue({
          id: 'setting-1',
          value: '90',
        }),
      },
      platformSettingRevision: { create: jest.fn() },
    };
    const prisma = {
      $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
        callback(tx),
      ),
    };

    await new PlatformSettingsAdminService(prisma as never).upsert(
      'assignment.ackWindowSeconds',
      '90',
      undefined,
      'admin-1',
      'Reduce acknowledgement latency for dispatch',
    );

    expect(tx.platformSettingRevision.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        previousValue: '120',
        newValue: '90',
        changedByAdminId: 'admin-1',
      }),
    });
  });
});
