import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { apiError } from '../../common/utils';
import type { Booking, JobPhotoProof } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { S3Service } from '../../storage/s3.service';
import { CustomersService } from '../customers/customers.service';
import {
  OTP_PROVIDER,
  type OtpProvider,
} from '../identity/otp/otp-provider.interface';
import { ProCountersService } from '../pros/pro-counters.service';
import { BookingStateService } from './booking-state.service';
import type { TransitionCoordinates } from './booking.types';
import { BookingsService } from './bookings.service';
import { AttachPhotoDto, RequestPhotoUploadDto } from './dto/lifecycle.dto';
import { PlatformSettingsService } from './platform-settings.service';
import { COMMISSION_PORT, type CommissionPort } from './ports/commission.port';

/**
 * Everything that happens between assignment and completion.
 *
 * The service-start OTP is the centre of it. `startedAt` is the only basis for
 * the job timer, for `actualDurationMinutes`, and — through completion — for
 * commission existing at all. So exactly two things may set it: a
 * provider-verified OTP, or an audited ops force-start that is visibly
 * different on the timeline.
 */
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
    @Inject(OTP_PROVIDER) private readonly otp: OtpProvider,
    @Inject(COMMISSION_PORT) private readonly commission: CommissionPort,
  ) {}

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
   * Sends the code to the **customer's** phone, not the Pro's. The Pro types
   * in what the customer reads out, which is what makes it consent rather than
   * a formality.
   */
  private async issueStartOtp(booking: Booking): Promise<void> {
    const customer = await this.customers.getById(booking.customerId);
    if (!customer.phone) {
      // A guest who never attached a phone cannot receive a code. Ops has to
      // force-start; better to say so now than to leave a Pro at the door
      // waiting for a message that can never arrive.
      this.logger.warn(
        `Booking ${booking.id}: customer has no phone, so no start OTP can be sent.`,
      );
      return;
    }

    try {
      const { providerRef } = await this.otp.sendOtp(customer.phone);
      await this.prisma.booking.update({
        where: { id: booking.id },
        data: { startOtpProviderRef: providerRef },
      });
    } catch (error) {
      // A failed send must not roll back the arrival — the Pro really is
      // there, and the resend path exists precisely for this (US-12.4).
      this.logger.error(
        `Booking ${booking.id}: start OTP dispatch failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** US-12.4: a Pro is physically at the door. This cannot be a support ticket. */
  async resendStartOtp(bookingId: string): Promise<void> {
    const booking = await this.bookings.getByIdOrFail(bookingId);
    if (booking.status !== 'arrived') {
      throw apiError(
        'A start code is only sent once the Pro has arrived',
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
    if (!booking.startOtpProviderRef) {
      throw apiError(
        'No start code has been sent yet — ask the customer to request a resend',
        HttpStatus.CONFLICT,
      );
    }

    const customer = await this.customers.getById(booking.customerId);
    const verified = await this.otp.verifyOtp(
      customer.phone!,
      code,
      booking.startOtpProviderRef,
    );

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

      const max = await this.settings.getNumber(
        'booking.startOtpMaxAttempts',
        5,
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
        ...(await this.buildInvoice(booking.flatPrice.toString())),
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

    return completed;
  }

  /**
   * The invoice is an artifact of the booking, not a table. Number, tax and
   * timestamp are computable now; the PDF is not — nothing in this codebase
   * renders one yet, so `invoicePdfUrl` stays null rather than pointing at
   * something that does not exist.
   */
  private async buildInvoice(flatPrice: string): Promise<{
    invoiceNumber: string;
    taxAmount: string;
    invoicedAt: Date;
  }> {
    const taxPercent = await this.settings.getNumber('booking.taxPercent', 18);
    const gross = Number(flatPrice);
    // The flat price is what the customer agreed to and is tax-inclusive —
    // US-3.2 and US-3.2b both require the invoice to show only that number.
    // What is recorded here is the tax component *within* it, not an addition.
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
