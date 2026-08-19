import { randomInt, timingSafeEqual } from 'node:crypto';
import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { apiError } from '../../common/utils';
import type { Booking, JobPhotoProof } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { S3Service } from '../../storage/s3.service';
import { CustomersService } from '../customers/customers.service';
import { ProCountersService } from '../pros/pro-counters.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BookingStateService } from './booking-state.service';
import type { TransitionCoordinates } from './booking.types';
import { BookingsService } from './bookings.service';
import { AttachPhotoDto, RequestPhotoUploadDto } from './dto/lifecycle.dto';
import { PlatformSettingsService } from './platform-settings.service';
import { COMMISSION_PORT, type CommissionPort } from './ports/commission.port';
import { LOYALTY_PORT, type LoyaltyPort } from './ports/loyalty.port';

/**
 * Everything that happens between assignment and completion.
 *
 * The service-start OTP is the centre of it. `startedAt` is the only basis for
 * the job timer, for `actualDurationMinutes`, and — through completion — for
 * commission existing at all. So exactly two things may set it: a
 * provider-verified OTP, or an audited ops force-start that is visibly
 * different on the timeline.
 */
/**
 * Compares two codes without leaking, through timing, how much of one matched.
 *
 * A plain `===` returns as soon as two characters differ, so the time it takes
 * measures the length of the common prefix. That is a real signal against a
 * short numeric code with a caller who can retry, and the fix costs nothing.
 *
 * Lengths are compared first and the buffers padded to match, because
 * `timingSafeEqual` throws on a length mismatch — and throwing would itself be
 * the leak.
 */
function timingSafeEqualString(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

@Injectable()
export class BookingLifecycleService {
  private readonly logger = new Logger(BookingLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly state: BookingStateService,
    private readonly bookings: BookingsService,
    private readonly customers: CustomersService,
    private readonly counters: ProCountersService,
    private readonly s3: S3Service,
    private readonly settings: PlatformSettingsService,
    private readonly config: ConfigService,
    @Inject(COMMISSION_PORT) private readonly commission: CommissionPort,
    @Inject(LOYALTY_PORT) private readonly loyalty: LoyaltyPort,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /** A positive integer from config, or the fallback when it is unusable. */
  private numberSetting(name: string, fallback: number): number {
    const value = Number(this.config.get<string>(name));
    return Number.isInteger(value) && value > 0 ? value : fallback;
  }

  // ------------------------------------------------------------------
  // Travel
  // ------------------------------------------------------------------

  async markEnRoute(
    proId: string,
    bookingId: string,
    coordinates: TransitionCoordinates,
  ): Promise<Booking> {
    await this.bookings.getAssignedBooking(proId, bookingId);

    // `arrived` is a legal source too: a Pro who leaves and comes back records
    // every leg, and feature 10 requires all of them to survive.
    return this.state.transition({
      bookingId,
      to: 'en_route',
      actorType: 'pro',
      actorId: proId,
      coordinates,
      expectedFrom: ['assigned', 'arrived'],
    });
  }

  /**
   * Arrival starts the grace-window clock and issues the customer's start OTP.
   *
   * `arrivedAt` is set on the **first** arrival only. A Pro who leaves and
   * returns produces more status events but does not reset the clock —
   * otherwise the no-start grace window could be extended indefinitely by
   * stepping away and back.
   */
  async markArrived(
    proId: string,
    bookingId: string,
    coordinates: TransitionCoordinates,
  ): Promise<Booking> {
    const booking = await this.bookings.getAssignedBooking(proId, bookingId);

    const updated = await this.state.transition({
      bookingId,
      to: 'arrived',
      actorType: 'pro',
      actorId: proId,
      coordinates,
      expectedFrom: ['en_route', 'assigned'],
      data: booking.arrivedAt ? {} : { arrivedAt: new Date() },
    });

    await this.issueStartOtp(updated);
    return updated;
  }

  // ------------------------------------------------------------------
  // The trust anchor
  // ------------------------------------------------------------------

  /**
   * Mints the code the customer reads out. The Pro types in what they are
   * told, which is what makes starting the job consent rather than a
   * formality.
   *
   * ---------------------------------------------------------------------------
   * MINTED HERE, NOT SENT BY SMS
   * ---------------------------------------------------------------------------
   * This used to go through the identity module's OTP provider — the same
   * Slide account that sends login codes. That was the wrong tool. A login
   * code proves somebody owns a phone number, over a channel we do not
   * control; this one is a handshake between two parties who are both already
   * signed in and standing in the same doorway.
   *
   * Routing it through SMS cost three things: the code never reached this
   * database, so the app had nothing to show and the customer had to go and
   * find a text message; a message was billed per job start; and a customer
   * with no signal — or a guest who never attached a number — could not start
   * their job at all, which left the Pro at the door waiting on ops.
   *
   * Generated with `randomInt`, which is CSPRNG-backed. `Math.random` is
   * predictable from previous outputs and has no business minting anything
   * that authorises work to begin.
   */
  private async issueStartOtp(booking: Booking): Promise<void> {
    const length = this.numberSetting('OTP_LENGTH', 6);
    const code = String(randomInt(0, 10 ** length)).padStart(length, '0');

    await this.prisma.booking.update({
      where: { id: booking.id },
      data: {
        startOtpCode: code,
        startOtpIssuedAt: new Date(),
        // A fresh code deserves a fresh allowance. Carrying failures over from
        // a previous one locks the door on a customer who has done nothing but
        // ask for a code that works.
        startOtpAttempts: 0,
      },
    });

    // `soojal-1` restored the older route here: send the code by SMS through
    // the identity provider and record the delivery against module 12. That is
    // the design the comment above explains this one deliberately replaced —
    // the code never reaches this database, every job start bills a message,
    // and a customer on no signal cannot start their job at all. Kept as it is;
    // raised with the developer rather than merged silently.
  }

  /**
   * US-12.4: a Pro is physically at the door. This cannot be a support ticket.
   *
   * Issues a NEW code rather than re-showing the old one. The reason to ask
   * for a resend is that something about the first is wrong — read out
   * incorrectly, or attempted too many times — and handing back the same
   * digits solves neither.
   */
  async resendStartOtp(bookingId: string): Promise<void> {
    const booking = await this.bookings.getByIdOrFail(bookingId);
    if (booking.status !== 'arrived') {
      throw apiError(
        'A start code is only issued once the Pro has arrived',
        HttpStatus.CONFLICT,
      );
    }
    await this.issueStartOtp(booking);
  }

  /**
   * The only path to `startedAt` a Pro has.
   *
   * Verification is the provider's answer, never the app's claim (US-4.12).
   * A wrong code increments the attempt counter and leaves `startedAt` null —
   * and deliberately does **not** pause the grace-window clock, because a Pro
   * stuck at the door is exactly the situation ops needs to see (US-4.13).
   */
  async verifyStartOtp(
    proId: string,
    bookingId: string,
    code: string,
    coordinates: TransitionCoordinates,
  ): Promise<Booking> {
    const booking = await this.bookings.getAssignedBooking(proId, bookingId);

    if (booking.status !== 'arrived') {
      throw apiError(
        'Mark arrival before entering the start code',
        HttpStatus.CONFLICT,
      );
    }
    if (!booking.startOtpCode) {
      throw apiError(
        'No start code has been issued yet — ask the customer to request a new one',
        HttpStatus.CONFLICT,
      );
    }

    /*
     * The attempt cap is checked BEFORE comparing, not only after a failure.
     * Checking it afterwards let a Pro keep guessing forever: every wrong code
     * incremented the counter and produced a different message, but nothing
     * ever refused to look at the next one.
     */
    const max = await this.settings.getNumber('booking.startOtpMaxAttempts', 5);
    if (booking.startOtpAttempts >= max) {
      throw apiError(
        'Too many incorrect codes. Ask the customer to request a new one.',
        HttpStatus.TOO_MANY_REQUESTS,
        [
          {
            field: 'code',
            message: `Attempts exhausted (${max})`,
            code: 'START_OTP_LOCKED',
          },
        ],
      );
    }

    const verified = timingSafeEqualString(booking.startOtpCode, code);

    if (!verified) {
      const attempts = await this.prisma.booking.update({
        where: { id: bookingId },
        data: { startOtpAttempts: { increment: 1 } },
      });
      await this.state.recordEvent(
        bookingId,
        'start_otp_failed',
        'pro',
        proId,
        coordinates,
      );

      throw apiError(
        attempts.startOtpAttempts >= max
          ? 'That code is not right. Ask the customer to request a new one.'
          : 'That code is not right. Check it with the customer and try again.',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'code',
            message: `Attempt ${attempts.startOtpAttempts} of ${max}`,
            code: 'START_OTP_INVALID',
          },
        ],
      );
    }

    return this.state.transition({
      bookingId,
      to: 'started',
      actorType: 'pro',
      actorId: proId,
      coordinates,
      expectedFrom: ['arrived'],
      data: {
        startedAt: new Date(),
        startOtpVerifiedByPro: { connect: { id: proId } },
        /*
         * Spent, so it stops existing. A started job that still carries a live
         * code is one screenshot away from a second start, and the customer's
         * app would keep showing digits that no longer mean anything.
         */
        startOtpCode: null,
      },
    });
  }

  /**
   * The documented override US-4.11 asks for: the customer sent a relative,
   * the code went to a phone nobody at the door is holding.
   *
   * Written as its own event type so the timeline shows plainly that this job
   * did **not** start on customer consent. Collapsing it into a normal start
   * would destroy the one piece of evidence a dispute rests on.
   */
  async forceStart(
    bookingId: string,
    adminId: string,
    reason: string,
  ): Promise<Booking> {
    // Resolve first so a missing id is the documented 404, rather than a
    // booking-status-event foreign-key failure leaking out as HTTP 500.
    await this.bookings.getByIdOrFail(bookingId);

    await this.state.recordEvent(
      bookingId,
      'start_otp_bypassed',
      'ops',
      adminId,
    );

    return this.state.transition({
      bookingId,
      to: 'started',
      actorType: 'ops',
      actorId: adminId,
      expectedFrom: ['arrived'],
      data: {
        startedAt: new Date(),
        overriddenByAdmin: { connect: { id: adminId } },
        overrideReason: `Start OTP bypassed: ${reason}`,
      },
    });
  }

  // ------------------------------------------------------------------
  // Photo proof
  // ------------------------------------------------------------------

  async createPhotoUploadUrl(
    proId: string,
    bookingId: string,
    dto: RequestPhotoUploadDto,
  ): Promise<{ photoKey: string; uploadUrl: string; expiresIn: number }> {
    await this.bookings.getAssignedBooking(proId, bookingId);

    // Namespaced per booking so a key from one job can never be attached to
    // another — the same containment the KYC upload path uses.
    const { key, uploadUrl, expiresIn } = await this.s3.createUploadUrl(
      `bookings/${bookingId}/proof/${dto.photoType}`,
      dto.contentType,
    );
    return { photoKey: key, uploadUrl, expiresIn };
  }

  async attachPhoto(
    proId: string,
    bookingId: string,
    dto: AttachPhotoDto,
  ): Promise<JobPhotoProof> {
    await this.bookings.getAssignedBooking(proId, bookingId);

    const expectedPrefix = `bookings/${bookingId}/proof/`;
    if (!dto.photoKey.startsWith(expectedPrefix)) {
      throw apiError(
        'That photo key does not belong to this booking',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'photoKey',
            message: 'Key must come from this booking’s upload-url call',
            code: 'PHOTO_KEY_INVALID',
          },
        ],
      );
    }

    const proof = await this.prisma.jobPhotoProof.create({
      data: {
        bookingId,
        proId,
        photoType: dto.photoType,
        photoUrl: dto.photoKey,
        lat: dto.lat ?? null,
        lng: dto.lng ?? null,
      },
    });

    await this.state.recordEvent(bookingId, 'photo_proof_added', 'pro', proId, {
      lat: dto.lat,
      lng: dto.lng,
    });

    return proof;
  }

  listPhotos(bookingId: string): Promise<JobPhotoProof[]> {
    return this.prisma.jobPhotoProof.findMany({
      where: { bookingId },
      orderBy: { capturedAt: 'asc' },
    });
  }

  // ------------------------------------------------------------------
  // Completion
  // ------------------------------------------------------------------

  /**
   * Two hard preconditions, both of which exist because of what completion
   * causes downstream — commission, counters, and the customer being billed.
   *
   * 1. `startedAt` must be set, or `actualDurationMinutes` is computed from
   *    nothing.
   * 2. At least one `completion` photo must exist. With quality audits gone,
   *    these photos are the platform's only structured record of the finished
   *    work and the Pro's primary defence in a dispute (US-4.16).
   */
  async complete(
    proId: string,
    bookingId: string,
    coordinates: TransitionCoordinates,
  ): Promise<Booking> {
    const booking = await this.bookings.getAssignedBooking(proId, bookingId);

    if (!booking.startedAt) {
      throw apiError(
        'This job has not been started — verify the customer’s code first',
        HttpStatus.CONFLICT,
        [
          {
            field: 'startedAt',
            message: 'A job cannot complete without a verified start',
            code: 'JOB_NOT_STARTED',
          },
        ],
      );
    }

    const completionPhotos = await this.prisma.jobPhotoProof.count({
      where: { bookingId, photoType: 'completion' },
    });
    if (completionPhotos === 0) {
      throw apiError(
        'Add at least one completion photo before finishing the job',
        HttpStatus.CONFLICT,
        [
          {
            field: 'photoType',
            message: 'A completion photo is mandatory',
            code: 'COMPLETION_PHOTO_REQUIRED',
          },
        ],
      );
    }

    const completedAt = new Date();
    const actualDurationMinutes = Math.max(
      1,
      Math.round(
        (completedAt.getTime() - booking.startedAt.getTime()) / 60_000,
      ),
    );

    const completed = await this.state.transition({
      bookingId,
      to: 'completed',
      actorType: 'pro',
      actorId: proId,
      coordinates,
      expectedFrom: ['started'],
      data: {
        completedAt,
        // Reporting only. Commission is one flat rate per service — a
        // four-hour job pays exactly what a one-hour one does.
        actualDurationMinutes,
        ...(await this.buildInvoice(booking.payableAmount.toString())),
      },
    });

    // The caller ProCountersService has been waiting for since the M6 pass.
    //
    // Deliberately non-fatal: counters are derived data, incremented on write
    // and rebuilt nightly from source, with source winning on conflict. A job
    // that is genuinely finished must not report failure to the Pro because a
    // statistic did not move — the nightly rebuild is the safety net for
    // exactly this.
    try {
      await this.counters.recordCompletion(bookingId, proId);
    } catch (error) {
      this.logger.error(
        `Booking ${bookingId} completed, but the Pro completion counter did not increment. The nightly rebuild will correct it.`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    // Module 8. Non-fatal for the same reason as the counter above — a Pro
    // standing in a customer's kitchen must never see "finish job" fail — but
    // the reasoning only transfers so far. A missing counter is derived data
    // the nightly rebuild recomputes; a missing commission row is **money the
    // Pro has not been credited**. So module 8 backs this call with a sweeper
    // that finds completed jobs with no pay row and writes them. Logging alone
    // here would mean the Pro silently loses the job's pay.
    try {
      await this.commission.recordCompletion(bookingId, proId);
    } catch (error) {
      this.logger.error(
        `Booking ${bookingId} completed, but no commission was recorded for Pro ${proId}. The commission sweeper will retry.`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    // Module 16 — the customer's side of the same moment. Coins earned on this
    // job, and the referral it may qualify.
    //
    // Non-fatal, and the weakest of the three: a missing coin credit is
    // neither derived data nor money owed to an employee, and it is fully
    // recomputable from the completed booking. The port's contract requires
    // idempotency, so ops re-running it costs nothing.
    try {
      await this.loyalty.onBookingCompleted(bookingId);
    } catch (error) {
      this.logger.error(
        `Booking ${bookingId} completed, but no Homingo Coins were credited to the customer.`,
        error instanceof Error ? error.stack : String(error),
      );
    }

    return completed;
  }

  /**
   * The invoice is an artifact of the booking, not a table. Number, tax and
   * timestamp are computable now; the PDF is not — nothing in this codebase
   * renders one yet, so `invoicePdfUrl` stays null rather than pointing at
   * something that does not exist.
   */
  private async buildInvoice(payableAmount: string): Promise<{
    invoiceNumber: string;
    taxAmount: string;
    invoicedAt: Date;
  }> {
    const taxPercent = await this.settings.getNumber('booking.taxPercent', 18);
    const gross = Number(payableAmount);
    // The payable amount is what the customer agreed to and is tax-inclusive —
    // US-3.2 and US-3.2b both require the invoice to show only that number.
    // What is recorded here is the tax component *within* it, not an addition.
    //
    // Since module 16 that number is the flat price **less any discount**: an
    // invoice for a job a customer part-paid in coins must show what they were
    // actually billed, or it is not an invoice.
    const taxAmount = (gross - gross / (1 + taxPercent / 100)).toFixed(2);

    const rows = await this.prisma.$queryRaw<{ nextval: bigint }[]>`
      SELECT nextval('booking_number_seq') AS nextval
    `;
    const year = new Date().getUTCFullYear();

    return {
      invoiceNumber: `INV-${year}-${rows[0].nextval.toString().padStart(6, '0')}`,
      taxAmount,
      invoicedAt: new Date(),
    };
  }
}
