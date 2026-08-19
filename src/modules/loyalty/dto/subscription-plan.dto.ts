import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumberString,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  SUBSCRIPTION_PAYMENT_MODES,
  SUBSCRIPTION_TIERS,
  type SubscriptionPaymentMode,
  type SubscriptionTier,
} from '../loyalty.types';

/**
 * Money is a decimal **string** on the way in as well as out — the same rule
 * as every other amount that crosses this API (CONFLICTS_AND_DECISIONS #12).
 * A JSON number for ₹499.99 is a float, and a float is how a plan quietly
 * becomes ₹499.98999999.
 */
const RUPEES = /^\d+(\.\d{1,2})?$/;

export class CreateSubscriptionPlanDto {
  @ApiProperty({
    example: 'homingo_plus',
    description:
      'Stable machine name clients key off. Renaming the plan does not change it.',
  })
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{2,39}$/, {
    message: 'code must be lower_snake_case, 3–40 characters',
  })
  code: string;

  @ApiProperty({ example: 'Homingo Plus' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ example: '10% off every booking, plus double coins.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiProperty({ enum: SUBSCRIPTION_TIERS })
  @IsIn(SUBSCRIPTION_TIERS)
  tier: SubscriptionTier;

  @ApiPropertyOptional({ default: 0, description: 'Display order only.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @ApiProperty({ example: '499.00' })
  @IsNumberString()
  @Matches(RUPEES, { message: 'priceAmount must be a rupee amount' })
  priceAmount: string;

  @ApiProperty({ example: 90, description: 'Cycle length in days.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays: number;

  @ApiPropertyOptional({
    example: '10.00',
    description: 'Percent off every booking. 0–100.',
  })
  @IsOptional()
  @IsNumberString()
  @Matches(/^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/, {
    message: 'discountPercent must be between 0 and 100',
  })
  discountPercent?: string;

  @ApiPropertyOptional({
    example: '200.00',
    description: 'Caps the percentage per booking. Omit for uncapped.',
  })
  @IsOptional()
  @IsNumberString()
  @Matches(RUPEES)
  maxDiscountAmount?: string;

  @ApiPropertyOptional({
    example: '2.00',
    description: 'Multiplies coins earned per completed booking.',
  })
  @IsOptional()
  @IsNumberString()
  @Matches(RUPEES)
  coinEarnMultiplier?: string;

  @ApiPropertyOptional({ example: 500, description: 'Granted on activation.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  bonusCoins?: number;

  @ApiPropertyOptional({
    description:
      'The headline perk: late-cancellation and window-D fees are waived outright.',
  })
  @IsOptional()
  @IsBoolean()
  waivesCancellationFee?: boolean;

  @ApiPropertyOptional({
    description: "Added to the platform's per-booking reschedule allowance.",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  extraReschedules?: number;

  @ApiPropertyOptional({
    description:
      'Reserved for a dispatch tiebreak. Nothing reads it yet — see the ' +
      'module 16 known gaps.',
  })
  @IsOptional()
  @IsBoolean()
  priorityDispatch?: boolean;

  @ApiPropertyOptional({
    example: 10,
    description:
      'Bookings the discount applies to per cycle. Omit = unlimited.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  includedBookings?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Restrict the plan to one city. Omit to sell everywhere.',
  })
  @IsOptional()
  @IsUUID()
  cityId?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Every field optional. Editing a plan **never touches a live subscription** —
 * perks are frozen onto `CustomerSubscription` at purchase, so this changes
 * what new buyers get and nothing else.
 */
export class UpdateSubscriptionPlanDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ enum: SUBSCRIPTION_TIERS })
  @IsOptional()
  @IsIn(SUBSCRIPTION_TIERS)
  tier?: SubscriptionTier;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional({ example: '599.00' })
  @IsOptional()
  @IsNumberString()
  @Matches(RUPEES)
  priceAmount?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3650)
  durationDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  @Matches(/^(100(\.0{1,2})?|\d{1,2}(\.\d{1,2})?)$/)
  discountPercent?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  @Matches(RUPEES)
  maxDiscountAmount?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumberString()
  @Matches(RUPEES)
  coinEarnMultiplier?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  bonusCoins?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  waivesCancellationFee?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  extraReschedules?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  priorityDispatch?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  includedBookings?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cityId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class PurchaseSubscriptionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  planId: string;

  @ApiPropertyOptional({
    enum: SUBSCRIPTION_PAYMENT_MODES,
    default: 'online',
    description:
      'Only ops may create a `complimentary` subscription; a customer asking ' +
      'for one is refused.',
  })
  @IsOptional()
  @IsIn(SUBSCRIPTION_PAYMENT_MODES)
  paymentMode?: SubscriptionPaymentMode;
}

export class ActivateSubscriptionDto {
  @ApiPropertyOptional({
    example: 'pay_MkT9v2Xy',
    description: 'Gateway payment id, or the ops reference for a comp.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  paymentReference?: string;
}

export class CancelSubscriptionDto {
  @ApiProperty({ example: 'Customer moved out of the service area' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}

export class SubscriptionPlanDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() code: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true }) description: string | null;
  @ApiProperty({ enum: SUBSCRIPTION_TIERS }) tier: string;
  @ApiProperty({ example: '499.00' }) priceAmount: string;
  @ApiProperty({ example: 90 }) durationDays: number;
  @ApiProperty({ example: '10.00' }) discountPercent: string;
  @ApiProperty({ nullable: true, example: '200.00' })
  maxDiscountAmount: string | null;
  @ApiProperty({ example: '2.00' }) coinEarnMultiplier: string;
  @ApiProperty({ example: 500 }) bonusCoins: number;
  @ApiProperty() waivesCancellationFee: boolean;
  @ApiProperty() extraReschedules: number;
  @ApiProperty({ nullable: true }) includedBookings: number | null;
  @ApiProperty() isActive: boolean;
}

export class CustomerSubscriptionDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ format: 'uuid' }) planId: string;
  @ApiProperty({ nullable: true }) planName: string | null;
  @ApiProperty({ example: 'active' }) status: string;
  @ApiProperty({ example: '499.00' }) pricePaid: string;
  @ApiProperty({ format: 'date-time', nullable: true })
  activatedAt: Date | null;
  @ApiProperty({ format: 'date-time', nullable: true }) expiresAt: Date | null;
  @ApiProperty({ example: '10.00' }) discountPercent: string;
  @ApiProperty({ example: '2.00' }) coinEarnMultiplier: string;
  @ApiProperty() waivesCancellationFee: boolean;
  @ApiProperty() extraReschedules: number;
  @ApiProperty({
    nullable: true,
    description: 'Null when the plan discounts every booking.',
  })
  bookingsRemaining: number | null;
}

/** What the app hands to the Razorpay SDK to open a plan checkout. */
export class SubscriptionCheckoutDto {
  @ApiProperty({ format: 'uuid', description: 'Our order id.' })
  orderId: string;

  @ApiProperty({ example: 'order_MkT9v2Xy' })
  razorpayOrderId: string;

  @ApiProperty({
    example: 'rzp_test_abc123',
    description: 'Publishable key. Never the secret.',
  })
  keyId: string;

  @ApiProperty({
    example: '699.00',
    description:
      'Read from the subscription, never from the client — the amount was ' +
      'frozen when the plan was chosen.',
  })
  amount: string;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    example: 'subscription',
    description:
      '`booking` | `subscription`. The two have different success screens.',
  })
  purpose: string;

  @ApiProperty({
    example: 'Homingo Gold',
    description: 'What to show on the checkout sheet.',
  })
  reference: string;

  @ApiProperty({
    nullable: true,
    description: 'Always null here — a subscription is not a booking.',
  })
  bookingNumber: string | null;

  @ApiProperty({ nullable: true }) customerName: string | null;
  @ApiProperty({ nullable: true }) customerContact: string | null;
}
