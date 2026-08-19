import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Moving a booking's slot.
 *
 * Only the start is sent. The end is derived from the service duration, for
 * the same reason it is at creation: `slotEnd - slotStart` is the window the
 * job was sold against (US-3.6), and letting a client name it would let them
 * buy a four-hour job for a one-hour price.
 */
export class RescheduleBookingDto {
  @ApiProperty({
    example: '2026-08-22T09:30:00.000Z',
    description:
      'Must be at least `booking.freeRescheduleHours` from now — the same ' +
      'cutoff that governs the move itself, so a customer cannot escape it by ' +
      'moving a job into it.',
  })
  @Type(() => Date)
  @IsDate()
  slotStartAt: Date;

  @ApiPropertyOptional({
    example: 'Working late that day',
    description: 'Recorded on the reschedule row. Optional for a customer.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Ops moving a booking. The reason is required — a human made this call. */
export class AdminRescheduleBookingDto {
  @ApiProperty({ example: '2026-08-22T09:30:00.000Z' })
  @Type(() => Date)
  @IsDate()
  slotStartAt: Date;

  @ApiProperty({
    example: 'Customer called — building water supply is off until Thursday',
    description: 'Required. Ops moves are audited, customer moves are not.',
  })
  @IsString()
  @MaxLength(500)
  reason: string;
}

export class ReschedulePreviewDto {
  @ApiProperty({ description: 'Whether a move would be accepted right now.' })
  allowed: boolean;

  @ApiProperty({
    nullable: true,
    example: 'INSIDE_CUTOFF',
    description: 'Machine-readable refusal. Null when `allowed` is true.',
  })
  refusal: string | null;

  @ApiProperty({
    example: 'Free to move. 2 changes left on this booking.',
    description: 'Written to be shown to the customer verbatim.',
  })
  message: string;

  @ApiProperty({ nullable: true, example: 51.4 })
  hoursUntilSlot: number | null;

  @ApiProperty({ example: 2 })
  reschedulesRemaining: number;

  @ApiProperty({
    example: 6,
    description: 'Moves are refused inside this many hours of the slot.',
  })
  freeRescheduleHours: number;

  @ApiProperty({ format: 'date-time', nullable: true })
  currentSlotStartAt: Date | null;

  @ApiProperty({
    format: 'date-time',
    description:
      'The soonest slot that would be accepted — start the picker here.',
  })
  earliestNewSlotAt: Date;
}

/** What `GET /bookings/:id/cancellation-policy` answers. */
export class CancellationPolicyDto {
  @ApiProperty({
    nullable: true,
    example: 'C',
    description: 'Which of the six status windows the booking is in.',
  })
  window: string | null;

  @ApiProperty({ example: false })
  chargesFee: boolean;

  @ApiProperty({
    example: false,
    description: 'True once the job has started — only support can act then.',
  })
  requiresOps: boolean;

  @ApiProperty({ example: '0.00', description: 'What Homingo would retain.' })
  feeAmount: string;

  @ApiProperty({
    example: '450.00',
    description: 'What would come back. Zero on a booking nobody has paid for.',
  })
  refundAmount: string;

  @ApiProperty({
    example: 150,
    description:
      'Homingo Coins that would be returned. Independent of the fee — coins ' +
      'were spent at creation, not at capture, so they come back either way.',
  })
  coinsReturned: number;

  @ApiProperty({
    example: 'early',
    description: '`early` | `late` | `unscheduled`.',
  })
  timing: string;

  @ApiProperty({ nullable: true, example: 51.4 })
  hoursUntilSlot: number | null;

  @ApiProperty({ example: 6 })
  freeCancellationHours: number;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description:
      'Cancel before this instant and it is free. Null with no slot.',
  })
  freeUntil: Date | null;

  @ApiProperty({
    example: 'Free — cancelled more than 6 hours before your slot',
    description: 'Written to be shown to the customer verbatim.',
  })
  reason: string;

  @ApiProperty({ example: false })
  feeWaivedBySubscription: boolean;
}

/** What `POST /bookings/quote` answers. */
export class BookingQuoteDto {
  @ApiProperty({ example: '500.00', description: 'The catalogue price.' })
  flatPrice: string;

  @ApiProperty({ example: '50.00' })
  subscriptionDiscountAmount: string;

  @ApiProperty({ example: 100 })
  coinsRedeemed: string | number;

  @ApiProperty({ example: '100.00' })
  walletDiscountAmount: string;

  @ApiProperty({ example: '150.00' })
  discountAmount: string;

  @ApiProperty({
    example: '350.00',
    description: 'What you will actually be charged.',
  })
  payableAmount: string;

  @ApiProperty({ nullable: true, example: 'Homingo Plus' })
  planName: string | null;

  @ApiProperty({ example: 640 })
  coinBalance: number;

  @ApiProperty({
    example: 100,
    description:
      'The most coins this booking can absorb — the platform ceiling and what ' +
      'is left after the subscription discount, whichever binds first.',
  })
  maxRedeemableCoins: number;

  @ApiProperty({
    example: 17,
    description: 'Coins this booking would earn back on completion.',
  })
  coinsEarnedEstimate: number;
}

export class BookingQuoteRequestDto {
  @ApiProperty({ format: 'uuid' })
  @IsString()
  serviceId: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Used only to resolve the city, for city-scoped subscription plans.',
  })
  @IsOptional()
  @IsString()
  addressId?: string;

  @ApiPropertyOptional({
    example: 150,
    minimum: 0,
    description: 'Coins to try to spend. Clamped, never rejected.',
  })
  @IsOptional()
  @Type(() => Number)
  coinsToRedeem?: number;
}
