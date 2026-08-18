import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { BooleanQuery } from '../../../common/dto/boolean-query.transform';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  RECONCILIATION_SCOPES,
  TXN_TYPES,
  type ReconciliationScope,
  type TxnType,
} from '../ledger.types';

// ---------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------

export class LedgerQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;

  @ApiPropertyOptional({ enum: TXN_TYPES })
  @IsOptional()
  @IsIn(TXN_TYPES)
  txnType?: TxnType;

  @ApiPropertyOptional({
    example: 'payable:pro:0f6d…',
    description:
      'Matches either leg. An entry names two accounts and this finds it from ' +
      'whichever side you know.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  account?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  proId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  payoutId?: string;

  @ApiPropertyOptional({ example: '2026-08-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31T23:59:59.999Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class BalancesQueryDto {
  @ApiPropertyOptional({
    example: 'payable:pro:',
    description: 'Prefix filter. Omit for every account.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  prefix?: string;
}

export class VerifyQueryDto {
  @ApiPropertyOptional({
    description: 'Start from this sequence. Omit to verify from the beginning.',
    minimum: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  from?: number;

  @ApiPropertyOptional({ description: 'Stop after this many entries.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class RunReconciliationDto {
  @ApiPropertyOptional({
    enum: RECONCILIATION_SCOPES,
    default: 'all',
    description:
      '`money` and `cash` are module 7’s existing checks; `ledger` adds the ' +
      'chain and the book-vs-source checks; `all` runs everything and rebuilds ' +
      'the derived counters.',
  })
  @IsOptional()
  @IsIn(RECONCILIATION_SCOPES)
  scope?: ReconciliationScope;

  @ApiPropertyOptional({ example: '2026-08-11T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-12T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    description:
      'Defaults to true when scope is `all`. Rebuilds Pro rating and ' +
      'completed-job counts from source — module 6’s job, called rather than ' +
      'reimplemented.',
  })
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  rebuildCounters?: boolean;
}

export class ReconciliationRunQueryDto {
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

  @ApiPropertyOptional({ enum: ['running', 'completed', 'failed'] })
  @IsOptional()
  @IsIn(['running', 'completed', 'failed'])
  status?: string;
}

export class OpenDiscrepancyQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 50, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number = 50;

  @ApiPropertyOptional({ example: 'missing_ledger_entry' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  kind?: string;
}

export class ResolveDiscrepancyDto {
  @ApiProperty({
    maxLength: 1000,
    example:
      'Gateway settled late; the capture webhook arrived at 02:14 and the entry is now present.',
    description:
      'What was found and what was done. Nothing is auto-corrected, so this ' +
      'note is the only record of the answer.',
  })
  @IsString()
  @MaxLength(1000)
  notes: string;
}

// ---------------------------------------------------------------------
// Responses — Swagger only. See API_CONVENTIONS §2.
// ---------------------------------------------------------------------

export class LedgerEntryDto {
  @ApiProperty({ format: 'uuid' }) id: string;

  @ApiProperty({
    type: String,
    example: '4211',
    description: 'Gap-free. Serialised as a string — it is a BigInt.',
  })
  sequence: string;

  @ApiProperty() entryDate: Date;
  @ApiProperty({ enum: TXN_TYPES }) txnType: string;
  @ApiProperty({ example: 'expense:pro_commission' }) debitAccount: string;
  @ApiProperty({ example: 'payable:pro:0f6d…' }) creditAccount: string;
  @ApiProperty({ type: String, example: '300.00' }) amount: string;
  @ApiProperty({ example: 'INR' }) currency: string;

  @ApiProperty({ nullable: true, format: 'uuid' }) bookingId: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) orderId: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) payoutId: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) proId: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) customerId: string | null;
  @ApiProperty({ nullable: true }) razorpayPaymentId: string | null;

  @ApiProperty({
    example: 'accrual:1f2e…',
    description: 'Exactly-once key. Unique, so one event books one entry.',
  })
  sourceRef: string;

  @ApiProperty() prevHash: string;
  @ApiProperty() entryHash: string;
}

export class ChainBreakDto {
  @ApiProperty({ type: String, example: '4211' }) sequence: string;
  @ApiProperty({ enum: ['hash_mismatch', 'broken_link', 'sequence_gap'] })
  reason: string;
  @ApiProperty() expected: string;
  @ApiProperty() found: string;
}

export class VerifyResultDto {
  @ApiProperty() entriesChecked: number;
  @ApiProperty({ type: String, nullable: true }) firstSequence: string | null;
  @ApiProperty({ type: String, nullable: true }) lastSequence: string | null;

  @ApiProperty({
    description:
      'True when every hash recomputes and every link holds. **False is an ' +
      'incident**, not a warning: the table is append-only, so nothing written ' +
      'by this application could have caused it.',
  })
  intact: boolean;

  @ApiProperty({ type: [ChainBreakDto] }) breaks: ChainBreakDto[];
}

export class AccountBalanceDto {
  @ApiProperty({ example: 'payable:pro:0f6d…' }) account: string;
  @ApiProperty({ type: String, example: '14500.00' }) debits: string;
  @ApiProperty({ type: String, example: '14500.00' }) credits: string;

  @ApiProperty({
    type: String,
    example: '0.00',
    description:
      'Signed by the account’s normal side — assets and expenses by debits ' +
      'less credits, revenue and payables the other way — so a healthy balance ' +
      'reads positive.',
  })
  balance: string;
}

class TodayDto {
  @ApiProperty({ type: String, example: '48200.00' }) collected: string;
  @ApiProperty({ type: String, example: '1200.00' }) refunded: string;
  @ApiProperty({ type: String, example: '47000.00' }) net: string;
}

class AllTimeDto {
  @ApiProperty({ type: String }) grossRevenue: string;
  @ApiProperty({ type: String }) refunds: string;
  @ApiProperty({ type: String }) recoveries: string;
  @ApiProperty({ type: String }) commissionExpense: string;
  @ApiProperty({ type: String }) incentiveExpense: string;

  @ApiProperty({
    type: String,
    description:
      'Computed, never stored. The ERD names `platform_revenue` as an entry ' +
      'type and nothing writes one — a stored copy would be a second figure ' +
      'free to disagree with the entries behind it.',
  })
  platformRevenue: string;
}

export class FinanceDashboardDto {
  @ApiProperty({ type: TodayDto }) today: TodayDto;
  @ApiProperty({ type: AllTimeDto }) allTime: AllTimeDto;

  @ApiProperty({ type: String, example: '184300.00' }) owedToPros: string;

  @ApiProperty({
    type: String,
    example: '23400.00',
    description: 'Banknotes Pros are carrying, according to the books.',
  })
  cashHeldByPros: string;

  @ApiProperty({ type: String }) heldAtGateway: string;
  @ApiProperty({ type: String }) inBank: string;
  @ApiProperty() prosOwed: number;
  @ApiProperty() prosHoldingCash: number;
}

export class ReconciliationRunDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty() runDate: Date;
  @ApiProperty({ enum: RECONCILIATION_SCOPES }) scope: string;
  @ApiProperty() startedAt: Date;
  @ApiProperty({ nullable: true }) completedAt: Date | null;
  @ApiProperty({ enum: ['running', 'completed', 'failed'] }) status: string;

  @ApiProperty({
    nullable: true,
    description:
      'Set when the run died. "The job failed" and "the job found nothing" ' +
      'must not look the same.',
  })
  failureReason: string | null;

  @ApiProperty() entriesScanned: number;
  @ApiProperty() ordersScanned: number;
  @ApiProperty() bookingsScanned: number;
  @ApiProperty() countersRebuilt: boolean;
  @ApiProperty() discrepancyCount: number;
  @ApiProperty({ type: String, example: '0.00' }) totalVarianceAmount: string;
}

export class DiscrepancyDto {
  @ApiProperty({ format: 'uuid' }) id: string;

  @ApiProperty({
    example: 'missing_ledger_entry',
    description:
      'Module 7’s six kinds plus this module’s four: `missing_ledger_entry`, ' +
      '`ledger_amount_mismatch`, `orphan_ledger_entry`, `chain_broken`.',
  })
  kind: string;

  @ApiProperty({
    description: 'An order receipt, a booking number or a Pro id.',
  })
  reference: string;

  @ApiProperty({ type: String, nullable: true }) ours: string | null;
  @ApiProperty({ type: String, nullable: true }) theirs: string | null;
  @ApiProperty({ type: String, nullable: true }) variance: string | null;
  @ApiProperty() detail: string;
  @ApiProperty({ nullable: true }) resolvedAt: Date | null;
  @ApiProperty({ nullable: true }) resolutionNotes: string | null;
  @ApiProperty({ nullable: true, format: 'uuid' }) resolvedByAdminId:
    string | null;
}
