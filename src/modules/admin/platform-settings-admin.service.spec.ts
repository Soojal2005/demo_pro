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
        ),
      ),
    ).toBe(HttpStatus.BAD_REQUEST);
  });
});
