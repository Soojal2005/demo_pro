import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsIn, IsInt, IsOptional, Min, IsUUID } from 'class-validator';
import { PAYMENT_MODES, type PaymentMode } from '../booking.types';

/**
 * Instant or scheduled. Recurring bookings are never created directly — they
 * are generated from a `RecurringPlan`.
 *
 * The price is deliberately **not** an input. It is read from the catalogue
 * and frozen server-side; a client-supplied amount is the tampering vector
 * US-7.1 exists to close.
 */
export class CreateBookingDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  serviceId: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Must be one of your own addresses.',
  })
  @IsUUID()
  addressId: string;

  @ApiProperty({
    enum: PAYMENT_MODES,
    description:
      'Frozen at creation and never changed. `cash` skips awaiting_payment and ' +
      'dispatches immediately; `online` must be paid first.',
  })
  @IsIn(PAYMENT_MODES)
  paymentMode: PaymentMode;

  @ApiPropertyOptional({
    description:
      'Omit for an instant booking. Supplying it makes the booking scheduled; ' +
      'the end of the slot is derived from the service duration, not sent.',
    example: '2026-08-14T09:30:00.000Z',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  slotStartAt?: Date;

  @ApiPropertyOptional({
    description:
      'Homingo Coins to spend on this booking. Silently clamped to the balance ' +
      'you hold and to the platform redemption ceiling — asking for more than ' +
      'either is not an error, it just spends what is allowed. Call ' +
      'POST /bookings/quote first to see the ceiling.',
    minimum: 0,
    example: 150,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  coinsToRedeem?: number;
}
