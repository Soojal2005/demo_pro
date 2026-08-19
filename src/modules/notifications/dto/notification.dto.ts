import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { NOTIFICATION_CHANNELS } from '../notification.types';

export class RegisterPushTokenDto {
  @ApiProperty({ minLength: 16, maxLength: 4096 })
  @IsString()
  @MinLength(16)
  @MaxLength(4096)
  token!: string;

  @ApiProperty({ enum: ['android', 'ios'] })
  @IsIn(['android', 'ios'])
  platform!: 'android' | 'ios';
}

export class UpdateNotificationTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isCritical?: boolean;

  @ApiPropertyOptional({ enum: NOTIFICATION_CHANNELS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsIn(NOTIFICATION_CHANNELS, { each: true })
  channels?: string[];

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  pushTitle?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  pushBody?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  whatsappTemplate?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  smsBody?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10)
  retryLimit?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 3600 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3600)
  fallbackDelaySeconds?: number;
}

export class NotificationQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  bookingId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  cityId?: string;

  @ApiPropertyOptional({
    enum: [
      'queued',
      'sending',
      'accepted',
      'delivered',
      'failed',
      'skipped',
      'read',
    ],
  })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ enum: NOTIFICATION_CHANNELS })
  @IsOptional()
  @IsIn(NOTIFICATION_CHANNELS)
  channel?: string;
}

export class ProviderDeliveryWebhookDto {
  @ApiProperty()
  @IsString()
  providerReference!: string;

  @ApiProperty({ enum: ['delivered', 'failed', 'read'] })
  @IsIn(['delivered', 'failed', 'read'])
  status!: 'delivered' | 'failed' | 'read';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  failureCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  failureReason?: string;
}
