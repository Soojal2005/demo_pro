import {
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Prisma } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { apiError } from '../../common/utils';
import { ProsService } from '../pros/pros.service';
import { ProServiceAssignmentsService } from '../pros/pro-service-assignments.service';
import type {
  AdminAnalyticsQueryDto,
  CreateBulkJobDto,
  CreateReportExportDto,
} from './dto/admin.dto';
import { AdminAnalyticsService } from './admin-analytics.service';
import { ReportArtifactService } from './report-artifact.service';
import { PermissionCode } from '../identity/constants/permission-code';

interface StoredBulk extends CreateBulkJobDto {
  allowedCityIds: string[];
}
interface StoredReport extends CreateReportExportDto {
  allowedCityIds: string[];
  asOf: string;
}

@Injectable()
export class AdminJobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdminJobsService.name);
  private timer?: NodeJS.Timeout;
  private working = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pros: ProsService,
    private readonly assignments: ProServiceAssignmentsService,
    private readonly analytics: AdminAnalyticsService,
    private readonly artifacts: ReportArtifactService,
  ) {}

  onModuleInit(): void {
    void this.recoverInterruptedJobs();
    this.timer = setInterval(() => void this.tick(), 2000);
    this.timer.unref();
  }
  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async createBulk(
    dto: CreateBulkJobDto,
    adminId: string,
    allowedCityIds: string[] | undefined,
    requesterIp?: string,
  ) {
    const pros = await this.prisma.pro.findMany({
      where: { id: { in: dto.proIds } },
      select: { id: true, cityId: true },
    });
    if (pros.length !== dto.proIds.length)
      throw apiError('One or more Pros do not exist', HttpStatus.BAD_REQUEST);
    if (
      allowedCityIds?.length &&
      pros.some((pro) => !pro.cityId || !allowedCityIds.includes(pro.cityId))
    )
      throw apiError(
        'One or more Pros are outside your city scope',
        HttpStatus.FORBIDDEN,
      );
    const filter: StoredBulk = { ...dto, allowedCityIds: allowedCityIds ?? [] };
    return this.prisma.adminJob.create({
      data: {
        adminUserId: adminId,
        jobType: 'bulk_update',
        targetEntity: dto.targetEntity,
        filterJson: filter as unknown as Prisma.InputJsonValue,
        changesJson: {
          isAvailable: dto.isAvailable,
          isActive: dto.isActive,
          serviceId: dto.serviceId,
        },
        totalCount: dto.proIds.length,
        requesterIp,
      },
    });
  }

  async createReport(
    dto: CreateReportExportDto,
    adminId: string,
    allowedCityIds: string[] | undefined,
    requesterIp?: string,
  ) {
    this.analytics.scopedCities(dto.cityIds, allowedCityIds);
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: { role: { select: { permissionCodes: true } } },
    });
    const permissions =
      (admin?.role.permissionCodes as string[] | undefined) ?? [];
    const required =
      dto.type === 'commission'
        ? PermissionCode.PAYOUT_READ
        : dto.type === 'retention'
          ? PermissionCode.CUSTOMER_READ
          : PermissionCode.BOOKING_READ;
    if (!permissions.includes(required))
      throw apiError(`Report type requires ${required}`, HttpStatus.FORBIDDEN);
    const asOf = new Date().toISOString();
    // Freeze an omitted upper bound at submission time so a queued export is
    // reproducible even when the worker starts later.
    const filter: StoredReport = {
      ...dto,
      to: dto.to ?? asOf,
      allowedCityIds: allowedCityIds ?? [],
      asOf,
    };
    return this.prisma.adminJob.create({
      data: {
        adminUserId: adminId,
        jobType: 'report_export',
        targetEntity: dto.type,
        filterJson: filter as unknown as Prisma.InputJsonValue,
        format: dto.format,
        requesterIp,
      },
    });
  }

  async list(
    adminId: string,
    query: { jobType?: string; status?: string; take?: number },
  ) {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: { role: { select: { name: true } } },
    });
    return this.prisma.adminJob.findMany({
      where: {
        ...(admin?.role.name === 'super_admin' ? {} : { adminUserId: adminId }),
        ...(query.jobType ? { jobType: query.jobType } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.take ?? 50,
    });
  }

  async get(id: string, adminId: string) {
    const job = await this.prisma.adminJob.findUnique({
      where: { id },
      include: {
        adminUser: {
          select: {
            id: true,
            fullName: true,
            role: { select: { name: true } },
          },
        },
      },
    });
    if (!job) throw new NotFoundException('Admin job not found');
    const requester = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      select: { role: { select: { name: true } } },
    });
    if (job.adminUserId !== adminId && requester?.role.name !== 'super_admin')
      throw new NotFoundException('Admin job not found');
    return job;
  }

  async download(id: string, adminId: string) {
    const job = await this.get(id, adminId);
    if (!job.resultFileKey)
      throw apiError('Job artifact is not ready', HttpStatus.CONFLICT);
    return {
      ...(await this.artifacts.download(job.resultFileKey)),
      fileName: `${job.targetEntity}-${job.id}.${job.format ?? 'csv'}`,
    };
  }

  private async tick(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      const queued = await this.prisma.adminJob.findFirst({
        where: { status: 'queued' },
        orderBy: { createdAt: 'asc' },
      });
      if (!queued) return;
      const claimed = await this.prisma.adminJob.updateMany({
        where: { id: queued.id, status: 'queued' },
        data: { status: 'running', startedAt: new Date() },
      });
      if (!claimed.count) return;
      try {
        await this.process(queued.id);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown worker error';
        this.logger.error(`Admin job ${queued.id} failed: ${message}`);
        await this.prisma.adminJob.update({
          where: { id: queued.id },
          data: {
            status: 'failed',
            failureReason: message.slice(0, 1000),
            completedAt: new Date(),
          },
        });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown database error';
      this.logger.error(
        `Admin job worker tick failed; retrying on the next interval: ${message}`,
      );
    } finally {
      this.working = false;
    }
  }

  private async recoverInterruptedJobs(): Promise<void> {
    try {
      await this.prisma.adminJob.updateMany({
        where: {
          status: 'running',
          startedAt: { lt: new Date(Date.now() - 60 * 60_000) },
        },
        data: {
          status: 'queued',
          startedAt: null,
          failureReason: 'Recovered after an interrupted worker',
        },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown database error';
      this.logger.error(
        `Could not recover interrupted admin jobs; the worker will retry queued work normally: ${message}`,
      );
    }
  }

  private async process(id: string): Promise<void> {
    const job = await this.prisma.adminJob.findUniqueOrThrow({ where: { id } });
    if (job.jobType === 'report_export') return this.processReport(job);
    return this.processBulk(job);
  }

  private async processBulk(job: { id: string; filterJson: unknown }) {
    const input = job.filterJson as StoredBulk;
    const errors: Record<string, unknown>[] = [];
    let succeeded = 0;
    for (const proId of input.proIds) {
      try {
        const pro = await this.prisma.pro.findUnique({
          where: { id: proId },
          select: { cityId: true },
        });
        if (
          !pro ||
          (input.allowedCityIds.length &&
            (!pro.cityId || !input.allowedCityIds.includes(pro.cityId)))
        )
          throw new Error(
            'Pro no longer exists or is outside the submitting admin scope',
          );
        if (input.targetEntity === 'pros')
          await this.pros.setAvailability(proId, input.isAvailable!);
        else
          await this.assignments.update(proId, input.serviceId!, {
            isActive: input.isActive,
          });
        succeeded++;
      } catch (error) {
        errors.push({
          proId,
          code: 'ROW_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      await this.prisma.adminJob.update({
        where: { id: job.id },
        data: {
          processedCount: { increment: 1 },
          succeededCount: succeeded,
          failedCount: errors.length,
        },
      });
    }
    const resultFileKey = errors.length
      ? await this.artifacts.write(
          job.id,
          'csv',
          errors,
          'Bulk operation error log',
        )
      : null;
    await this.prisma.adminJob.update({
      where: { id: job.id },
      data: {
        status: errors.length
          ? succeeded
            ? 'partial'
            : 'failed'
          : 'completed',
        resultFileKey,
        completedAt: new Date(),
      },
    });
  }

  private async processReport(job: {
    id: string;
    targetEntity: string;
    format: string | null;
    filterJson: unknown;
  }) {
    const input = job.filterJson as StoredReport;
    const { allowedCityIds } = input;
    const query: AdminAnalyticsQueryDto = {
      cityIds: input.cityIds,
      proIds: input.proIds,
      serviceIds: input.serviceIds,
      customerSegments: input.customerSegments,
      from: input.from,
      to: input.to,
      groupBy: input.groupBy,
    };
    const rows = await this.analytics.reportRows(
      job.targetEntity,
      query,
      allowedCityIds,
    );
    const resultFileKey = await this.artifacts.write(
      job.id,
      job.format!,
      rows,
      `${job.targetEntity.replaceAll('_', ' ')} report`,
    );
    await this.prisma.adminJob.update({
      where: { id: job.id },
      data: {
        status: 'completed',
        totalCount: rows.length,
        processedCount: rows.length,
        succeededCount: rows.length,
        resultFileKey,
        completedAt: new Date(),
      },
    });
  }
}
