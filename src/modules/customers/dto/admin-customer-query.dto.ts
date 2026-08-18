import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { normaliseSearchTerm } from '../../../common/dto/search-term.transform';

export class AdminCustomerQueryDto {
  @ApiPropertyOptional({
    description:
      'Matches phone, email or full name (partial, case-insensitive).',
  })
  @IsOptional()
  @Transform(({ value }): unknown => normaliseSearchTerm(value))
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ enum: ['guest', 'verified'] })
  @IsOptional()
  @IsIn(['guest', 'verified'])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value, obj, key }): unknown => {
    const raw = (obj as Record<string, unknown>)[key];
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return value;
  })
  @IsBoolean()
  isBlocked?: boolean;
}
