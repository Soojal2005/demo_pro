import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from 'class-validator';
import { WALLET_TIERS, type WalletTier } from '../loyalty.types';

export class WalletSummaryDto {
  @ApiProperty({ example: 640, description: 'Spendable Homingo Coins.' })
  balanceCoins: number;

  @ApiProperty({
    example: '640.00',
    description: 'What that balance is worth in rupees at the current rate.',
  })
  balanceValue: string;

  @ApiProperty({ enum: WALLET_TIERS, example: 'silver' })
  tier: WalletTier;

  @ApiProperty({
    enum: WALLET_TIERS,
    nullable: true,
    description: 'Null once the customer is platinum.',
  })
  nextTier: WalletTier | null;

  @ApiProperty({
    nullable: true,
    example: 9,
    description: 'Completed bookings still needed to reach `nextTier`.',
  })
  bookingsToNextTier: number | null;

  @ApiProperty({
    example: 5,
    description:
      'Percent of each booking returned as coins at this tier. This is the ' +
      'number that answers "why am I earning what I am earning".',
  })
  earnRatePercent: number;

  @ApiProperty({ example: 7, description: 'Jobs completed, all time.' })
  completedBookings: number;

  @ApiProperty({ example: 1240 })
  lifetimeEarnedCoins: number;

  @ApiProperty({ example: 600 })
  lifetimeRedeemedCoins: number;

  @ApiProperty({ example: '1.00', description: 'Rupee value of one coin.' })
  coinValueRupees: string;

  @ApiProperty({
    example: 20,
    description: 'Ceiling on how much of any one booking coins may pay for.',
  })
  maxRedemptionPercent: number;

  @ApiProperty({
    example: 120,
    description: 'Coins lapsing within 30 days, capped at the live balance.',
  })
  expiringSoonCoins: number;
}

export class WalletTransactionDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'earn' })
  type: string;

  @ApiProperty({
    example: 25,
    description: 'Signed — positive credits, negative debits.',
  })
  coins: number;

  @ApiProperty({ example: 640 })
  balanceAfter: number;

  @ApiProperty({ example: '25.00' })
  rupeeValue: string;

  @ApiProperty({
    example: '25 coins for booking HB-2026-000412 — 5% silver rate',
    description: 'Written to be shown to the customer verbatim.',
  })
  reason: string;

  @ApiProperty({ format: 'uuid', nullable: true })
  bookingId: string | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  expiresAt: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: Date;
}

export class WalletStatementDto {
  @ApiProperty({ type: [WalletTransactionDto] })
  items: WalletTransactionDto[];

  @ApiProperty({
    nullable: true,
    description: 'Pass back as `cursor` for the next page. Null on the last.',
  })
  nextCursor: string | null;
}

export class WalletStatementQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

/**
 * An ops credit or debit.
 *
 * `coins` is signed and may not be zero — a movement of nothing is not a
 * movement, and the database refuses one.
 */
export class AdjustWalletDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  customerId: string;

  @ApiProperty({
    example: 250,
    description:
      'Signed. Positive credits the customer, negative debits them. Never zero.',
  })
  @Type(() => Number)
  @IsInt()
  @NotEquals(0)
  coins: number;

  @ApiProperty({
    example: 'Goodwill — Pro arrived two hours late on HB-2026-000412',
    description:
      'Shown to the customer in their coin statement, so write it for them.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Idempotency key. Send the same value to retry safely; omit and one is ' +
      'generated, which makes a retried request a second adjustment.',
  })
  @IsOptional()
  @IsUUID()
  adjustmentId?: string;
}
