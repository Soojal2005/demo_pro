import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { normaliseSearchTerm } from '../../../common/dto/search-term.transform';
import { PRO_STATUSES, type ProStatus } from '../pros.types';

export class AdminProQueryDto {
  @ApiPropertyOptional({
    description:
      'Matches full name, employee code or phone (partial, case-insensitive). ' +
      'Applied in the database, not to the returned page — the list is capped, ' +
      'so filtering it in the client would silently miss every Pro past the cap.',
  })
  @IsOptional()
  @Transform(({ value }): unknown => normaliseSearchTerm(value))
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  cityId?: string;

  @ApiPropertyOptional({ enum: PRO_STATUSES })
  @IsOptional()
  @IsIn(PRO_STATUSES)
  status?: ProStatus;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }): unknown => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  isAvailable?: boolean;
}
