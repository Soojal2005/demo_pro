import {
  ConflictException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type UiConfig } from '../../prisma/client';
import { apiError } from '../../common/utils';
import { CloudFrontService } from '../../cdn/cloudfront.service';
import { PrismaService } from '../../prisma/prisma.service';
import { S3Service } from '../../storage/s3.service';
import type {
  CreateUiConfigDto,
  UiConfigQueryDto,
  UpdateUiConfigDto,
} from './dto/ui-config.dto';
import {
  compareVersions,
  targetKeyFor,
  type UiSegment,
} from './ui-config.types';
import { UiTreeValidatorService } from './ui-tree-validator.service';

@Injectable()
export class UiConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: UiTreeValidatorService,
    private readonly s3: S3Service,
    private readonly cloudFront: CloudFrontService,
  ) {}

  list(query: UiConfigQueryDto) {
    return this.prisma.uiConfig.findMany({
      where: {
        ...(query.cityId ? { cityId: query.cityId } : {}),
        ...(query.segment ? { userSegment: query.segment } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: [{ targetKey: 'asc' }, { version: 'desc' }],
    });
  }

  async get(id: string): Promise<UiConfig> {
    const row = await this.prisma.uiConfig.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('UI config not found');
    return row;
  }

  async create(dto: CreateUiConfigDto, adminId: string): Promise<UiConfig> {
    await this.assertCity(dto.cityId);
    await this.validator.validate(dto.jsonTree, dto.minAppVersion);
    const targetKey = targetKeyFor(dto.cityId, dto.userSegment);
    const latest = await this.prisma.uiConfig.aggregate({
      where: { targetKey },
      _max: { version: true },
    });
    return this.prisma.uiConfig.create({
      data: {
        targetKey,
        cityId: dto.cityId ?? null,
        userSegment: dto.userSegment,
        version: (latest._max.version ?? 0) + 1,
        schemaVersion: 1,
        jsonTree: dto.jsonTree as Prisma.InputJsonValue,
        minAppVersion: dto.minAppVersion,
        createdByAdminId: adminId,
      },
    });
  }

  async update(id: string, dto: UpdateUiConfigDto): Promise<UiConfig> {
    const row = await this.get(id);
    if (row.status !== 'draft')
      throw new ConflictException('Published UI configs are immutable');
    const cityId = dto.cityId === undefined ? row.cityId : dto.cityId;
    const segment = dto.userSegment ?? row.userSegment;
    const jsonTree = dto.jsonTree ?? (row.jsonTree as Record<string, unknown>);
    const minAppVersion = dto.minAppVersion ?? row.minAppVersion;
    await this.assertCity(cityId ?? undefined);
    await this.validator.validate(jsonTree, minAppVersion);
    return this.prisma.uiConfig.update({
      where: { id },
      data: {
        cityId: cityId ?? null,
        userSegment: segment,
        targetKey: targetKeyFor(cityId, segment),
        jsonTree: jsonTree as Prisma.InputJsonValue,
        minAppVersion,
      },
    });
  }

  async validate(id: string) {
    const row = await this.get(id);
    return this.validator.validate(row.jsonTree, row.minAppVersion);
  }

  publish(id: string, adminId: string, reason: string) {
    return this.activate(id, adminId, reason, false);
  }

  rollback(id: string, adminId: string, reason: string) {
    return this.activate(id, adminId, reason, true);
  }

  async resolve(
    cityId: string | undefined,
    segment: UiSegment,
    appVersion: string,
  ) {
    try {
      compareVersions(appVersion, '0.0.0');
    } catch {
      throw apiError(
        'X-App-Version must use MAJOR.MINOR.PATCH',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (cityId) await this.assertCity(cityId);
    const targets = [
      ...(cityId
        ? [targetKeyFor(cityId, segment), targetKeyFor(cityId, 'all')]
        : []),
      targetKeyFor(null, segment),
      targetKeyFor(null, 'all'),
    ];
    const rows = await this.prisma.uiConfig.findMany({
      where: {
        targetKey: { in: [...new Set(targets)] },
        publishedAt: { not: null },
        cdnUrl: { not: null },
      },
      orderBy: { version: 'desc' },
    });
    for (const target of targets) {
      const compatible = rows.find(
        (row) =>
          row.targetKey === target &&
          compareVersions(row.minAppVersion, appVersion) <= 0,
      );
      if (compatible)
        return {
          appType: compatible.appType,
          screenKey: compatible.screenKey,
          segment,
          cityId: cityId ?? null,
          resolvedTarget: compatible.targetKey,
          version: compatible.version,
          minAppVersion: compatible.minAppVersion,
          cdnUrl: compatible.cdnUrl!,
          publishedAt: compatible.publishedAt!,
        };
    }
    throw new ServiceUnavailableException(
      'No compatible global UI configuration is published',
    );
  }

  private async activate(
    id: string,
    adminId: string,
    reason: string,
    rollback: boolean,
  ): Promise<UiConfig> {
    const row = await this.get(id);
    if (!rollback && row.status !== 'draft')
      throw new ConflictException('Only a draft can be published');
    if (rollback && !row.publishedAt)
      throw new ConflictException(
        'Only a previously published version can be rolled back',
      );
    await this.validator.validate(row.jsonTree, row.minAppVersion);
    if (!this.cloudFront.configured)
      throw new ServiceUnavailableException('CloudFront is not configured');
    const scope = row.cityId ?? 'global';
    const key = `ui-config/customer/home/${scope}/${row.userSegment}/v${row.version}.json`;
    await this.s3.putCdnObject(
      key,
      Buffer.from(JSON.stringify(row.jsonTree)),
      'application/json; charset=utf-8',
      'public, max-age=31536000, immutable',
    );
    const invalidatedAt = await this.cloudFront.invalidate([`/${key}`]);
    const cdnUrl = this.cloudFront.urlFor(key);
    const saved = await this.prisma.$transaction(async (tx) => {
      await tx.uiConfig.updateMany({
        where: { targetKey: row.targetKey, status: 'published' },
        data: { status: 'archived' },
      });
      return tx.uiConfig.update({
        where: { id },
        data: {
          status: 'published',
          cdnKey: key,
          cdnUrl,
          publishedByAdminId: adminId,
          publishedAt: new Date(),
          cacheInvalidatedAt: invalidatedAt,
          publicationReason: reason,
        },
      });
    });
    return saved;
  }

  private async assertCity(cityId?: string): Promise<void> {
    if (!cityId) return;
    const city = await this.prisma.city.findUnique({
      where: { id: cityId },
      select: { id: true },
    });
    if (!city) throw new NotFoundException('City not found');
  }
}
