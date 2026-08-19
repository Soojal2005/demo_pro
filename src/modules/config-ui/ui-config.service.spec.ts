import { ServiceUnavailableException } from '@nestjs/common';
import { UiConfigService } from './ui-config.service';

describe('UiConfigService', () => {
  const build = () => {
    const prisma = {
      city: { findUnique: jest.fn().mockResolvedValue({ id: 'city-1' }) },
      uiConfig: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    const validator = {
      validate: jest.fn().mockResolvedValue({ valid: true }),
    };
    const s3 = { putCdnObject: jest.fn() };
    const cloudFront = {
      configured: true,
      invalidate: jest.fn().mockResolvedValue(new Date('2026-08-14T00:00:00Z')),
      urlFor: jest.fn((key: string) => `https://cdn.example/${key}`),
    };
    return {
      prisma,
      validator,
      s3,
      cloudFront,
      service: new UiConfigService(
        prisma as never,
        validator as never,
        s3 as never,
        cloudFront as never,
      ),
    };
  };

  it('uses city+segment before every broader target', async () => {
    const deps = build();
    deps.prisma.uiConfig.findMany.mockResolvedValue([
      {
        targetKey: 'customer:home:global:all',
        version: 9,
        minAppVersion: '1.0.0',
        cdnUrl: 'https://cdn/global.json',
        publishedAt: new Date(),
        appType: 'customer',
        screenKey: 'home',
      },
      {
        targetKey: 'customer:home:city-1:repeat',
        version: 2,
        minAppVersion: '1.0.0',
        cdnUrl: 'https://cdn/specific.json',
        publishedAt: new Date(),
        appType: 'customer',
        screenKey: 'home',
      },
    ]);

    await expect(
      deps.service.resolve('city-1', 'repeat', '1.5.0'),
    ).resolves.toEqual(
      expect.objectContaining({
        resolvedTarget: 'customer:home:city-1:repeat',
        cdnUrl: 'https://cdn/specific.json',
      }),
    );
  });

  it('falls back to an older compatible published version for an old app', async () => {
    const deps = build();
    deps.prisma.uiConfig.findMany.mockResolvedValue([
      {
        targetKey: 'customer:home:global:all',
        version: 2,
        minAppVersion: '2.0.0',
        cdnUrl: 'https://cdn/v2.json',
        publishedAt: new Date(),
        appType: 'customer',
        screenKey: 'home',
      },
      {
        targetKey: 'customer:home:global:all',
        version: 1,
        minAppVersion: '0.0.0',
        cdnUrl: 'https://cdn/v1.json',
        publishedAt: new Date(),
        appType: 'customer',
        screenKey: 'home',
      },
    ]);

    await expect(
      deps.service.resolve(undefined, 'anonymous', '1.4.0'),
    ).resolves.toEqual(expect.objectContaining({ version: 1 }));
  });

  it('fails closed before writing S3 when CloudFront is unavailable', async () => {
    const deps = build();
    deps.cloudFront.configured = false;
    deps.prisma.uiConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      status: 'draft',
      jsonTree: { schemaVersion: 1, components: [] },
      minAppVersion: '0.0.0',
      targetKey: 'customer:home:global:all',
      cityId: null,
      userSegment: 'all',
      version: 1,
    });

    await expect(
      deps.service.publish(
        'config-1',
        'admin-1',
        'Initial global baseline publication',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(deps.s3.putCdnObject).not.toHaveBeenCalled();
  });
});
