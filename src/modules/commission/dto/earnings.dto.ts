import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  COMMISSION_STATUSES,
  PAYOUT_STATUSES,
  type CommissionStatus,
  type PayoutStatus,
} from '../commission.types';

const RUPEES = /^\d+(\.\d{1,2})?$/;

/**
 * Every `reason` in this module is a record of why money moved, and several are
 * read by the Pro whose money it was. `@IsString() @MaxLength(500)` alone let
 * `""` through, so a commission could be reversed, a deduction raised against
 * someone's earnings, or a debt forgiven, with nothing at all on the row to say
 * who decided that or why. Trimmed first, so a single space is not a loophole.
 */
const RequiredReason = (): PropertyDecorator => (target, key) => {
  Transform(({ value }): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )(target, key);
  IsString()(target, key);
  IsNotEmpty({ message: 'reason is required' })(target, key);
  MaxLength(500)(target, key);
};

// ---------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------

export class EarningsQueryDto {
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

  @ApiPropertyOptional({ example: '2026-08-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31T23:59:59.999Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ enum: COMMISSION_STATUSES })
  @IsOptional()
  @IsIn(COMMISSION_STATUSES)
  status?: CommissionStatus;
}

export class PagedQueryDto {
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
}

export class AdminCommissionQueryDto extends EarningsQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  proId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  bookingId?: string;
}

export class PayoutQueryDto extends PagedQueryDto {
  @ApiPropertyOptional({ enum: PAYOUT_STATUSES })
  @IsOptional()
  @IsIn(PAYOUT_STATUSES)
  status?: PayoutStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  proId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cityId?: string;
}

export class PayoutSummaryQueryDto {
  @ApiPropertyOptional({ example: '2026-08-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31T23:59:59.999Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

// ---------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------

export class GeneratePayoutsDto {
  @ApiPropertyOptional({
    example: '2026-08-31T00:00:00.000Z',
    description:
      'Last day of the batch, in Indian time. Defaults to now. This **labels** ' +
      'the batch; what it actually sweeps is every approved unpaid commission ' +
      'as of this date, so a job approved late is picked up rather than orphaned.',
  })
  @IsOptional()
  @IsISO8601()
  periodEnd?: string;

  @ApiPropertyOptional({
    description:
      'Overrides the `payout.periodDays` setting for this run. Affects the ' +
      'label only, never which commissions are included.',
    minimum: 1,
    maximum: 366,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(366)
  periodDays?: number;

  @ApiPropertyOptional({ format: 'uuid', description: 'Limit to one city.' })
  @IsOptional()
  @IsUUID()
  cityId?: string;
}

export class ReverseCommissionDto {
  @ApiProperty({
    maxLength: 500,
    example: 'Customer refunded in full — job not performed',
    description:
      'Shown to finance and stored on the row. If the money has already been ' +
      'paid out this becomes the text on the Pro’s deduction, so write it for ' +
      'them to read.',
  })
  @RequiredReason()
  reason: string;
}

export class RaiseDeductionDto {
  @ApiProperty({ type: String, example: '150.00', description: 'Rupees.' })
  @IsString()
  @Matches(RUPEES, { message: 'amount must be rupees, e.g. "150.00"' })
  amount: string;

  @ApiProperty({ maxLength: 500, example: 'Replacement uniform' })
  @RequiredReason()
  reason: string;
}

export class WaiveDeductionDto {
  @ApiProperty({ maxLength: 500, example: 'Raised in error' })
  @RequiredReason()
  reason: string;
}

export class RejectPayoutDto {
  @ApiProperty({
    maxLength: 500,
    example:
      'Two duplicated jobs in this batch — regenerate after removing them',
    description:
      'Sends the batch back. Its commissions are released for the next run and ' +
      'every deduction it was holding is given back in full.',
  })
  @RequiredReason()
  reason: string;
}

// ---------------------------------------------------------------------
// Responses — Swagger only. See API_CONVENTIONS §2.
// ---------------------------------------------------------------------

class EarningsBucketDto {
  @ApiProperty() jobs: number;
  @ApiProperty({ type: String, example: '13800.00' }) commission: string;
  @ApiProperty({ type: String, example: '1000.00' }) incentives: string;
  @ApiProperty({ type: String, example: '14800.00' }) total: string;
}

class LastPayoutDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ type: String, example: '12900.00' }) netAmount: string;
  @ApiProperty({ nullable: true }) paidAt: Date | null;
  @ApiProperty() periodStart: Date;
  @ApiProperty() periodEnd: Date;
}

export class EarningsSummaryDto {
  @ApiProperty({ type: EarningsBucketDto }) today: EarningsBucketDto;
  @ApiProperty({ type: EarningsBucketDto }) period: EarningsBucketDto;
  @ApiProperty({ type: EarningsBucketDto }) lifetime: EarningsBucketDto;

  @ApiProperty({ type: String, example: '14800.00' }) unpaidEarnings: string;
  @ApiProperty({ type: String, example: '300.00' }) pendingDeductions: string;

  @ApiProperty({
    type: String,
    example: '14500.00',
    description:
      'What is actually coming: unpaid earnings less what is owed back.',
  })
  unpaidBalance: string;

  @ApiProperty({ type: LastPayoutDto, nullable: true })
  lastPayout: LastPayoutDto | null;

  @ApiProperty({
    description:
      'Show this. The Pro is a salaried employee and this system pays only the ' +
      'variable part — a screen that omits it turns a partial number into one ' +
      'the Pro reads as wrong.',
  })
  salaryNote: string;
}

class CommissionRateDto {
  @ApiProperty({ enum: ['percent', 'flat'] }) type: string;
  @ApiProperty({ type: String, example: '30.00' }) value: string;
}

export class CommissionLineDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ example: 'HMG-000812' }) bookingNumber: string;
  @ApiProperty() serviceName: string;
  @ApiProperty({ nullable: true }) completedAt: Date | null;
  @ApiProperty() computedAt: Date;
  @ApiProperty({ enum: COMMISSION_STATUSES }) status: string;
  @ApiProperty({ type: String, example: '1000.00' }) customerPaid: string;

  @ApiProperty({
    type: CommissionRateDto,
    description:
      'The rate snapshotted at completion, not the service’s rate today. ' +
      'Editing the service cannot change this (US-8.3).',
  })
  rate: CommissionRateDto;

  @ApiProperty({ type: String, example: '300.00' }) earned: string;
  @ApiProperty({ type: String, example: '0.00' }) incentive: string;
  @ApiProperty({ type: String, example: '0.00' }) deduction: string;
  @ApiProperty({ type: String, example: '300.00' }) netPayable: string;

  @ApiProperty({
    nullable: true,
    description:
      'Reporting only. Commission is one flat rate per service — a four-hour ' +
      'job pays exactly what a one-hour one does.',
  })
  durationMinutes: number | null;

  @ApiProperty({ nullable: true }) reversedAt: Date | null;
  @ApiProperty({ nullable: true }) reversalReason: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) payoutId: string | null;
}

export class PayoutDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() periodStart: Date;
  @ApiProperty() periodEnd: Date;
  @ApiProperty({ type: String, example: '13800.00' }) commissionAmount: string;
  @ApiProperty({ type: String, example: '1000.00' }) incentiveAmount: string;
  @ApiProperty({ type: String, example: '300.00' }) deductionAmount: string;
  @ApiProperty({ type: String, example: '14500.00' }) netAmount: string;
  @ApiProperty({ enum: PAYOUT_STATUSES }) status: string;
  @ApiProperty({ nullable: true }) paidAt: Date | null;

  @ApiProperty({
    nullable: true,
    description: 'The bank’s UTR, so a Pro can match this to their passbook.',
  })
  reference: string | null;

  @ApiProperty({ nullable: true, enum: ['vpa', 'bank_account'] })
  mode: string | null;
}

export class DeductionLineDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({ type: String, example: '300.00' }) amount: string;
  @ApiProperty({ type: String, example: '0.00' }) recovered: string;
  @ApiProperty({
    enum: ['commission_reversal', 'incentive_unwind', 'manual'],
  })
  kind: string;
  @ApiProperty() reason: string;
  @ApiProperty({ nullable: true }) bookingNumber: string | null;
  @ApiProperty() raisedAt: Date;
  @ApiProperty({ nullable: true }) settledAt: Date | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) payoutId: string | null;
}

export class DeductionStatementDto {
  @ApiProperty({ type: String, example: '300.00' }) outstandingTotal: string;
  @ApiProperty({ type: [DeductionLineDto] }) items: DeductionLineDto[];
}

/**
 * What an admin sees, which is more than a Pro does.
 *
 * The Pro-facing statement hides waived rows entirely — forgiven money is not
 * their concern. An admin needs the opposite: a waived row has to stay visible
 * and say so, or the same debt gets raised a second time by whoever looks next.
 */
export class AdminDeductionLineDto extends DeductionLineDto {
  @ApiProperty({ nullable: true }) waivedAt: Date | null;
  @ApiProperty({ nullable: true }) waiveReason: string | null;
}

export class AdminDeductionStatementDto {
  @ApiProperty({
    type: String,
    example: '300.00',
    description:
      'Still owed across every unwaived row. Waived rows are listed but do ' +
      'not count towards this.',
  })
  outstandingTotal: string;

  @ApiProperty({ type: [AdminDeductionLineDto] })
  items: AdminDeductionLineDto[];
}

export class SkippedProDto {
  @ApiProperty({ format: 'uuid' }) proId: string;
  @ApiProperty() proName: string;
  @ApiProperty() reason: string;
  @ApiProperty({
    enum: [
      'NO_VERIFIED_BANK_ACCOUNT',
      'NO_PAYABLE_DESTINATION',
      'BELOW_MINIMUM_NET',
    ],
    description:
      '`NO_PAYABLE_DESTINATION` means they have a verified account whose number ' +
      'is stored masked and no UPI id — the money has nowhere to go. Fixable by ' +
      'adding a UPI id; the earnings roll forward until then.',
  })
  code: string;
  @ApiProperty({ type: String, example: '4200.00' }) withheldAmount: string;
}

export class BatchResultDto {
  @ApiProperty() periodStart: string;
  @ApiProperty() periodEnd: string;
  @ApiProperty() created: number;
  @ApiProperty({ type: String, example: '184300.00' }) totalNet: string;

  @ApiProperty({
    type: [SkippedProDto],
    description:
      'Everybody who worked and is not about to be paid. Show it — a shorter ' +
      'batch with no explanation reads as success.',
  })
  skipped: SkippedProDto[];
}

export class ReversalOutcomeDto {
  @ApiProperty({ format: 'uuid' }) commissionId: string;

  @ApiProperty({
    enum: ['dropped', 'deducted'],
    description:
      '`dropped` — it never reached a payout, so nothing is owed. `deducted` — ' +
      'the money had already gone, so it comes off the next payout. **Never a ' +
      'bank debit.**',
  })
  effect: string;

  @ApiProperty({ type: String, example: '300.00' }) deductedAmount: string;
  @ApiProperty({ type: [String] }) unwoundIncentives: string[];
}

export class PayoutSummaryDto {
  @ApiProperty() draftCount: number;
  @ApiProperty({ type: String, example: '52000.00' }) draftNet: string;
  @ApiProperty() awaitingDisbursementCount: number;
  @ApiProperty({ type: String, example: '184300.00' })
  awaitingDisbursementNet: string;
  @ApiProperty() processingCount: number;
  @ApiProperty() paidCount: number;
  @ApiProperty({ type: String, example: '1204000.00' }) paidNet: string;
  @ApiProperty() failedCount: number;
  @ApiProperty({ type: String, example: '8400.00' }) failedNet: string;

  @ApiProperty({
    type: String,
    example: '3200.00',
    description: 'Deductions raised and not yet recovered, across every Pro.',
  })
  outstandingDeductions: string;
}

export class SweepResultDto {
  @ApiProperty({ description: 'Completed jobs found with no pay row.' })
  found: number;
  @ApiProperty() written: number;
}

export class MissingCommissionServiceDto {
  @ApiProperty({ format: 'uuid' }) serviceId: string;
  @ApiProperty() serviceName: string;
  @ApiProperty() isActive: boolean;
  @ApiProperty({
    description:
      'Completed jobs on this service with no commission row. Every one of ' +
      'them is unpaid work.',
  })
  unpaidCompletedJobs: number;
}
