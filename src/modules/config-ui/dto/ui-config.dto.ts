import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { UI_SEGMENTS } from '../ui-config.types';

export class CreateUiConfigDto {
  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('4')
  cityId?: string;

  @ApiProperty({ enum: UI_SEGMENTS })
  @IsIn(UI_SEGMENTS)
  userSegment!: string;

  @ApiProperty({ example: '1.0.0' })
  @Matches(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  minAppVersion!: string;

  @ApiProperty({ type: Object })
  @IsObject()
  jsonTree!: Record<string, unknown>;
}

export class UpdateUiConfigDto extends PartialType(CreateUiConfigDto) {}

export class UiConfigQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  cityId?: string;
  @ApiPropertyOptional({ enum: UI_SEGMENTS })
  @IsOptional()
  @IsIn(UI_SEGMENTS)
  segment?: string;
  @ApiPropertyOptional({ enum: ['draft', 'published', 'archived'] })
  @IsOptional()
  @IsIn(['draft', 'published', 'archived'])
  status?: string;
}

export class PublishUiConfigDto {
  @ApiProperty({ minLength: 10, maxLength: 500 })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class ResolveUiConfigQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  cityId?: string;
}
