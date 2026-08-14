import {
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { apiError } from '../../common/utils';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { NotificationsService } from '../notifications/notifications.service';

const ACK_EVENT = 'assignment_acknowledged';
const REBUILD_LOCK = 'jobs:pro-counters:rebuild';
/**
 * Marker that `completedJobs` has already been incremented for a booking.
 * Not a lifecycle status — it lives in the same append-only log purely so the
 * increment is idempotent across retries.
 */
const COMPLETION_COUNTED_EVENT = 'counters:completion_counted';
/** Per-attempt marker that `assignmentsOffered` has already been incremented. */
const OFFER_COUNTED_EVENT = 'counters:offer_counted';

@Injectable()
export class ProCountersService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProCountersService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('PRO_COUNTER_REBUILD_ENABLED') === 'false') {
      return;
    }
    this.scheduleNextRebuild();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  async recordOffer(
    bookingId: string,
    attemptNumber: number,
    proId: string,
    ratingScore?: number,
    offersToday?: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${bookingId}:${attemptNumber}:${proId}`}, 0))`;

      // The candidate row is written by the dispatch engine, which is the only
      // thing that holds the score inputs — travel time, rotation, fit, rank.
      // This method used to create a two-field version of that row itself and
      // use its existence as the idempotency guard, which meant that once the
      // engine existed it always found the row already there and returned
      // without ever incrementing the counter. Upsert instead of create, and
      // guard on a marker of our own.
      await tx.assignmentCandidate.upsert({
        where: {
          bookingId_attemptNumber_proId: { bookingId, attemptNumber, proId },
        },
        update: {},
        create: {
          bookingId,
          attemptNumber,
          proId,
          isWinner: true,
          rank: 1,
          ratingScore,
          offersToday,
        },
      });

      const marker = `${OFFER_COUNTED_EVENT}:${attemptNumber}`;
      const alreadyCounted = await tx.bookingStatusEvent.findFirst({
        where: { bookingId, status: marker, actorId: proId },
      });
      if (alreadyCounted) return;

      await tx.bookingStatusEvent.create({
        data: {
          bookingId,
          status: marker,
          actorType: 'system',
          actorId: proId,
        },
      });
      await tx.pro.update({
        where: { id: proId },
        data: { assignmentsOffered: { increment: 1 } },
      });
    });
  }

  async recordAcknowledgement(bookingId: string, proId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`ack:${bookingId}`}, 0))`;
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking || booking.proId !== proId) {
        throw new NotFoundException('Assigned booking not found');
      }
      const existing = await tx.bookingStatusEvent.findFirst({
        where: {
          bookingId,
          status: ACK_EVENT,
          actorType: 'pro',
          actorId: proId,
        },
      });
      if (existing) return;
      const now = new Date();
      if (
        booking.assignmentOutcome !== 'pending_ack' ||
        (booking.ackDeadlineAt && booking.ackDeadlineAt < now)
      ) {
        throw apiError(
          'The assignment acknowledgement window has closed',
          HttpStatus.CONFLICT,
        );
      }
      await tx.booking.update({
        where: { id: bookingId },
        data: {
          acknowledgedAt: now,
          assignmentOutcome: 'acknowledged',
        },
      });
      const ackEvent = await tx.bookingStatusEvent.create({
        data: {
          bookingId,
          status: ACK_EVENT,
          actorType: 'pro',
          actorId: proId,
          occurredAt: now,
        },
      });
      const pro = await tx.pro.update({
        where: { id: proId },
        data: { assignmentsAcknowledged: { increment: 1 } },
      });
      await tx.pro.update({
        where: { id: proId },
        data: {
          acceptanceRate:
            pro.assignmentsOffered === 0
              ? null
              : pro.assignmentsAcknowledged / pro.assignmentsOffered,
        },
      });
      if (this.notifications)
        await this.notifications.enqueue(
          {
            eventKey: 'booking.acknowledged',
            dedupeKey: `booking:${bookingId}:ack:${ackEvent.id}`,
            templateKey: 'booking.assignment_confirmed',
            recipientType: 'customer',
            recipientId: booking.customerId,
            bookingId,
            variables: {
              bookingNumber: booking.bookingNumber,
              proName: pro.fullName ?? 'Your Homingo Pro',
            },
          },
          tx,
        );
    });
  }

  /**
   * Increments `Pro.completedJobs` for a job that has just completed.
   *
   * **This no longer performs the completion itself.** It used to set
   * `status`/`completedAt` and write the status event, because when it was
   * written module 4 did not exist and something had to own the transition.
   * Booking now owns it, and leaving that here made the method a no-op: it
   * returned early on `status === 'completed'`, which is precisely the state
   * its only caller hands it, so the counter never moved.
   *
   * Idempotent via a marker event, so a retried completion cannot double-count.
   */
  async recordCompletion(bookingId: string, proId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`complete:${bookingId}`}, 0))`;
      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (!booking || booking.proId !== proId) {
        throw new NotFoundException('Assigned booking not found');
      }
      if (booking.status !== 'completed') {
        throw apiError(
          'Only a completed booking can be counted',
          HttpStatus.CONFLICT,
        );
      }

      const alreadyCounted = await tx.bookingStatusEvent.findFirst({
        where: { bookingId, status: COMPLETION_COUNTED_EVENT },
      });
      if (alreadyCounted) return;

      await tx.bookingStatusEvent.create({
        data: {
          bookingId,
          status: COMPLETION_COUNTED_EVENT,
          actorType: 'system',
          actorId: 'system',
        },
      });
      await tx.pro.update({
        where: { id: proId },
        data: { completedJobs: { increment: 1 } },
      });
    });
  }

  /**
   * @deprecated Module 10 (`src/modules/reviews`) owns review writing. This
   * method has never had a caller, and now has a live counterpart that handles
   * both reviewer directions, the submission window and the customer counters.
   *
   * Left in place because deleting from module 6's folder is not this change's
   * to make — but it is dead, and two implementations of one rule with one of
   * them unreachable is precisely how CONFLICTS_AND_DECISIONS #56 happened.
   * Remove it.
   */
  async recordReview(input: {
    bookingId: string;
    customerId: string;
    proId: string;
    rating: number;
    comment?: string;
    tags?: string[];
  }): Promise<void> {
    if (
      !Number.isInteger(input.rating) ||
      input.rating < 1 ||
      input.rating > 5
    ) {
      throw apiError('rating must be an integer from 1 to 5');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`review:${input.bookingId}:customer`}, 0))`;
      // Compound now that a booking can hold both directions. Repaired rather
      // than deleted only because this file belongs to module 6 — see the
      // @deprecated note above.
      const existing = await tx.review.findUnique({
        where: {
          bookingId_reviewerType: {
            bookingId: input.bookingId,
            reviewerType: 'customer',
          },
        },
      });
      if (existing) return;
      const booking = await tx.booking.findUnique({
        where: { id: input.bookingId },
      });
      if (
        !booking ||
        booking.status !== 'completed' ||
        booking.customerId !== input.customerId ||
        booking.proId !== input.proId
      ) {
        throw apiError(
          'Only the customer on a completed booking may review its assigned Pro',
          HttpStatus.CONFLICT,
        );
      }
      await tx.review.create({
        data: {
          bookingId: input.bookingId,
          customerId: input.customerId,
          proId: input.proId,
          reviewerType: 'customer',
          rating: input.rating,
          comment: input.comment,
          tags: input.tags ?? [],
        },
      });
      await tx.pro.update({
        where: { id: input.proId },
        data: {
          ratingSum: { increment: input.rating },
          ratingCount: { increment: 1 },
        },
      });
    });
  }

  /**
   * Rebuild every derived counter from its source rows.
   *
   * ## Why every rating query here filters on `reviewerType`
   *
   * CONFLICTS_AND_DECISIONS #61. A `reviews` row carries both participants —
   * `proId` and `customerId` — and `reviewerType` is the only thing that says
   * which of them WROTE it. A Pro's review of a customer therefore sits inside
   * the `GROUP BY "proId"` bucket, because the Pro is its author.
   *
   * This query used to have no filter, correctly, because until module 10
   * there was only one direction. Unfiltered now, it folds a Pro's opinion of
   * a customer into that Pro's own public rating at 02:00 — and since this is
   * the job that *corrects* drift, the wrong number would look authoritative.
   * A Pro diligent about flagging difficult households would quietly rate
   * themselves down.
   *
   * `pro-counters.service.spec.ts` writes one review in each direction and
   * asserts a rebuild leaves the Pro exactly where the customer's review put
   * them.
   */
  async rebuildAll(): Promise<boolean> {
    const locked = await this.redis.setIfAbsent(REBUILD_LOCK, '1', 3600);
    if (!locked) return false;
    try {
      const [drift] = await this.prisma.$queryRaw<
        {
          ratingDrift: bigint;
          assignmentDrift: bigint;
          completionDrift: bigint;
          customerRatingDrift: bigint;
        }[]
      >`
        WITH ratings AS (
          SELECT "proId", COALESCE(SUM("rating"), 0)::int AS sum, COUNT(*)::int AS count
          FROM "reviews" WHERE "reviewerType" = 'customer' GROUP BY "proId"
        ), customer_ratings AS (
          SELECT "customerId", COALESCE(SUM("rating"), 0)::int AS sum, COUNT(*)::int AS count
          FROM "reviews" WHERE "reviewerType" = 'pro' GROUP BY "customerId"
        ), offers AS (
          SELECT "proId", COUNT(*)::int AS count FROM "assignment_candidates"
          WHERE "isWinner" = true GROUP BY "proId"
        ), acknowledgements AS (
          SELECT "actorId", COUNT(*)::int AS count FROM "booking_status_events"
          WHERE "actorType" = 'pro' AND "status" = ${ACK_EVENT} GROUP BY "actorId"
        ), completions AS (
          SELECT "proId", COUNT(*)::int AS count FROM "bookings"
          WHERE "status" = 'completed' AND "proId" IS NOT NULL GROUP BY "proId"
        )
        SELECT
          COUNT(*) FILTER (WHERE p."ratingSum" <> COALESCE(r.sum, 0) OR p."ratingCount" <> COALESCE(r.count, 0)) AS "ratingDrift",
          COUNT(*) FILTER (WHERE p."assignmentsOffered" <> COALESCE(o.count, 0) OR p."assignmentsAcknowledged" <> COALESCE(a.count, 0)) AS "assignmentDrift",
          COUNT(*) FILTER (WHERE p."completedJobs" <> COALESCE(c.count, 0)) AS "completionDrift",
          (
            SELECT COUNT(*) FROM "customers" cu
            LEFT JOIN customer_ratings cr ON cr."customerId" = cu.id
            WHERE cu."ratingSum" <> COALESCE(cr.sum, 0)
               OR cu."ratingCount" <> COALESCE(cr.count, 0)
          ) AS "customerRatingDrift"
        FROM "pros" p
        LEFT JOIN ratings r ON r."proId" = p.id
        LEFT JOIN offers o ON o."proId" = p.id
        LEFT JOIN acknowledgements a ON a."actorId" = p.id::text
        LEFT JOIN completions c ON c."proId" = p.id
      `;
      if (drift?.ratingDrift > 0n) {
        this.logger.error(
          `Rating counter drift detected for ${drift.ratingDrift} Pros`,
        );
      }
      if (drift?.assignmentDrift > 0n) {
        this.logger.warn(
          `Assignment counter drift detected for ${drift.assignmentDrift} Pros`,
        );
      }
      if (drift?.completionDrift > 0n) {
        this.logger.warn(
          `Completed-job counter drift detected for ${drift.completionDrift} Pros`,
        );
      }
      if (drift?.customerRatingDrift > 0n) {
        this.logger.error(
          `Rating counter drift detected for ${drift.customerRatingDrift} customers`,
        );
      }

      await this.prisma.$executeRaw`
        WITH ratings AS (
          SELECT "proId", COALESCE(SUM("rating"), 0)::int AS sum, COUNT(*)::int AS count
          FROM "reviews" WHERE "reviewerType" = 'customer' GROUP BY "proId"
        ), offers AS (
          SELECT "proId", COUNT(*)::int AS count FROM "assignment_candidates"
          WHERE "isWinner" = true GROUP BY "proId"
        ), acknowledgements AS (
          SELECT "actorId", COUNT(*)::int AS count FROM "booking_status_events"
          WHERE "actorType" = 'pro' AND "status" = ${ACK_EVENT} GROUP BY "actorId"
        ), completions AS (
          SELECT "proId", COUNT(*)::int AS count FROM "bookings"
          WHERE "status" = 'completed' AND "proId" IS NOT NULL GROUP BY "proId"
        ), rebuilt AS (
          SELECT p.id,
            COALESCE(r.sum, 0) AS rating_sum,
            COALESCE(r.count, 0) AS rating_count,
            COALESCE(o.count, 0) AS offered,
            COALESCE(a.count, 0) AS acknowledged,
            COALESCE(c.count, 0) AS completed
          FROM "pros" p
          LEFT JOIN ratings r ON r."proId" = p.id
          LEFT JOIN offers o ON o."proId" = p.id
          LEFT JOIN acknowledgements a ON a."actorId" = p.id::text
          LEFT JOIN completions c ON c."proId" = p.id
        )
        UPDATE "pros" p SET
          "ratingSum" = rebuilt.rating_sum,
          "ratingCount" = rebuilt.rating_count,
          "assignmentsOffered" = rebuilt.offered,
          "assignmentsAcknowledged" = rebuilt.acknowledged,
          "acceptanceRate" = CASE WHEN rebuilt.offered = 0 THEN NULL ELSE rebuilt.acknowledged::float / rebuilt.offered END,
          "completedJobs" = rebuilt.completed,
          "countersRebuiltAt" = CURRENT_TIMESTAMP
        FROM rebuilt WHERE p.id = rebuilt.id
      `;

      /**
       * The mirrored half — `Customer.ratingSum` / `ratingCount` from the Pro
       * direction. Its own statement rather than another CTE in the one above,
       * because that one's `rebuilt` set is keyed on `pros.id` and a customer
       * with no Pro-authored review must still be reset to zero.
       */
      await this.prisma.$executeRaw`
        WITH customer_ratings AS (
          SELECT "customerId", COALESCE(SUM("rating"), 0)::int AS sum, COUNT(*)::int AS count
          FROM "reviews" WHERE "reviewerType" = 'pro' GROUP BY "customerId"
        ), rebuilt AS (
          SELECT cu.id,
            COALESCE(cr.sum, 0) AS rating_sum,
            COALESCE(cr.count, 0) AS rating_count
          FROM "customers" cu
          LEFT JOIN customer_ratings cr ON cr."customerId" = cu.id
        )
        UPDATE "customers" cu SET
          "ratingSum" = rebuilt.rating_sum,
          "ratingCount" = rebuilt.rating_count
        FROM rebuilt WHERE cu.id = rebuilt.id
      `;
      return true;
    } finally {
      await this.redis.del(REBUILD_LOCK);
    }
  }

  private scheduleNextRebuild(): void {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(20, 30, 0, 0); // 02:00 Asia/Kolkata
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    this.timer = setTimeout(() => {
      void this.rebuildAll()
        .catch((error: unknown) =>
          this.logger.error(
            `Pro counter rebuild failed: ${error instanceof Error ? error.message : 'unknown error'}`,
          ),
        )
        .finally(() => this.scheduleNextRebuild());
    }, next.getTime() - now.getTime());
    this.timer.unref();
  }
}
