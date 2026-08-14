import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

/**
 * Admin listings show drafts and deactivated rows by default — that is the
 * point of them. `isActive` narrows when ops wants only one side.
 */
export class AdminCatalogQueryDto {
  @ApiPropertyOptional({ description: 'Restrict services to one category.' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    description: 'Omit to see both active and inactive rows.',
  })
  @IsOptional()
  @Transform(({ value, obj, key }): unknown => {
    const raw = (obj as Record<string, unknown>)[key];
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return value;
  })
  @IsBoolean()
  isActive?: boolean;
}
