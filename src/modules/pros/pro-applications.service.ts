import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, ProApplication } from '../../prisma/client';
import { apiError } from '../../common/utils';
import { pageMeta, type Paged } from '../../common/dto/paged-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplicationDecisionDto } from './dto/application-decision.dto';
import { SubmitProApplicationDto } from './dto/submit-pro-application.dto';
import { VerifyDocumentDto } from './dto/verify-document.dto';
import { ProsService } from './pros.service';

/**
 * Just enough of Pro for a reviewer to identify who they're looking at.
 * Address and city ride along because the application form itself never
 * collects them: without these the reviewer approves a Pro and then has to
 * assign a city with no idea where the applicant is actually based.
 */
const APPLICANT_SELECT = {
  id: true,
  phone: true,
  fullName: true,
  employeeCode: true,
  addressLine: true,
  cityId: true,
  city: { select: { id: true, name: true, state: true } },
} satisfies Prisma.ProSelect;

export type ProApplicationWithApplicant = ProApplication & {
  pro: Prisma.ProGetPayload<{ select: typeof APPLICANT_SELECT }>;
};

@Injectable()
export class ProApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly prosService: ProsService,
  ) {}

  listForPro(proId: string): Promise<ProApplication[]> {
    return this.prisma.proApplication.findMany({
      where: { proId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async submit(
    proId: string,
    dto: SubmitProApplicationDto,
  ): Promise<ProApplication> {
    if (dto.aadhaarSource !== 'manual' || dto.panSource !== 'manual') {
      throw apiError(
        'Only manual KYC document uploads are supported',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (dto.aadhaarSource === 'manual' && !dto.aadhaarUrl) {
      throw apiError(
        'aadhaarUrl is required for a manual submission',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (dto.panSource === 'manual' && !dto.panUrl) {
      throw apiError(
        'panUrl is required for a manual submission',
        HttpStatus.BAD_REQUEST,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Serialise submissions for one Pro so two concurrent requests cannot
      // create two queue entries. The partial unique index is the DB backstop.
      // The lock function returns PostgreSQL `void`. `$queryRaw` attempts to
      // deserialize that value and crashes; `$executeRaw` acquires the lock
      // without expecting a result set.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${proId}, 0))`;

      const pro = await tx.pro.findUnique({ where: { id: proId } });
      if (!pro) throw new NotFoundException('Pro not found');
      if (pro.status === 'approved' || pro.status === 'suspended') {
        throw apiError(
          'Approved KYC identity cannot be changed through self-service re-submission',
          HttpStatus.CONFLICT,
        );
      }

      const openApplication = await tx.proApplication.findFirst({
        where: {
          proId,
          OR: [{ decision: null }, { decision: 'changes_requested' }],
        },
        orderBy: { createdAt: 'desc' },
      });

      const submittedAt = new Date();
      const applicationData = {
        referredByType: dto.referredByType ?? 'none',
        referredById: dto.referredById ?? null,
        submittedAt,
        queueStatus: 'pending',
        documentFullName: dto.documentFullName.trim(),
        documentDateOfBirth: new Date(dto.documentDateOfBirth),
        documentGender: dto.documentGender,
        aadhaarSource: dto.aadhaarSource,
        aadhaarUrl: dto.aadhaarUrl ?? null,
        aadhaarNumberMasked: dto.aadhaarNumberMasked ?? null,
        aadhaarStatus: 'pending',
        aadhaarVerifiedByType: null,
        aadhaarVerifiedByAdminId: null,
        aadhaarVerifiedAt: null,
        aadhaarRejectionReason: null,
        panSource: dto.panSource,
        panUrl: dto.panUrl ?? null,
        panNumberMasked: dto.panNumberMasked ?? null,
        panStatus: 'pending',
        panVerifiedByType: null,
        panVerifiedByAdminId: null,
        panVerifiedAt: null,
        panRejectionReason: null,
        reviewedByAdminId: null,
        verificationCallAt: null,
        decision: null,
        decisionAt: null,
        rejectionReason: null,
      } as const;

      const application = openApplication
        ? await tx.proApplication.update({
            where: { id: openApplication.id },
            data: applicationData,
          })
        : await tx.proApplication.create({
            data: { ...applicationData, proId },
          });

      await tx.pro.update({
        where: { id: proId },
        data: { status: 'under_review' },
      });

      return application;
    });
  }

  /**
   * `include: { pro }` is the fix for a real gap: the admin console had no
   * way to show whose application this is — just a bare proId — because
   * this query never joined it. Selected fields only; the Pro row carries
   * far more than an onboarding reviewer needs.
   */
  /**
   * Paged rather than capped, unlike the other admin lists.
   *
   * This one is a **queue**, not an archive. A cap on a list of recent records
   * costs an admin a search; a cap on a queue means the applications past it
   * are never reviewed by anyone, and the people who filed them wait forever
   * with nothing on screen to say why.
   *
   * Oldest first, for the same reason — the person who has waited longest is
   * the one to serve next.
   */
  async findAll(
    filters: {
      search?: string;
      queueStatus?: string;
      page?: number;
      limit?: number;
    },
    allowedCityIds?: string[],
  ): Promise<Paged<ProApplicationWithApplicant>> {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;

    const where: Prisma.ProApplicationWhereInput = {
      // Both names, because they routinely differ: somebody signs up as
      // "Ravi" and their Aadhaar reads "Ravi Kumar Chauhan". A reviewer has
      // whichever one the conversation gave them, not both.
      ...(filters.search && {
        OR: [
          {
            pro: {
              fullName: { contains: filters.search, mode: 'insensitive' },
            },
          },
          { pro: { phone: { contains: filters.search, mode: 'insensitive' } } },
          {
            documentFullName: {
              contains: filters.search,
              mode: 'insensitive',
            },
          },
        ],
      }),
      ...(filters.queueStatus ? { queueStatus: filters.queueStatus } : {}),
      ...(allowedCityIds?.length
        ? { pro: { cityId: { in: allowedCityIds } } }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.proApplication.findMany({
        where,
        include: { pro: { select: APPLICANT_SELECT } },
        orderBy: { submittedAt: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.proApplication.count({ where }),
    ]);

    return { data, meta: pageMeta(page, limit, total) };
  }

  /**
   * One application, by id.
   *
   * The console previously reconstructed this by fetching the list and finding
   * the row in it, which only ever worked because the list was unpaged — the
   * moment it was paged, opening anything past the first page found nothing.
   */
  findOne(id: string): Promise<ProApplicationWithApplicant> {
    return this.getOrThrow(id);
  }

  private async getOrThrow(id: string): Promise<ProApplicationWithApplicant> {
    const application = await this.prisma.proApplication.findUnique({
      where: { id },
      include: { pro: { select: APPLICANT_SELECT } },
    });
    if (!application) throw new NotFoundException('Application not found');
    return application;
  }

  async verifyDocument(
    id: string,
    dto: VerifyDocumentDto,
    actingAdminId: string,
  ): Promise<ProApplication> {
    const application = await this.getOrThrow(id);

    if (dto.decision === 'rejected' && !dto.reason) {
      throw apiError(
        'reason is required when rejecting a document',
        HttpStatus.BAD_REQUEST,
      );
    }

    const updated = await this.prisma.proApplication.update({
      where: { id },
      data:
        dto.docType === 'aadhaar'
          ? {
              aadhaarStatus: dto.decision,
              aadhaarVerifiedByType: 'admin',
              aadhaarVerifiedByAdminId: actingAdminId,
              aadhaarVerifiedAt: new Date(),
              aadhaarRejectionReason:
                dto.decision === 'rejected' ? (dto.reason ?? null) : null,
              queueStatus:
                application.queueStatus === 'pending'
                  ? 'docs_review'
                  : application.queueStatus,
            }
          : {
              panStatus: dto.decision,
              panVerifiedByType: 'admin',
              panVerifiedByAdminId: actingAdminId,
              panVerifiedAt: new Date(),
              panRejectionReason:
                dto.decision === 'rejected' ? (dto.reason ?? null) : null,
              queueStatus:
                application.queueStatus === 'pending'
                  ? 'docs_review'
                  : application.queueStatus,
            },
    });

    return updated;
  }

  async logCall(id: string, actingAdminId: string): Promise<ProApplication> {
    const application = await this.getOrThrow(id);
    const nextQueueStatus =
      application.queueStatus !== 'approved' &&
      application.queueStatus !== 'rejected'
        ? 'call_pending'
        : application.queueStatus;

    const updated = await this.prisma.proApplication.update({
      where: { id },
      data: {
        verificationCallAt: new Date(),
        reviewedByAdminId: actingAdminId,
        queueStatus: nextQueueStatus,
      },
    });
    return updated;
  }

  async decide(
    id: string,
    dto: ApplicationDecisionDto,
    actingAdminId: string,
  ): Promise<ProApplication> {
    const application = await this.getOrThrow(id);

    if (
      application.decision === 'approved' ||
      application.decision === 'rejected'
    ) {
      throw apiError(
        'A final application decision cannot be changed',
        HttpStatus.CONFLICT,
      );
    }

    if (dto.decision === 'approved') {
      if (
        application.aadhaarStatus !== 'verified' ||
        application.panStatus !== 'verified'
      ) {
        throw apiError(
          'Both Aadhaar and PAN must be verified before approval',
          HttpStatus.CONFLICT,
        );
      }
      if (
        !application.documentFullName ||
        !application.documentDateOfBirth ||
        !application.documentGender
      ) {
        throw apiError(
          'Document legal name, date of birth, and gender are required before approval',
          HttpStatus.CONFLICT,
        );
      }
    } else if (!dto.reason?.trim()) {
      throw apiError(
        'reason is required when rejecting or requesting changes',
        HttpStatus.BAD_REQUEST,
      );
    }

    const pro = await this.prisma.pro.findUnique({
      where: { id: application.proId },
    });
    if (!pro) throw new NotFoundException('Pro not found');

    const employeeCode =
      dto.decision === 'approved'
        ? (pro.employeeCode ?? (await this.prosService.generateEmployeeCode()))
        : pro.employeeCode;

    const updated = await this.prisma.$transaction(async (tx) => {
      const decided = await tx.proApplication.update({
        where: { id },
        data: {
          decision: dto.decision,
          decisionAt: new Date(),
          rejectionReason:
            dto.decision === 'approved' ? null : dto.reason!.trim(),
          queueStatus: dto.decision,
          reviewedByAdminId: actingAdminId,
        },
      });

      if (dto.decision === 'approved') {
        await tx.pro.update({
          where: { id: pro.id },
          data: {
            fullName: application.documentFullName,
            dateOfBirth: application.documentDateOfBirth,
            gender: application.documentGender,
            status: 'approved',
            approvedApplicationId: application.id,
            approvedAt: new Date(),
            employeeCode,
          },
        });
      } else {
        await tx.pro.update({
          where: { id: pro.id },
          data: {
            status:
              dto.decision === 'changes_requested'
                ? 'under_review'
                : 'rejected',
          },
        });
      }

      return decided;
    });

    return updated;
  }
}
