import { HttpException } from '@nestjs/common';
import { UiTreeValidatorService } from './ui-tree-validator.service';

describe('UiTreeValidatorService', () => {
  const build = () => {
    const prisma = {
      serviceCategory: { findMany: jest.fn().mockResolvedValue([]) },
      service: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return { prisma, service: new UiTreeValidatorService(prisma as never) };
  };

  it('accepts the core component set and validates catalog references', async () => {
    const { prisma, service } = build();
    prisma.serviceCategory.findMany.mockResolvedValue([
      { slug: 'home-cleaning' },
    ]);
    const serviceId = '00000000-0000-4000-b000-000000000001';
    prisma.service.findMany.mockResolvedValue([{ id: serviceId }]);
    const result = await service.validate(
      {
        schemaVersion: 1,
        components: [
          {
            id: 'hero-banners',
            type: 'banner_carousel',
            items: [
              {
                imageUrl: 'https://cdn.example/banner.jpg',
                action: { type: 'category', target: 'home-cleaning' },
              },
            ],
          },
          {
            id: 'featured-services',
            type: 'service_carousel',
            serviceIds: [serviceId],
          },
          { id: 'intro-copy', type: 'text_block', text: 'Welcome home' },
          { id: 'section-gap', type: 'spacer', size: 'md' },
        ],
      },
      '1.0.0',
    );
    expect(result).toEqual(
      expect.objectContaining({ valid: true, componentCount: 4 }),
    );
  });

  it('rejects unknown components before publication', async () => {
    const { service } = build();
    await expect(
      service.validate(
        { schemaVersion: 1, components: [{ id: 'bad-one', type: 'html' }] },
        '1.0.0',
      ),
    ).rejects.toBeInstanceOf(HttpException);
  });

  it('rejects missing or inactive catalog references', async () => {
    const { service } = build();
    await expect(
      service.validate(
        {
          schemaVersion: 1,
          components: [
            {
              id: 'category-grid',
              type: 'category_grid',
              categorySlugs: ['missing'],
            },
          ],
        },
        '1.0.0',
      ),
    ).rejects.toThrow('missing or inactive catalog entries');
  });

  it('rejects invalid optional presentation properties', async () => {
    const { service } = build();
    await expect(
      service.validate(
        {
          schemaVersion: 1,
          components: [
            {
              id: 'category-grid',
              type: 'category_grid',
              categorySlugs: ['home-cleaning'],
              columns: 9,
            },
          ],
        },
        '1.0.0',
      ),
    ).rejects.toThrow('columns must be 2, 3, or 4');
  });
});
