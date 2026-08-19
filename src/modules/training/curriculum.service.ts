import {
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { ProTrainingProgress, TrainingModule } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { S3Service } from '../../storage/s3.service';
import { CloudFrontService } from '../../cdn/cloudfront.service';
import { apiError } from '../../common/utils';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import { gradeQuiz, questionIdsFrom, readAnswerKey } from './quiz-grading';
import {
  CONTENT_URL_TTL_SECONDS,
  TRAINING_SETTINGS,
  WIFI_RECOMMENDED_BYTES,
  type ContentType,
  type ProgressStatus,
} from './training.types';
import type {
  CurriculumDto,
  CurriculumItemDto,
  QuizResultDto,
  SubmitQuizDto,
  TrainingManifestDto,
  TrainingModuleDetailDto,
  UpdateProgressDto,
} from './dto/training.dto';

type ModuleWithCategory = TrainingModule & { category: { name: string } };

/**
 * What a Pro must study, how far they have got, and whether that is enough.
 *
 * ## The curriculum is a query
 *
 * There is no enrolment table and no per-Pro module list. `categoryChain`
 * walks from a set of services up to their trades and every ancestor trade
 * above them, and the modules for that set are the curriculum. Assign a
 * service to a Pro and their curriculum changes in the same instant; there is
 * no second copy of the answer to go stale.
 *
 * ## Progress rows are created lazily
 *
 * A Pro with forty modules and no activity has zero rows here, not forty
 * `not_started` ones. The curriculum read left-joins and fills in the default;
 * the first `PATCH` or quiz attempt is what creates a row. Pre-creating them
 * would mean every new module writes a row per Pro on the platform, and every
 * one of those rows would have to be cleaned up when the module is retired.
 */
@Injectable()
export class CurriculumService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly settings: PlatformSettingsService,
    @Optional() private readonly cloudFront?: CloudFrontService,
  ) {}

  // ------------------------------------------------------------------
  // Derivation
  // ------------------------------------------------------------------

  /**
   * Every category these services belong to, plus every ancestor above them.
   *
   * One recursive CTE rather than N round trips up the tree. The depth is two
   * today, but the query does not care, and a version that hard-coded one
   * parent hop would break silently the first time somebody nested a third
   * level.
   *
   * The ids go in as a joined string rather than an array parameter — same
   * parameterisation, none of the driver-specific behaviour around array
   * binding.
   */
  async categoryChain(serviceIds: string[]): Promise<string[]> {
    if (serviceIds.length === 0) return [];

    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      WITH RECURSIVE seed AS (
        SELECT DISTINCT s."categoryId" AS id
        FROM "services" s
        WHERE s.id = ANY(string_to_array(${serviceIds.join(',')}, ',')::uuid[])
      ), chain AS (
        SELECT c.id, c."parentCategoryId"
        FROM "service_categories" c
        JOIN seed ON seed.id = c.id
        UNION
        SELECT parent.id, parent."parentCategoryId"
        FROM "service_categories" parent
        JOIN chain ON chain."parentCategoryId" = parent.id
      )
      SELECT DISTINCT id FROM chain
    `;
    return rows.map((row) => row.id);
  }

  /** The services this Pro is actively assigned, optionally narrowed to one. */
  private async activeServiceIds(
    proId: string,
    serviceId?: string,
  ): Promise<string[]> {
    const rows = await this.prisma.proService.findMany({
      where: {
        proId,
        isActive: true,
        ...(serviceId ? { serviceId } : {}),
      },
      select: { serviceId: true },
    });
    return rows.map((row) => row.serviceId);
  }

  private async modulesFor(
    categoryIds: string[],
  ): Promise<ModuleWithCategory[]> {
    if (categoryIds.length === 0) return [];
    return this.prisma.trainingModule.findMany({
      where: { categoryId: { in: categoryIds }, isActive: true },
      include: { category: { select: { name: true } } },
      // Mandatory first: a Pro opening this screen should see what is standing
      // between them and being able to work before they see anything optional.
      orderBy: [
        { isMandatory: 'desc' },
        { sortOrder: 'asc' },
        { createdAt: 'asc' },
      ],
    });
  }

  private async progressFor(
    proId: string,
    moduleIds: string[],
  ): Promise<Map<string, ProTrainingProgress>> {
    if (moduleIds.length === 0) return new Map();
    const rows = await this.prisma.proTrainingProgress.findMany({
      where: { proId, moduleId: { in: moduleIds } },
    });
    return new Map(rows.map((row) => [row.moduleId, row]));
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  async curriculum(proId: string, serviceId?: string): Promise<CurriculumDto> {
    const serviceIds = await this.activeServiceIds(proId, serviceId);
    const modules = await this.modulesFor(await this.categoryChain(serviceIds));
    const progress = await this.progressFor(
      proId,
      modules.map((module) => module.id),
    );
    const maxAttempts = await this.maxAttempts();

    const items = modules.map((module) =>
      this.toItem(module, progress.get(module.id), maxAttempts),
    );

    return {
      mandatoryOutstanding: items.filter(
        (item) => item.isMandatory && item.status !== 'completed',
      ).length,
      total: items.length,
      completed: items.filter((item) => item.status === 'completed').length,
      modules: items,
    };
  }

  /**
   * One module, opened — content URL, resume position and, for a quiz, the
   * question ids.
   *
   * **`quizAnswerKey` is not in the returned shape and cannot be.** The DTO has
   * no field for it, and `training-dto.spec.ts` serialises a module carrying a
   * key and fails if the string appears anywhere in the JSON — because
   * "we remembered not to include it" does not survive the next person adding
   * a field with a spread.
   */
  async moduleDetail(
    proId: string,
    moduleId: string,
  ): Promise<TrainingModuleDetailDto> {
    const module = await this.assertAssigned(proId, moduleId);
    const progress = await this.prisma.proTrainingProgress.findUnique({
      where: { proId_moduleId: { proId, moduleId } },
    });

    const answerKey = readAnswerKey(module.quizAnswerKey);

    return {
      ...this.toItem(module, progress ?? undefined, await this.maxAttempts()),
      contentUrl: await this.contentUrlFor(module),
      contentBytes: module.contentBytes,
      quizQuestionIds: answerKey ? questionIdsFrom(answerKey) : [],
    };
  }

  /**
   * Everything worth pre-downloading, with the two fields that make caching
   * possible: a size and a version.
   *
   * `version` is the only correctness-critical field here. Without it,
   * replacing a video leaves every Pro who already downloaded the old one
   * watching last month's procedure, with nothing in the response to tell them
   * or their app that anything changed.
   */
  async manifest(proId: string): Promise<TrainingManifestDto> {
    const serviceIds = await this.activeServiceIds(proId);
    const modules = await this.modulesFor(await this.categoryChain(serviceIds));

    const items = await Promise.all(
      modules.map(async (module) => ({
        moduleId: module.id,
        title: module.title,
        contentType: module.contentType as ContentType,
        version: module.version,
        bytes: module.contentBytes,
        wifiRecommended: (module.contentBytes ?? 0) > WIFI_RECOMMENDED_BYTES,
        url: await this.contentUrlFor(module),
        urlExpiresAt: new Date(Date.now() + CONTENT_URL_TTL_SECONDS * 1000),
      })),
    );

    return {
      generatedAt: new Date(),
      totalBytes: items.reduce((total, item) => total + (item.bytes ?? 0), 0),
      modules: items,
    };
  }

  /** A Pro's own offline sessions, upcoming and past. */
  async sessions(proId: string) {
    const rows = await this.prisma.offlineTrainingAttendance.findMany({
      where: { proId },
      include: { session: true },
      orderBy: { session: { scheduledAt: 'desc' } },
    });
    return rows.map((row) => ({
      sessionId: row.sessionId,
      title: row.session.title,
      venue: row.session.venue,
      scheduledAt: row.session.scheduledAt,
      trainerName: row.session.trainerName,
      status: row.session.status as 'scheduled' | 'held' | 'cancelled',
      attended: row.attended,
    }));
  }

  // ------------------------------------------------------------------
  // Writes
  // ------------------------------------------------------------------

  /**
   * Record how far through a module a Pro is.
   *
   * `percentComplete` only ever moves forward. Scrubbing back through a video
   * is normal and must not undo a completion — the resume position is a
   * separate field precisely so that "where I am" and "how much I have seen"
   * can disagree.
   *
   * A **quiz** module cannot be completed this way: its completion comes from
   * a passing score, which is the whole point of feature 4.
   */
  async updateProgress(
    proId: string,
    moduleId: string,
    dto: UpdateProgressDto,
  ): Promise<CurriculumItemDto> {
    const module = await this.assertAssigned(proId, moduleId);
    const now = new Date();

    const existing = await this.prisma.proTrainingProgress.findUnique({
      where: { proId_moduleId: { proId, moduleId } },
    });

    const percentComplete = Math.max(
      existing?.percentComplete ?? 0,
      dto.percentComplete ?? 0,
    );
    const isQuiz = module.contentType === 'quiz';
    const alreadyComplete = existing?.status === 'completed';
    const completed = alreadyComplete || (!isQuiz && percentComplete >= 100);

    const status: ProgressStatus = completed
      ? 'completed'
      : percentComplete > 0
        ? 'in_progress'
        : 'not_started';

    const saved = await this.prisma.proTrainingProgress.upsert({
      where: { proId_moduleId: { proId, moduleId } },
      create: {
        proId,
        moduleId,
        status,
        percentComplete,
        lastPositionSeconds: dto.lastPositionSeconds ?? 0,
        startedAt: now,
        completedAt: completed ? now : null,
      },
      update: {
        status,
        percentComplete,
        ...(dto.lastPositionSeconds === undefined
          ? {}
          : { lastPositionSeconds: dto.lastPositionSeconds }),
        startedAt: existing?.startedAt ?? now,
        // The CHECK ties `completedAt` to `status`, and re-stamping it on every
        // heartbeat would move the completion date of a module finished weeks
        // ago.
        completedAt: completed ? (existing?.completedAt ?? now) : null,
      },
    });

    return this.toItem(module, saved, await this.maxAttempts());
  }

  /**
   * Grade an attempt.
   *
   * Serialised per (Pro, module) under an advisory lock: two submissions
   * racing would otherwise both read `quizAttempts = 2`, both write 3, and
   * hand out a free attempt past the cap.
   */
  async submitQuiz(
    proId: string,
    moduleId: string,
    dto: SubmitQuizDto,
  ): Promise<QuizResultDto> {
    const module = await this.assertAssigned(proId, moduleId);
    if (module.contentType !== 'quiz') {
      throw apiError('This module is not a quiz', HttpStatus.CONFLICT);
    }

    const answerKey = readAnswerKey(module.quizAnswerKey);
    if (!answerKey) {
      // A malformed key would grade every attempt at zero and read to the Pro
      // as their own failure. Refuse instead, and burn no attempt.
      throw apiError(
        'This quiz is not set up correctly — support has been notified',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const maxAttempts = await this.maxAttempts();
    const passMark =
      module.quizPassPercent ??
      (await this.settings.getNumber(
        TRAINING_SETTINGS.quizPassPercent.key,
        TRAINING_SETTINGS.quizPassPercent.fallback,
      ));

    const saved = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`quiz:${proId}:${moduleId}`}, 0))`;

      const existing = await tx.proTrainingProgress.findUnique({
        where: { proId_moduleId: { proId, moduleId } },
      });

      if (existing?.lockedAt) {
        throw apiError(
          'No attempts left on this quiz. An admin can reset it for you.',
          HttpStatus.CONFLICT,
        );
      }

      const result = gradeQuiz(answerKey, dto.answers);
      const passed = result.score >= passMark;
      const attempts = (existing?.quizAttempts ?? 0) + 1;
      const best = Math.max(Number(existing?.bestQuizScore ?? 0), result.score);

      // Locking happens on the attempt that exhausts the cap, not on the next
      // one — so `attemptsLeft: 0` and `isLocked: true` always agree.
      const locked = !passed && attempts >= maxAttempts;
      const now = new Date();

      const row = await tx.proTrainingProgress.upsert({
        where: { proId_moduleId: { proId, moduleId } },
        create: {
          proId,
          moduleId,
          status: passed ? 'completed' : 'in_progress',
          percentComplete: passed ? 100 : (existing?.percentComplete ?? 0),
          quizAttempts: attempts,
          quizScore: result.score,
          bestQuizScore: best,
          lockedAt: locked ? now : null,
          startedAt: now,
          completedAt: passed ? now : null,
        },
        update: {
          status: passed ? 'completed' : (existing?.status ?? 'in_progress'),
          ...(passed ? { percentComplete: 100 } : {}),
          quizAttempts: attempts,
          quizScore: result.score,
          bestQuizScore: best,
          lockedAt: locked ? now : null,
          startedAt: existing?.startedAt ?? now,
          completedAt: passed ? (existing?.completedAt ?? now) : null,
        },
      });

      return { row, result, passed };
    });

    const attemptsLeft = Math.max(0, maxAttempts - saved.row.quizAttempts);

    return {
      score: saved.result.score,
      passed: saved.passed,
      correct: saved.result.correct,
      total: saved.result.total,
      incorrectQuestionIds: saved.result.incorrectQuestionIds,
      bestQuizScore:
        saved.row.bestQuizScore === null
          ? null
          : Number(saved.row.bestQuizScore),
      attemptsUsed: saved.row.quizAttempts,
      attemptsLeft: saved.passed ? null : attemptsLeft,
      isLocked: saved.row.lockedAt !== null,
    };
  }

  // ------------------------------------------------------------------
  // Eligibility — what the activation gate asks
  // ------------------------------------------------------------------

  /**
   * The mandatory modules for a service's trade that this Pro has not
   * completed, by title.
   *
   * Titles rather than a count, because the 409 the gate throws has to say
   * what is missing. "Not eligible" with no list is a support ticket.
   */
  async missingMandatory(proId: string, serviceId: string): Promise<string[]> {
    const categoryIds = await this.categoryChain([serviceId]);
    if (categoryIds.length === 0) return [];

    const mandatory = await this.prisma.trainingModule.findMany({
      where: {
        categoryId: { in: categoryIds },
        isActive: true,
        isMandatory: true,
      },
      select: { id: true, title: true },
      orderBy: { sortOrder: 'asc' },
    });
    if (mandatory.length === 0) return [];

    const done = await this.prisma.proTrainingProgress.findMany({
      where: {
        proId,
        moduleId: { in: mandatory.map((module) => module.id) },
        status: 'completed',
      },
      select: { moduleId: true },
    });
    const completed = new Set(done.map((row) => row.moduleId));

    return mandatory
      .filter((module) => !completed.has(module.id))
      .map((module) => module.title);
  }

  /** Whether the gate is switched on at all — see `TRAINING_SETTINGS`. */
  async gateEnforced(cityId?: string | null): Promise<boolean> {
    const raw = await this.settings.getString(
      TRAINING_SETTINGS.gateActivation.key,
      null,
      cityId,
    );
    if (raw === null) return TRAINING_SETTINGS.gateActivation.fallback;
    return raw === 'true';
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * The module, if it is actually in this Pro's curriculum.
   *
   * A 404 rather than a 403 for a module belonging to another trade: whether a
   * given module exists is not information a Pro needs, and the two answers
   * are indistinguishable from the app's point of view anyway.
   */
  private async assertAssigned(
    proId: string,
    moduleId: string,
  ): Promise<ModuleWithCategory> {
    const module = await this.prisma.trainingModule.findFirst({
      where: { id: moduleId, isActive: true },
      include: { category: { select: { name: true } } },
    });
    if (!module) throw new NotFoundException('Training module not found');

    const categoryIds = await this.categoryChain(
      await this.activeServiceIds(proId),
    );
    if (!categoryIds.includes(module.categoryId)) {
      throw new NotFoundException('Training module not found');
    }
    return module;
  }

  private async contentUrlFor(module: TrainingModule): Promise<string> {
    if (module.contentUrl) return module.contentUrl;
    if (this.cloudFront?.signingConfigured)
      return this.cloudFront.signedUrlFor(
        module.contentKey!,
        CONTENT_URL_TTL_SECONDS,
      );
    const { viewUrl } = await this.s3.createViewUrl(
      module.contentKey!,
      CONTENT_URL_TTL_SECONDS,
    );
    return viewUrl;
  }

  private maxAttempts(): Promise<number> {
    return this.settings.getNumber(
      TRAINING_SETTINGS.maxQuizAttempts.key,
      TRAINING_SETTINGS.maxQuizAttempts.fallback,
    );
  }

  /**
   * A module plus a Pro's progress, as one row on a screen.
   *
   * Exported through `toItem` rather than assembled at each call site so the
   * "no progress row yet" defaults are written once — a Pro with no activity
   * has no row at all, and every reader has to agree on what that means.
   */
  toItem(
    module: ModuleWithCategory,
    progress: ProTrainingProgress | undefined,
    maxAttempts: number,
  ): CurriculumItemDto {
    const attempts = progress?.quizAttempts ?? 0;
    const isQuiz = module.contentType === 'quiz';
    const passed = progress?.status === 'completed';

    return {
      moduleId: module.id,
      title: module.title,
      description: module.description,
      contentType: module.contentType as ContentType,
      categoryId: module.categoryId,
      categoryName: module.category.name,
      isMandatory: module.isMandatory,
      version: module.version,
      durationMinutes: module.durationMinutes,
      status: (progress?.status ?? 'not_started') as ProgressStatus,
      percentComplete: progress?.percentComplete ?? 0,
      lastPositionSeconds: progress?.lastPositionSeconds ?? 0,
      bestQuizScore:
        progress?.bestQuizScore === null ||
        progress?.bestQuizScore === undefined
          ? null
          : Number(progress.bestQuizScore),
      quizAttempts: attempts,
      attemptsLeft:
        !isQuiz || passed ? null : Math.max(0, maxAttempts - attempts),
      isLocked: progress?.lockedAt != null,
      completedAt: progress?.completedAt ?? null,
    };
  }
}
