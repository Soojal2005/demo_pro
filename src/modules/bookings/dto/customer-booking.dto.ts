import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BOOKING_STATUSES,
  BOOKING_TYPES,
  PAYMENT_STATUSES,
} from '../booking.types';

/**
 * The Pro on the job, as the household is allowed to see them.
 *
 * Name and score only. A phone number is never here — the two sides talk
 * through the booking's chat thread precisely so neither learns the other's
 * number.
 */
export class BookingProfessionalDto {
  @ApiPropertyOptional({ type: String, nullable: true })
  name: string | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'Mean of their reviews, or null before they have any.',
  })
  rating: number | null;
}

/** The customer's own review of this job, once they have left one. */
export class BookingReviewDto {
  @ApiProperty()
  rating: number;

  @ApiPropertyOptional({ type: String, nullable: true })
  comment: string | null;

  @ApiProperty({ type: [String] })
  tags: string[];

  @ApiProperty({ type: [String] })
  photoUrls: string[];
}

/**
 * A booking as the customer app reads it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS ALONGSIDE `BookingDto`
 * ---------------------------------------------------------------------------
 * `BookingDto` mirrors the table: `bookingNumber`, `serviceId`, `addressId`,
 * `flatPrice` as a string. That is the right shape for ops and for anything
 * reconciling money, and the wrong one for a phone — which needs the service's
 * NAME to put on a card, the address as a LINE to print, and a number it can
 * render, and which cannot issue three more requests per row to go and find
 * them.
 *
 * So the customer endpoints resolve those joins once, server-side, and answer
 * with what a screen actually draws. Ids stay alongside the resolved values —
 * `serviceId` is what "Book again" follows, because names drift and ids do not.
 */
export class CustomerBookingDto {
  @ApiProperty()
  id: string;

  @ApiProperty({
    example: 'HB-2026-000123',
    description: "The booking's own number — what support asks for.",
  })
  reference: string;

  @ApiProperty({ enum: BOOKING_STATUSES })
  status: string;

  @ApiProperty({ description: 'The name of the service booked.' })
  title: string;

  @ApiProperty({ description: 'Follow this to rebook, never the title.' })
  serviceId: string;

  @ApiPropertyOptional({ type: Number, nullable: true })
  durationMinutes: number | null;

  @ApiProperty({ description: 'One line, ready to print.' })
  address: string;

  @ApiProperty({
    type: Number,
    description:
      'The frozen price, as a number for display. The authoritative decimal ' +
      'stays on `BookingDto.flatPrice`; nothing financial should be settled ' +
      'from this field.',
  })
  price: number;

  @ApiProperty({ enum: PAYMENT_STATUSES })
  paymentStatus: string;

  @ApiProperty({ enum: BOOKING_TYPES })
  bookingType: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  slotStartAt: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  slotEndAt: string | null;

  @ApiProperty()
  createdAt: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  completedAt: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  cancelledAt: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  cancelledByType: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  cancellationFeeAmount: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  refundedAmount: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  invoiceNumber: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  taxAmount: number | null;

  @ApiPropertyOptional({
    type: String,
    example: '481920',
    nullable: true,
    description:
      'The code to read out to the professional so they can start, and the ' +
      'signal the client uses to switch to its arrival panel.\n\n' +
      'Present **only while the booking is `arrived`**, and only to the ' +
      'customer who owns it. Null before anyone is at the door and null once ' +
      'the job has started — verifying it spends it.',
  })
  startOtp: string | null;

  @ApiPropertyOptional({ type: BookingProfessionalDto, nullable: true })
  professional: BookingProfessionalDto | null;

  @ApiPropertyOptional({ type: BookingReviewDto, nullable: true })
  review: BookingReviewDto | null;
}

/** One step of the audit trail, as the detail screen draws it. */
export class BookingTimelineEntryDto {
  @ApiProperty({ enum: BOOKING_STATUSES })
  status: string;

  @ApiProperty({ enum: ['customer', 'pro', 'ops', 'system'] })
  by: string;

  @ApiProperty()
  at: string;
}

/** One booking, opened. The list shape plus how it got here. */
export class CustomerBookingDetailDto extends CustomerBookingDto {
  @ApiProperty({ type: [BookingTimelineEntryDto] })
  timeline: BookingTimelineEntryDto[];
}
