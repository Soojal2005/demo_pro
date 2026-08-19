import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { normaliseReferralCode } from '../loyalty.types';

export class ApplyReferralCodeDto {
  @ApiProperty({
    example: 'HM4K2P',
    description:
      'Case-insensitive; spaces and dashes are stripped before matching, ' +
      'because this is a code somebody read aloud.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? normaliseReferralCode(value) : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9]{6,12}$/, {
    message: 'code must be 6–12 letters and digits',
  })
  code: string;
}

export class ReferralSummaryDto {
  @ApiProperty({ example: 'HM4K2P' })
  code: string;

  @ApiProperty({
    example:
      'Get ₹100 off your first Homingo booking — use my code HM4K2P when you sign up.',
    description: 'Ready to hand to the share sheet.',
  })
  shareMessage: string;

  @ApiProperty({ example: 200, description: 'Coins you get per referral.' })
  referrerCoins: number;

  @ApiProperty({ example: 100, description: 'Coins your friend gets.' })
  refereeCoins: number;

  @ApiProperty({
    example: 60,
    description:
      'Days your friend has to complete their first booking. The reward pays ' +
      'on that completion, not on their signup.',
  })
  qualifyWindowDays: number;

  @ApiProperty({ example: 12 })
  totalReferrals: number;

  @ApiProperty({ example: 7, description: 'How many actually paid out.' })
  qualifiedCount: number;

  @ApiProperty({ example: 1400 })
  totalCoinsEarned: number;

  @ApiProperty({
    example: 3,
    description: 'Signed up, not yet completed a first booking.',
  })
  pendingCount: number;

  @ApiProperty({ example: false })
  isBlocked: boolean;
}

export class ReferralDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'HM4K2P' }) code: string;

  @ApiProperty({
    example: 'pending',
    description:
      'pending → qualified → rewarded. `expired` if the window closed with no ' +
      'completed booking; `rejected` if ops disallowed it.',
  })
  status: string;

  @ApiProperty({ example: 200 }) referrerCoins: number;
  @ApiProperty({ example: 100 }) refereeCoins: number;

  @ApiProperty({ format: 'date-time', nullable: true })
  qualifiedAt: Date | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  rewardedAt: Date | null;

  @ApiProperty({ format: 'date-time', nullable: true })
  expiresAt: Date | null;

  @ApiProperty({ format: 'date-time' }) createdAt: Date;
}

export class BlockReferralCodeDto {
  @ApiProperty()
  @IsBoolean()
  isBlocked: boolean;

  @ApiPropertyOptional({
    example: 'Six referrals from one device fingerprint',
    description: 'Required when blocking.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RejectReferralDto {
  @ApiProperty({ example: 'Duplicate account — same phone as the referrer' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason: string;
}
