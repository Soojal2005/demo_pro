import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  BOOKING_STATUSES,
  BOOKING_TYPES,
  CANCELLED_BY_TYPES,
  PAYMENT_MODES,
  PAYMENT_STATUSES,
} from '../booking.types';

/** Swagger-only mirror of the Prisma Booking model. */
export class BookingDto {
  @ApiProperty()
  id: string;

  @ApiProperty({
    example: 'HB-2026-000123',
    description: 'Human-readable, for support calls.',
  })
  bookingNumber: string;

  @ApiProperty()
  customerId: string;

  @ApiProperty()
  serviceId: string;

  @ApiProperty()
  addressId: string;

  @ApiProperty({ enum: BOOKING_TYPES })
  bookingType: string;

  @ApiPropertyOptional({ nullable: true })
  recurringPlanId: string | null;

  @ApiPropertyOptional({ nullable: true })
  rebookedFromBookingId: string | null;

  @ApiPropertyOptional({ nullable: true })
  slotStartAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Set for instant bookings too. slotEnd − slotStart is the duration the ' +
      'job was sold against, so a later catalogue edit cannot resize it.',
  })
  slotEndAt: Date | null;

  @ApiProperty({
    type: String,
    example: '599.00',
    description:
      'The **catalogue** price, frozen at creation. Not necessarily what the ' +
      'customer was charged — see `payableAmount`. A STRING, not a number: ' +
      'never parseFloat a total.',
  })
  flatPrice: string;

  @ApiProperty({
    type: String,
    example: '499.00',
    description:
      '**What the customer is actually charged** — `flatPrice` less any plan ' +
      'discount and coins spent. Every money path reads this: the gateway ' +
      'order, the cash a Pro collects, the invoice and the refund.',
  })
  payableAmount: string;

  @ApiProperty({
    type: String,
    example: '100.00',
    description: 'Plan discount plus coin value. `0.00` when undiscounted.',
  })
  discountAmount: string;

  @ApiProperty({
    type: Number,
    example: 100,
    description:
      'Homingo Coins spent. Returned in full if the booking is cancelled, ' +
      'whatever cancellation fee applies.',
  })
  coinsRedeemed: number;

  @ApiProperty({ enum: PAYMENT_MODES })
  paymentMode: string;

  @ApiProperty({
    enum: PAYMENT_STATUSES,
    description:
      'For a cash booking, `paid` means the Pro is carrying banknotes — read ' +
      'paymentMode beside it.',
  })
  paymentStatus: string;

  @ApiProperty({ enum: BOOKING_STATUSES })
  status: string;

  @ApiPropertyOptional({ nullable: true })
  proId: string | null;

  @ApiPropertyOptional({ nullable: true })
  arrivedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  startedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  completedAt: Date | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Reporting only — commission is one flat rate per service.',
  })
  actualDurationMinutes: number | null;

  @ApiPropertyOptional({ nullable: true })
  invoiceNumber: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  taxAmount: string | null;

  @ApiPropertyOptional({ nullable: true })
  invoicedAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  cancelledAt: Date | null;

  @ApiPropertyOptional({ nullable: true })
  cancelReason: string | null;

  @ApiPropertyOptional({ enum: CANCELLED_BY_TYPES, nullable: true })
  cancelledByType: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  cancellationFeeAmount: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  refundedAmount: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/** One row of the append-only audit trail. */
export class BookingStatusEventDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: BOOKING_STATUSES })
  status: string;

  @ApiProperty({ enum: ['customer', 'pro', 'ops', 'system'] })
  actorType: string;

  @ApiProperty()
  actorId: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Where the actor actually was — evidence, not decoration.',
  })
  lat: number | null;

  @ApiPropertyOptional({ nullable: true })
  lng: number | null;

  @ApiProperty()
  occurredAt: Date;
}
