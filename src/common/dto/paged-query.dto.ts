import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PageMetaDto {
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() total: number;
  @ApiProperty() totalPages: number;
}

/**
 * Page and size for an admin list.
 *
 * Shared so the console meets one paging contract rather than three: this
 * codebase grew a capped array, a `take`/`skip` pair and a `page`/`limit`
 * object in different modules, and a client cannot treat them alike.
 */
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

/** The envelope every paged admin list returns. */
export interface Paged<T> {
  data: T[];
  meta: PageMetaDto;
}

export function pageMeta(
  page: number,
  limit: number,
  total: number,
): PageMetaDto {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}
