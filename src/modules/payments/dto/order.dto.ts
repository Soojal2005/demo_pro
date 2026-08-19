import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ORDER_STATUSES,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
} from '../payments.types';

/** The booking a payment belongs to, by the number a human quotes. */
export class OrderBookingDto {
  @ApiProperty()
  id: string;

  @ApiProperty({
    example: 'booking',
    description:
      '`booking` | `subscription`. Which of the two things this payment buys — ' +
      'they have different success screens.',
  })
  bookingNumber: string | null;

  @ApiProperty()
  status: string;

  @ApiProperty({ enum: ['online', 'cash'] })
  paymentMode: string;
}

/**
 * Swagger-only mirror of the Prisma Order model.
 *
 * Note what is **not** here and never will be: the attempt list. Every try,
 * its failure code and the instrument used live at Razorpay and are read in
 * their dashboard by `razorpayOrderId`. `attempts` and `failureCode` below are
 * triage mirrors, not history.
 */
export class OrderDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  bookingId: string;

  @ApiPropertyOptional({
    type: OrderBookingDto,
    description:
      'Present on the list, where support searches by booking number.',
  })
  booking?: OrderBookingDto;

  @ApiProperty()
  customerId: string;

  @ApiProperty({
    example: 'order_NqRs1234567890',
    description: 'The key for every gateway lookup, support’s included.',
  })
  razorpayOrderId: string;

  @ApiProperty({ example: 'HB-2026-000123-1' })
  receipt: string;

  @ApiProperty({
    type: String,
    example: '599.00',
    description:
      'Rupees, as a STRING. Razorpay transacts in paise; the conversion never ' +
      'crosses this boundary.',
  })
  amount: string;

  @ApiProperty({ type: String, example: '599.00' })
  amountPaid: string;

  @ApiProperty({ type: String, example: '0.00' })
  amountDue: string;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    enum: ORDER_STATUSES,
    description: 'Forward only — a late webhook cannot walk this backwards.',
  })
  status: string;

  @ApiProperty({ description: 'Razorpay’s own counter, mirrored for triage.' })
  attempts: number;

  @ApiPropertyOptional({
    nullable: true,
    description: 'The LAST failure only. Not a history.',
  })
  failureCode: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'The successful attempt’s reference. Written once, never overwritten.',
  })
  capturedPaymentId: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: 'upi',
    description:
      'As reported by the gateway: upi | card | netbanking | wallet.',
  })
  paymentMethod: string | null;

  @ApiPropertyOptional({ nullable: true })
  paidAt: Date | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'CUMULATIVE across refunds, never the last one alone.',
  })
  refundAmount: string | null;

  @ApiPropertyOptional({ nullable: true })
  razorpayRefundId: string | null;

  @ApiProperty({
    enum: REFUND_STATUSES,
    description:
      '`initiated` on the call, `settled` when the money lands 5–7 working ' +
      'days later. The customer must be able to tell these apart.',
  })
  refundStatus: string;

  @ApiPropertyOptional({ nullable: true })
  refundedAt: Date | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/** Everything the app needs to open Razorpay Checkout — feature 2. */
export class CheckoutHandoffDto {
  @ApiProperty()
  orderId: string;

  @ApiProperty({ example: 'order_NqRs1234567890' })
  razorpayOrderId: string;

  @ApiProperty({
    example: 'rzp_test_1234567890',
    description:
      'The PUBLISHABLE key id. The key secret never leaves the server.',
  })
  keyId: string;

  @ApiProperty({ type: String, example: '599.00' })
  amount: string;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    example: 'booking',
    description:
      '`booking` | `subscription`. Which of the two things this payment buys — ' +
      'the app needs it because they have different success screens.',
  })
  purpose: string;

  @ApiProperty({
    example: 'HB-2026-000123',
    description: 'Booking number, or the plan name. Show this on the sheet.',
  })
  reference: string;

  @ApiProperty({
    example: 'HB-2026-000123',
    nullable: true,
    description: 'Null when `purpose` is `subscription`.',
  })
  bookingNumber: string | null;

  @ApiPropertyOptional({ nullable: true })
  customerName: string | null;

  @ApiPropertyOptional({ nullable: true })
  customerContact: string | null;
}

/** The payment view of a booking, whichever mode it is. */
export class BookingPaymentDto {
  @ApiProperty({ enum: ['online', 'cash'] })
  paymentMode: string;

  @ApiProperty({
    enum: PAYMENT_STATUSES,
    description:
      'For a cash booking, `paid` means the Pro is carrying banknotes — read ' +
      'paymentMode beside it.',
  })
  paymentStatus: string;

  @ApiProperty({ type: String, example: '599.00' })
  flatPrice: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Cash only. The store of record for a booking with no Order.',
  })
  cashCollectedAmount: string | null;

  @ApiPropertyOptional({ nullable: true })
  cashCollectedAt: Date | null;

  @ApiProperty({
    type: [OrderDto],
    description:
      'Always empty for a cash booking — it has no Order row at all.',
  })
  orders: OrderDto[];
}
