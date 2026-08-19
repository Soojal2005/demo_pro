import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ServiceCatalogService,
  toPublicService,
} from './service-catalog.service';

function buildDeps() {
  const prisma = {
    serviceCategory: { findMany: jest.fn(), findUnique: jest.fn() },
    service: { findMany: jest.fn(), findUnique: jest.fn() },
  };
  return { prisma };
}

function buildService(
  deps: ReturnType<typeof buildDeps>,
): ServiceCatalogService {
  return new ServiceCatalogService(deps.prisma as never);
}

async function captureStatus(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : -1;
  }
  throw new Error('Expected the call to reject, but it resolved');
}

const root = {
  id: 'root',
  name: 'Home Cleaning',
  slug: 'home-cleaning',
  sortOrder: 1,
  isActive: true,
  parentCategoryId: null,
};
const child = {
  id: 'child',
  name: 'Deep Cleaning',
  slug: 'deep-cleaning',
  sortOrder: 1,
  isActive: true,
  parentCategoryId: 'root',
};
const orphan = {
  id: 'orphan',
  name: 'Orphaned',
  slug: 'orphaned',
  sortOrder: 9,
  isActive: true,
  // Parent exists but is inactive, so it is absent from the active query.
  parentCategoryId: 'hidden-parent',
};

describe('ServiceCatalogService', () => {
  /*
   * The customer app's opening payload. It asked for `/catalogue` from day one
   * and the route did not exist, so `fetchCatalogue` — which never throws —
   * fell through to the bundled seed file on every launch. The app looked
   * entirely normal and only failed at checkout, where the seed's slug keys
   * were rejected as "serviceId must be a UUID".
   */
  describe('getCatalogue', () => {
    const svc = (id: string, categoryId: string) => ({
      id,
      categoryId,
      name: id,
      description: null,
      flatPrice: { toString: () => '699.00' },
      durationMinutes: 60,
      supportsInstant: true,
      supportsScheduled: true,
      supportsRecurring: false,
      allowsCash: true,
    });

    it('rolls a shelf’s services up into its trade, and keeps the direct count', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findMany.mockResolvedValue([root, child]);
      deps.prisma.service.findMany.mockResolvedValue([
        svc('svc-1', 'child'),
        svc('svc-2', 'root'),
      ]);
      const service = buildService(deps);

      const { categories, total } = await service.getCatalogue();

      const trade = categories.find((c) => c.id === 'root')!;
      const shelf = categories.find((c) => c.id === 'child')!;

      // The trade shows everything beneath it...
      expect(trade.services.map((s) => s.id).sort()).toEqual([
        'svc-1',
        'svc-2',
      ]);
      // ...but only counts what is filed directly on it.
      expect(trade.directCount).toBe(1);
      expect(shelf.services.map((s) => s.id)).toEqual(['svc-1']);
      expect(shelf.parentSlug).toBe('home-cleaning');
      expect(trade.parentSlug).toBeNull();

      // Counted from the query — summing the categories would count `svc-1`
      // twice, once on the shelf and once rolled up.
      expect(total).toBe(2);
    });

    it('prices as a number the client can render, and hides commission', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findMany.mockResolvedValue([root]);
      deps.prisma.service.findMany.mockResolvedValue([
        {
          ...svc('svc-1', 'root'),
          commissionType: 'percentage',
          commissionValue: { toString: () => '20' },
        },
      ]);
      const service = buildService(deps);

      const { categories } = await service.getCatalogue();
      const [only] = categories[0].services;

      expect(only.price).toBe(699);
      // US-3.2: the platform/Pro split never reaches a customer surface.
      expect(only).not.toHaveProperty('commissionType');
      expect(only).not.toHaveProperty('commissionValue');
    });

    it('does not re-parent a shelf whose trade is switched off', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findMany.mockResolvedValue([orphan]);
      deps.prisma.service.findMany.mockResolvedValue([svc('svc-1', 'orphan')]);
      const service = buildService(deps);

      const { categories } = await service.getCatalogue();

      // Still listed in its own right, but not claiming a parent that is not
      // browsable — a dangling slug would be a tile leading nowhere.
      expect(categories).toHaveLength(1);
      expect(categories[0].parentSlug).toBeNull();
    });
  });

  describe('getCategoryTree', () => {
    it('nests children under their root and files services on the right node', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findMany.mockResolvedValue([root, child]);
      deps.prisma.service.findMany.mockResolvedValue([
        { id: 'svc-1', categoryId: 'child', name: 'Deep Clean 2BHK' },
        { id: 'svc-2', categoryId: 'root', name: 'Standard Clean' },
      ]);
      const service = buildService(deps);

      const tree = await service.getCategoryTree();

      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe('root');
      expect(tree[0].services.map((s) => s.id)).toEqual(['svc-2']);
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].services.map((s) => s.id)).toEqual(['svc-1']);
    });

    it('drops a child whose parent is inactive rather than promoting it to a root', async () => {
      const deps = buildDeps();
      // `hidden-parent` is inactive, so the active-only query never returns it.
      deps.prisma.serviceCategory.findMany.mockResolvedValue([root, orphan]);
      deps.prisma.service.findMany.mockResolvedValue([]);
      const service = buildService(deps);

      const tree = await service.getCategoryTree();

      expect(tree.map((node) => node.id)).toEqual(['root']);
    });

    it('returns a leaf with empty children and services rather than omitting them', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findMany.mockResolvedValue([root]);
      deps.prisma.service.findMany.mockResolvedValue([]);
      const service = buildService(deps);

      const [node] = await service.getCategoryTree();

      expect(node.children).toEqual([]);
      expect(node.services).toEqual([]);
    });
  });

  describe('findServiceById — US-3.1', () => {
    it('resolves an inactive service, so past bookings still render a name', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue({
        id: 'svc-retired',
        name: 'Retired Service',
        isActive: false,
      });
      const service = buildService(deps);

      const found = await service.getServiceOrFail('svc-retired');

      expect(found.name).toBe('Retired Service');
      // No isActive filter — that is the whole point of this path.
      expect(deps.prisma.service.findUnique).toHaveBeenCalledWith({
        where: { id: 'svc-retired' },
      });
    });

    it('404s for an unknown id', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(
        captureStatus(service.getServiceOrFail('nope')),
      ).resolves.toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('assertBookable', () => {
    it('404s for a service that does not exist', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue(null);
      const service = buildService(deps);

      await expect(captureStatus(service.assertBookable('nope'))).resolves.toBe(
        HttpStatus.NOT_FOUND,
      );
    });

    it('409s — not 404s — for a service that exists but is inactive', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue({
        id: 'svc-1',
        isActive: false,
        category: { isActive: true },
      });
      const service = buildService(deps);

      await expect(
        captureStatus(service.assertBookable('svc-1')),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });

    it('409s when the service is live but its category is not', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue({
        id: 'svc-1',
        isActive: true,
        category: { isActive: false },
      });
      const service = buildService(deps);

      await expect(
        captureStatus(service.assertBookable('svc-1')),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });

    it('passes when both are active', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue({
        id: 'svc-1',
        isActive: true,
        category: { isActive: true },
      });
      const service = buildService(deps);

      await expect(service.assertBookable('svc-1')).resolves.toMatchObject({
        id: 'svc-1',
      });
    });
  });

  describe('getCommissionConfig', () => {
    it('returns the rate as a string, never a float', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue({
        id: 'svc-1',
        commissionType: 'percent',
        // Prisma hands back a Decimal; only its toString is contractual.
        commissionValue: { toString: () => '30.00' },
      });
      const service = buildService(deps);

      await expect(service.getCommissionConfig('svc-1')).resolves.toEqual({
        commissionType: 'percent',
        commissionValue: '30.00',
      });
    });

    it('409s rather than returning a half-configured rate', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue({
        id: 'svc-1',
        commissionType: 'percent',
        commissionValue: null,
      });
      const service = buildService(deps);

      await expect(
        captureStatus(service.getCommissionConfig('svc-1')),
      ).resolves.toBe(HttpStatus.CONFLICT);
    });
  });

  describe('listServices', () => {
    it('filters to active services under active categories', async () => {
      const deps = buildDeps();
      deps.prisma.service.findMany.mockResolvedValue([]);
      const service = buildService(deps);

      await service.listServices({});

      expect(deps.prisma.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: true,
            category: { isActive: true },
          }),
        }),
      );
    });

    it('maps a booking-type filter onto the supports* column', async () => {
      const deps = buildDeps();
      deps.prisma.service.findMany.mockResolvedValue([]);
      const service = buildService(deps);

      await service.listServices({ bookingType: 'recurring' });

      expect(deps.prisma.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ supportsRecurring: true }),
        }),
      );
    });

    it('searches name and description case-insensitively', async () => {
      const deps = buildDeps();
      deps.prisma.service.findMany.mockResolvedValue([]);
      const service = buildService(deps);

      await service.listServices({ q: 'clean' });

      expect(deps.prisma.service.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              { name: { contains: 'clean', mode: 'insensitive' } },
              { description: { contains: 'clean', mode: 'insensitive' } },
            ],
          }),
        }),
      );
    });
  });

  describe('getDurationMinutes', () => {
    it('returns the value Dispatch sizes slots from', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue({
        id: 'svc-1',
        durationMinutes: 90,
      });
      const service = buildService(deps);

      await expect(service.getDurationMinutes('svc-1')).resolves.toBe(90);
    });
  });

  describe('commission never reaches a customer — US-3.2', () => {
    const withCommission = {
      id: 'svc-1',
      categoryId: 'cat-1',
      name: 'Bathroom Deep Clean',
      flatPrice: '699.00',
      commissionType: 'percent',
      commissionValue: '35.00',
      isActive: true,
    };

    it('strips both commission fields from a service', () => {
      const publicShape = toPublicService(withCommission as never);

      expect(publicShape).not.toHaveProperty('commissionType');
      expect(publicShape).not.toHaveProperty('commissionValue');
      // Everything a customer legitimately needs survives.
      expect(publicShape).toMatchObject({
        name: 'Bathroom Deep Clean',
        flatPrice: '699.00',
      });
    });

    it('strips it from the browse list', async () => {
      const deps = buildDeps();
      deps.prisma.service.findMany.mockResolvedValue([withCommission]);
      const service = buildService(deps);

      const [first] = await service.listServices({});

      expect(first).not.toHaveProperty('commissionValue');
    });

    it('strips it from the browse tree', async () => {
      const deps = buildDeps();
      deps.prisma.serviceCategory.findMany.mockResolvedValue([
        { id: 'cat-1', parentCategoryId: null, isActive: true },
      ]);
      deps.prisma.service.findMany.mockResolvedValue([withCommission]);
      const service = buildService(deps);

      const [node] = await service.getCategoryTree();

      expect(node.services[0]).not.toHaveProperty('commissionValue');
    });

    it('strips it from the by-id read', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue(withCommission);
      const service = buildService(deps);

      const found = await service.getPublicServiceOrFail('svc-1');

      expect(found).not.toHaveProperty('commissionType');
    });

    it('still returns it on the internal lookup other modules use', async () => {
      const deps = buildDeps();
      deps.prisma.service.findUnique.mockResolvedValue(withCommission);
      const service = buildService(deps);

      // Commission has to reach module 8 — it just must not reach a customer.
      await expect(service.getServiceOrFail('svc-1')).resolves.toHaveProperty(
        'commissionValue',
      );
    });
  });
});
