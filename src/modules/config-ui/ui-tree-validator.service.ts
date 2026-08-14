import { HttpStatus, Injectable } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';
import { parseVersion } from './ui-config.types';

const TYPES = new Set([
  'banner_carousel',
  'category_grid',
  'service_carousel',
  'text_block',
  'spacer',
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPONENT_KEYS: Record<string, Set<string>> = {
  banner_carousel: new Set(['id', 'type', 'items']),
  category_grid: new Set(['id', 'type', 'title', 'categorySlugs', 'columns']),
  service_carousel: new Set(['id', 'type', 'title', 'serviceIds']),
  text_block: new Set(['id', 'type', 'text', 'style']),
  spacer: new Set(['id', 'type', 'size']),
};

@Injectable()
export class UiTreeValidatorService {
  constructor(private readonly prisma: PrismaService) {}

  async validate(tree: unknown, minAppVersion: string) {
    try {
      parseVersion(minAppVersion);
    } catch {
      throw apiError(
        'minAppVersion must use MAJOR.MINOR.PATCH',
        HttpStatus.BAD_REQUEST,
      );
    }
    const encoded = JSON.stringify(tree);
    if (!encoded || Buffer.byteLength(encoded) > 256 * 1024)
      throw apiError('UI tree must be at most 256 KB', HttpStatus.BAD_REQUEST);
    if (!isObject(tree) || tree.schemaVersion !== 1)
      throw apiError('UI tree schemaVersion must be 1', HttpStatus.BAD_REQUEST);
    if (!Array.isArray(tree.components) || tree.components.length > 50)
      throw apiError(
        'UI tree components must be an array of at most 50 items',
        HttpStatus.BAD_REQUEST,
      );

    const ids = new Set<string>();
    const categorySlugs = new Set<string>();
    const serviceIds = new Set<string>();
    tree.components.forEach((raw, index) => {
      if (!isObject(raw)) this.invalid(index, 'must be an object');
      const id = raw.id;
      const type = raw.type;
      if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(id))
        this.invalid(index, 'has an invalid id');
      if (ids.has(id)) this.invalid(index, `duplicates id ${id}`);
      ids.add(id);
      if (typeof type !== 'string' || !TYPES.has(type))
        this.invalid(index, `has unsupported type ${String(type)}`);
      const unknown = Object.keys(raw).find(
        (key) => !COMPONENT_KEYS[type].has(key),
      );
      if (unknown) this.invalid(index, `contains unknown property ${unknown}`);
      this.validateComponent(raw, index, categorySlugs, serviceIds);
    });

    const [categories, services] = await Promise.all([
      this.prisma.serviceCategory.findMany({
        where: { slug: { in: [...categorySlugs] }, isActive: true },
        select: { slug: true },
      }),
      this.prisma.service.findMany({
        where: { id: { in: [...serviceIds] }, isActive: true },
        select: { id: true },
      }),
    ]);
    const foundCategories = new Set(categories.map((row) => row.slug));
    const foundServices = new Set(services.map((row) => row.id));
    const missingCategories = [...categorySlugs].filter(
      (slug) => !foundCategories.has(slug),
    );
    const missingServices = [...serviceIds].filter(
      (id) => !foundServices.has(id),
    );
    if (missingCategories.length || missingServices.length)
      throw apiError(
        'UI tree references missing or inactive catalog entries',
        HttpStatus.BAD_REQUEST,
        [
          ...missingCategories.map((slug) => ({
            field: 'jsonTree',
            message: `Category ${slug} is unavailable`,
            code: 'CATEGORY_UNAVAILABLE',
          })),
          ...missingServices.map((id) => ({
            field: 'jsonTree',
            message: `Service ${id} is unavailable`,
            code: 'SERVICE_UNAVAILABLE',
          })),
        ],
      );
    return {
      valid: true,
      schemaVersion: 1,
      componentCount: tree.components.length,
      bytes: Buffer.byteLength(encoded),
      categorySlugs: [...categorySlugs],
      serviceIds: [...serviceIds],
    };
  }

  private validateComponent(
    component: Record<string, unknown>,
    index: number,
    categories: Set<string>,
    services: Set<string>,
  ): void {
    if (component.type === 'category_grid') {
      this.stringArray(component.categorySlugs, index, 'categorySlugs').forEach(
        (slug) => {
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
            this.invalid(index, `contains invalid category slug ${slug}`);
          categories.add(slug);
        },
      );
    } else if (component.type === 'service_carousel') {
      this.stringArray(component.serviceIds, index, 'serviceIds').forEach(
        (id) => {
          if (!UUID.test(id))
            this.invalid(index, `contains invalid service id ${id}`);
          services.add(id);
        },
      );
    } else if (component.type === 'banner_carousel') {
      if (!Array.isArray(component.items) || component.items.length === 0)
        this.invalid(index, 'requires banner items');
      component.items.forEach((item) => {
        if (!isObject(item) || typeof item.imageUrl !== 'string')
          this.invalid(index, 'contains an invalid banner');
        this.httpsUrl(item.imageUrl, index);
        const unknown = Object.keys(item).find(
          (key) => !['imageUrl', 'accessibilityLabel', 'action'].includes(key),
        );
        if (unknown)
          this.invalid(index, `banner contains unknown property ${unknown}`);
        if (
          item.accessibilityLabel !== undefined &&
          (typeof item.accessibilityLabel !== 'string' ||
            item.accessibilityLabel.length === 0 ||
            item.accessibilityLabel.length > 200)
        )
          this.invalid(index, 'banner has an invalid accessibilityLabel');
        if (item.action !== undefined)
          this.action(item.action, index, categories, services);
      });
    } else if (
      component.type === 'text_block' &&
      (typeof component.text !== 'string' || component.text.length > 2000)
    ) {
      this.invalid(index, 'requires text up to 2000 characters');
    } else if (
      component.type === 'text_block' &&
      component.style !== undefined &&
      (typeof component.style !== 'string' ||
        !['heading', 'body', 'caption'].includes(component.style))
    ) {
      this.invalid(index, 'text style must be heading, body, or caption');
    } else if (
      component.type === 'spacer' &&
      !['sm', 'md', 'lg'].includes(String(component.size))
    ) {
      this.invalid(index, 'spacer size must be sm, md, or lg');
    }
    if (
      (component.type === 'category_grid' ||
        component.type === 'service_carousel') &&
      component.title !== undefined &&
      (typeof component.title !== 'string' || component.title.length > 120)
    )
      this.invalid(index, 'title must be a string up to 120 characters');
    if (
      component.type === 'category_grid' &&
      component.columns !== undefined &&
      ![2, 3, 4].includes(Number(component.columns))
    )
      this.invalid(index, 'columns must be 2, 3, or 4');
  }

  private action(
    raw: unknown,
    index: number,
    categories: Set<string>,
    services: Set<string>,
  ): void {
    if (
      !isObject(raw) ||
      typeof raw.type !== 'string' ||
      typeof raw.target !== 'string'
    )
      this.invalid(index, 'contains an invalid action');
    const unknown = Object.keys(raw).find(
      (key) => !['type', 'target'].includes(key),
    );
    if (unknown)
      this.invalid(index, `action contains unknown property ${unknown}`);
    if (raw.type === 'category') {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.target))
        this.invalid(index, 'action contains an invalid category slug');
      categories.add(raw.target);
    } else if (raw.type === 'service') {
      if (!UUID.test(raw.target))
        this.invalid(index, 'action contains an invalid service id');
      services.add(raw.target);
    } else if (raw.type === 'url') this.httpsUrl(raw.target, index);
    else this.invalid(index, 'contains an unsupported action');
  }

  private stringArray(raw: unknown, index: number, field: string): string[] {
    if (
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.some((v) => typeof v !== 'string')
    )
      this.invalid(index, `requires a non-empty ${field} string array`);
    return raw as string[];
  }

  private httpsUrl(value: string, index: number): void {
    try {
      if (new URL(value).protocol !== 'https:') throw new Error();
    } catch {
      this.invalid(index, 'contains a non-HTTPS URL');
    }
  }

  private invalid(index: number, detail: string): never {
    throw apiError(`Component ${index} ${detail}`, HttpStatus.BAD_REQUEST);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
