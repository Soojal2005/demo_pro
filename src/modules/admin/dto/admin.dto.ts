import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export const REPORT_TYPES = [
  'commission',
  'operational',
  'retention',
  'city_performance',
] as const;
export const REPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export const CUSTOMER_SEGMENTS = [
  'new',
  'active',
  'repeat',
  'at_risk',
  'lapsed',
  'never_booked',
] as const;

const csv = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean)
    : value;

export class AdminAnalyticsQueryDto {
  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsUUID('4', { each: true })
  cityIds?: string[];

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsUUID('4', { each: true })
  proIds?: string[];

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsUUID('4', { each: true })
  serviceIds?: string[];

  @ApiPropertyOptional({ enum: CUSTOMER_SEGMENTS, isArray: true })
  @IsOptional()
  @Transform(csv)
  @IsArray()
  @IsIn(CUSTOMER_SEGMENTS, { each: true })
  customerSegments?: string[];

  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
  @ApiPropertyOptional({ enum: ['day', 'week', 'month'] })
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  groupBy?: 'day' | 'week' | 'month';
}

export class CreateReportExportDto extends AdminAnalyticsQueryDto {
  @ApiProperty({ enum: REPORT_TYPES })
  @IsIn(REPORT_TYPES)
  type!: (typeof REPORT_TYPES)[number];
  @ApiProperty({ enum: REPORT_FORMATS })
  @IsIn(REPORT_FORMATS)
  format!: (typeof REPORT_FORMATS)[number];
}

export class CreateBulkJobDto {
  @ApiProperty({ enum: ['pros', 'pro_services'] })
  @IsIn(['pros', 'pro_services'])
  targetEntity!: 'pros' | 'pro_services';

  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  proIds!: string[];

  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((dto: CreateBulkJobDto) => dto.targetEntity === 'pro_services')
  @IsUUID('4')
  serviceId?: string;

  @ApiPropertyOptional()
  @ValidateIf((dto: CreateBulkJobDto) => dto.targetEntity === 'pros')
  @IsBoolean()
  isAvailable?: boolean;

  @ApiPropertyOptional()
  @ValidateIf((dto: CreateBulkJobDto) => dto.targetEntity === 'pro_services')
  @IsBoolean()
  isActive?: boolean;
}

export class AdminJobQueryDto {
  @ApiPropertyOptional({ enum: ['bulk_update', 'report_export'] })
  @IsOptional()
  @IsIn(['bulk_update', 'report_export'])
  jobType?: string;
  @ApiPropertyOptional({
    enum: ['queued', 'running', 'completed', 'partial', 'failed'],
  })
  @IsOptional()
  @IsIn(['queued', 'running', 'completed', 'partial', 'failed'])
  status?: string;
  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take = 50;
}

export class PlatformSettingQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  cityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() key?: string;
}

export class UpsertPlatformSettingDto {
  @ApiProperty() @IsString() @MaxLength(500) value!: string;
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('4')
  cityId?: string;
}

export class ReassignBookingDto {
  @ApiProperty({ enum: ['specific_pro', 'redispatch'] })
  @IsIn(['specific_pro', 'redispatch'])
  mode!: 'specific_pro' | 'redispatch';
  @ApiPropertyOptional({ format: 'uuid' })
  @ValidateIf((dto: ReassignBookingDto) => dto.mode === 'specific_pro')
  @IsUUID('4')
  proId?: string;
  @ApiProperty({ minLength: 10, maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;
}
