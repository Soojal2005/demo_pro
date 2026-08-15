import { HttpStatus, Injectable } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type { Service, ServiceCategory } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { BOOKING_TYPE_COLUMN } from './catalog.types';
import type { CategoryTreeNode, CommissionType } from './catalog.types';
import { BrowseServicesQueryDto } from './dto/browse-services-query.dto';
import type { CatalogueDto, CatalogueServiceDto } from './dto/catalogue.dto';

/** The rate module 8 snapshots onto `BookingCommission` at completion. */
export interface CommissionConfig {
  commissionType: CommissionType;
  commissionValue: string;
}

/** A `Service` with the commission configuration removed. */
export type PublicService = Omit<Service, 'commissionType' | 'commissionValue'>;

/**
 * A service in the shape the customer app draws a card from.
 *
 * Commission is absent for the same reason it is absent from `PublicService`,
 * and the price is a number because this payload is for rendering — see
 * `CatalogueServiceDto`.
 */
export function toCatalogueService(service: Service): CatalogueServiceDto {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    price: Number(service.flatPrice.toString()),
    durationMinutes: service.durationMinutes,
    supportsInstant: service.supportsInstant,
    supportsScheduled: service.supportsScheduled,
    supportsRecurring: service.supportsRecurring,
    allowsCash: service.allowsCash,
  };
}

/**
 * Strips the commission fields before a service reaches a customer.
 *
 * US-3.2: "the platform/Pro split never appears on any customer-facing
 * surface." `ServiceDto` documents that correctly, but a DTO in this codebase
 * is Swagger metadata — it does not filter at runtime, and the controller
 * returns whatever the service hands it. Without this the margin on every
 * service was readable by anyone, unauthenticated.
 */
export function toPublicService(service: Service): PublicService {
  return {
    id: service.id,
    createdAt: service.createdAt,
    updatedAt: service.updatedAt,
    categoryId: service.categoryId,
    name: service.name,
    description: service.description,
    durationMinutes: service.durationMinutes,
    flatPrice: service.flatPrice,
    supportsInstant: service.supportsInstant,
    supportsScheduled: service.supportsScheduled,
    supportsRecurring: service.supportsRecurring,
    isActive: service.isActive,
    // Public on purpose: the app has to know which payment modes to offer
    // before the customer picks one, and `paymentMode` is frozen at creation.
    // It says nothing about margin, so it is not in the same class as the two
    // fields above it that are stripped.
    allowsCash: service.allowsCash,
  };
}

/**
 * The read half of the Service Catalog, and the module's public interface to
 * the rest of the system.
 *
 * Nothing outside `src/modules/catalog/` reads `service` or `serviceCategory`
 * through Prisma directly — Booking, Dispatch, Commission and Pro Management
 * all come through here. That is the module boundary the architecture note
 * asks for, and it is what makes a later extraction possible.
 */
@Injectable()
export class ServiceCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------------------------------------------
  // Customer-facing browse
  // ------------------------------------------------------------------

  /**
   * The whole browse tree in one round trip: active roots, their active
   * children, and the active services filed under each.
   *
   * Assembled in memory rather than with nested Prisma includes because the
   * national catalogue is tens-to-hundreds of rows and two flat queries beat
   * a recursive fetch at that size — and stay a fixed shape as the tree grows.
   */
  async getCategoryTree(): Promise<CategoryTreeNode[]> {
    const [categories, services] = await Promise.all([
      this.prisma.serviceCategory.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.service.findMany({
        where: { isActive: true, category: { isActive: true } },
        orderBy: { name: 'asc' },
      }),
    ]);

    const servicesByCategory = new Map<string, PublicService[]>();
    for (const service of services) {
      const publicService = toPublicService(service);
      const bucket = servicesByCategory.get(service.categoryId);
      if (bucket) bucket.push(publicService);
      else servicesByCategory.set(service.categoryId, [publicService]);
    }

    const toNode = (category: ServiceCategory): CategoryTreeNode => ({
      ...category,
      children: [],
      services: servicesByCategory.get(category.id) ?? [],
    });

    const nodeById = new Map(
      categories.map((category) => [category.id, toNode(category)]),
    );

    const roots: CategoryTreeNode[] = [];
    for (const category of categories) {
      const node = nodeById.get(category.id)!;
      if (!category.parentCategoryId) {
        roots.push(node);
        continue;
      }
      // A child whose parent is inactive is not reachable by browsing. It is
      // dropped rather than promoted to a root — silently re-parenting it to
      // the top of the home screen would be worse than hiding it.
      nodeById.get(category.parentCategoryId)?.children.push(node);
    }

    return roots;
  }

  /**
   * The whole browsable catalogue, flat, in one request.
   *
   * What the customer app opens on. `getCategoryTree` answers the shape of the
   * catalogue; this answers what can be drawn right now — and does it in a
   * single round trip, because the alternative on a first screen is a tree
   * fetch plus one services call per category.
   *
   * A shelf's services roll UP into its trade as well as appearing under the
   * shelf, so tapping either shows something. `directCount` keeps the
   * distinction visible to anyone who needs it.
   */
  async getCatalogue(): Promise<CatalogueDto> {
    const [categories, services] = await Promise.all([
      this.prisma.serviceCategory.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.service.findMany({
        where: { isActive: true, category: { isActive: true } },
        orderBy: { name: 'asc' },
      }),
    ]);

    const directByCategory = new Map<string, CatalogueServiceDto[]>();
    for (const service of services) {
      const bucket = directByCategory.get(service.categoryId);
      const mapped = toCatalogueService(service);
      if (bucket) bucket.push(mapped);
      else directByCategory.set(service.categoryId, [mapped]);
    }

    const slugById = new Map(
      categories.map((category) => [category.id, category.slug]),
    );
    const childrenById = new Map<string, string[]>();
    for (const category of categories) {
      const parentId = category.parentCategoryId;
      // A child whose parent is inactive is unreachable by browsing, and
      // `slugById` is the check for that: it only holds active categories.
      if (!parentId || !slugById.has(parentId)) continue;
      const bucket = childrenById.get(parentId);
      if (bucket) bucket.push(category.id);
      else childrenById.set(parentId, [category.id]);
    }

    /* Depth is two today. Written to recurse anyway, so a third level is a
       schema decision rather than a bug that silently drops a shelf. */
    const rollUp = (
      categoryId: string,
      seen: Set<string>,
    ): CatalogueServiceDto[] => {
      if (seen.has(categoryId)) return [];
      seen.add(categoryId);

      const own = directByCategory.get(categoryId) ?? [];
      const beneath = (childrenById.get(categoryId) ?? []).flatMap((childId) =>
        rollUp(childId, seen),
      );
      return [...own, ...beneath];
    };

    return {
      categories: categories.map((category) => ({
        id: category.id,
        name: category.name,
        slug: category.slug,
        sortOrder: category.sortOrder,
        parentSlug: category.parentCategoryId
          ? (slugById.get(category.parentCategoryId) ?? null)
          : null,
        directCount: (directByCategory.get(category.id) ?? []).length,
        services: rollUp(category.id, new Set()),
      })),
      // Counted from the query, not by summing the categories above — a
      // service that rolls up into a trade is listed twice there.
      total: services.length,
    };
  }

  /**
   * Flat, filterable list of bookable services. Only active services under an
   * active category — the two flags are independent and both must be on.
   */
  async listServices(query: BrowseServicesQueryDto): Promise<PublicService[]> {
    const { categoryId, q, bookingType } = query;

    const services = await this.prisma.service.findMany({
      where: {
        isActive: true,
        category: { isActive: true },
        ...(categoryId ? { categoryId } : {}),
        ...(bookingType ? { [BOOKING_TYPE_COLUMN[bookingType]]: true } : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' as const } },
                { description: { contains: q, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { name: 'asc' },
    });

    return services.map(toPublicService);
  }

  /** Active services in one category, for the category drill-down screen. */
  async listServicesInCategory(categoryId: string): Promise<PublicService[]> {
    await this.getCategoryOrFail(categoryId);
    return this.listServices({ categoryId });
  }

  // ------------------------------------------------------------------
  // Lookup — used by this module and by every consumer of the catalog
  // ------------------------------------------------------------------

  /**
   * Resolves a service **whether or not it is active**.
   *
   * US-3.1: an inactive service vanishes from browse but must stay resolvable
   * by id, or a customer's past booking loses the name of what they bought.
   */
  findServiceById(id: string): Promise<Service | null> {
    return this.prisma.service.findUnique({ where: { id } });
  }

  /**
   * The customer-facing by-id read. Same resolution rules as
   * {@link getServiceOrFail} — inactive services still resolve, so a past
   * booking can render what was bought — but with commission stripped.
   */
  async getPublicServiceOrFail(id: string): Promise<PublicService> {
    return toPublicService(await this.getServiceOrFail(id));
  }

  /**
   * Internal lookup. Returns the **full** row including commission, so only
   * admin routes and other modules may use it — never a customer response.
   */
  async getServiceOrFail(id: string): Promise<Service> {
    const service = await this.findServiceById(id);
    if (!service) throw apiError('Service not found', HttpStatus.NOT_FOUND);
    return service;
  }

  /**
   * The gate every booking-creating path must pass through: the service
   * exists, is live, and sits under a live category.
   *
   * Deliberately distinct from {@link getServiceOrFail} — "no such service"
   * (404) and "that service is not currently bookable" (409) are different
   * answers, and collapsing them makes both harder to act on.
   */
  async assertBookable(serviceId: string): Promise<Service> {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      include: { category: true },
    });
    if (!service) throw apiError('Service not found', HttpStatus.NOT_FOUND);

    if (!service.isActive || !service.category.isActive) {
      throw apiError(
        'This service is not currently available for booking',
        HttpStatus.CONFLICT,
        [
          {
            field: 'serviceId',
            message: 'Service is inactive',
            code: 'SERVICE_INACTIVE',
          },
        ],
      );
    }

    return service;
  }

  /**
   * Expected job length, for Dispatch slot sizing and ETA (module 5).
   *
   * This is the *only* downstream use of duration. It is explicitly not a
   * commission input — see CONFLICTS_AND_DECISIONS #7.
   */
  async getDurationMinutes(serviceId: string): Promise<number> {
    const service = await this.getServiceOrFail(serviceId);
    return service.durationMinutes;
  }

  /**
   * The commission rate module 8 snapshots onto `BookingCommission`.
   *
   * Throws if the rate is missing. That should be unreachable — a service
   * cannot be activated without one, and the database carries the same
   * constraint — but discovering it at completion time, when a Pro has already
   * done the work, is the worst possible place to find out (US-3.11).
   */
  async getCommissionConfig(serviceId: string): Promise<CommissionConfig> {
    const service = await this.getServiceOrFail(serviceId);

    if (!service.commissionType || service.commissionValue === null) {
      throw apiError(
        'Service has no commission rate configured',
        HttpStatus.CONFLICT,
        [
          {
            field: 'commissionType',
            message: 'Commission rate is not set for this service',
            code: 'COMMISSION_RATE_MISSING',
          },
        ],
      );
    }

    return {
      commissionType: service.commissionType as CommissionType,
      commissionValue: service.commissionValue.toString(),
    };
  }

  private async getCategoryOrFail(id: string): Promise<ServiceCategory> {
    const category = await this.prisma.serviceCategory.findUnique({
      where: { id },
    });
    if (!category) throw apiError('Category not found', HttpStatus.NOT_FOUND);
    return category;
  }
}
