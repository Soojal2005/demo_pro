import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { BooleanQuery } from '../../../common/dto/boolean-query.transform';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  INCENTIVE_RECURRENCES,
  INCENTIVE_TYPES,
  type IncentiveRecurrence,
  type IncentiveType,
} from '../commission.types';

const RUPEES = /^\d+(\.\d{1,2})?$/;

export class CreateIncentiveDto {
  @ApiProperty({ example: 'August 50-job bonus', maxLength: 120 })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({
    enum: INCENTIVE_TYPES,
    description:
      'Only `jobs_count` and `rating` have evaluators. The other two can be ' +
      'configured but will track nothing and pay nobody — every read reports ' +
      '`hasEvaluator: false` so this is visible rather than silent.',
  })
  @IsIn(INCENTIVE_TYPES)
  incentiveType: IncentiveType;

  @ApiPropertyOptional({
    enum: INCENTIVE_RECURRENCES,
    default: 'once',
    description:
      'How often the same Pro can win it again. `monthly` restarts on the 1st ' +
      'in Indian time; `once` can be won exactly once, ever.',
  })
  @IsOptional()
  @IsIn(INCENTIVE_RECURRENCES)
  recurrence?: IncentiveRecurrence;

  @ApiProperty({
    type: Object,
    examples: {
      jobs_count: { value: { target: 50 } },
      rating: { value: { minJobs: 20, minRating: 4.5 } },
    },
    description:
      'Validated against `incentiveType` at write time, so a scheme cannot be ' +
      'stored in a shape its own evaluator cannot read.',
  })
  @IsObject()
  criteriaJson: Record<string, unknown>;

  @ApiProperty({ type: String, example: '2000.00', description: 'Rupees.' })
  @IsString()
  @Matches(RUPEES, { message: 'rewardAmount must be rupees, e.g. "2000.00"' })
  rewardAmount: string;

  @ApiPropertyOptional({
    description: 'Omit for a platform-wide scheme.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  cityId?: string;

  @ApiProperty({ example: '2026-08-01T00:00:00.000Z' })
  @IsISO8601()
  validFrom: string;

  @ApiPropertyOptional({ example: '2026-09-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  validTo?: string;
}

/**
 * Editing a scheme changes what future runs pay. It never restates a bonus
 * already credited — that amount is snapshotted onto `ProIncentiveProgress`,
 * for the same reason a commission rate is snapshotted onto the job.
 */
export class UpdateIncentiveDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: INCENTIVE_TYPES })
  @IsOptional()
  @IsIn(INCENTIVE_TYPES)
  incentiveType?: IncentiveType;

  @ApiPropertyOptional({ enum: INCENTIVE_RECURRENCES })
  @IsOptional()
  @IsIn(INCENTIVE_RECURRENCES)
  recurrence?: IncentiveRecurrence;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  criteriaJson?: Record<string, unknown>;

  @ApiPropertyOptional({ type: String, example: '2500.00' })
  @IsOptional()
  @IsString()
  @Matches(RUPEES, { message: 'rewardAmount must be rupees, e.g. "2500.00"' })
  rewardAmount?: string;

  @ApiPropertyOptional({ example: '2026-09-01T00:00:00.000Z', nullable: true })
  @IsOptional()
  @IsISO8601()
  validTo?: string | null;
}

export class IncentiveQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ enum: INCENTIVE_TYPES })
  @IsOptional()
  @IsIn(INCENTIVE_TYPES)
  incentiveType?: IncentiveType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cityId?: string;
}

export class IncentiveProgressQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @ApiPropertyOptional({ description: 'Filter to those who have won it.' })
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  achieved?: boolean;
}

// ---------------------------------------------------------------------
// Response shapes — Swagger only. See API_CONVENTIONS §2.
// ---------------------------------------------------------------------

export class IncentiveDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true }) description: string | null;
  @ApiProperty({ enum: INCENTIVE_TYPES }) incentiveType: string;
  @ApiProperty({ enum: INCENTIVE_RECURRENCES }) recurrence: string;
  @ApiProperty({ type: Object }) criteriaJson: unknown;
  @ApiProperty({ type: String, example: '2000.00' }) rewardAmount: string;
  @ApiProperty({ nullable: true, format: 'uuid' }) cityId: string | null;
  @ApiProperty() validFrom: Date;
  @ApiProperty({ nullable: true }) validTo: Date | null;
  @ApiProperty() isActive: boolean;

  @ApiProperty({
    description:
      'False for `streak` and `surge_slot`. When false this scheme tracks ' +
      'nothing and will never pay — surface it in the UI rather than listing ' +
      'the incentive as if it worked.',
  })
  hasEvaluator: boolean;
}

export class ProIncentiveDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() name: string;
  @ApiProperty({ nullable: true }) description: string | null;
  @ApiProperty({ enum: INCENTIVE_TYPES }) incentiveType: string;
  @ApiProperty({ enum: INCENTIVE_RECURRENCES }) recurrence: string;
  @ApiProperty({ type: String, example: '2000.00' }) rewardAmount: string;

  @ApiProperty({ example: '2026-08', description: 'Which run this is.' })
  periodKey: string;

  @ApiProperty() periodEndsAt: Date;

  @ApiProperty({
    type: String,
    example: '34.00',
    description:
      'Jobs done for `jobs_count`; total stars for `rating`. Draw it against ' +
      '`targetValue`.',
  })
  progressValue: string;

  @ApiProperty({ type: String, nullable: true, example: '50.00' })
  targetValue: string | null;

  @ApiProperty() contributingJobs: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: '4.62',
    description: '`rating` schemes only. Null until something is rated.',
  })
  averageRating?: string | null;

  @ApiProperty({ nullable: true }) achievedAt: Date | null;
  @ApiProperty() rewardCredited: boolean;
}
