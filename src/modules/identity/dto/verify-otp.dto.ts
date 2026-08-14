import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches } from 'class-validator';
import type { ActorType } from '../../../common/types/authenticated-user.type';
import { normalizePhone } from './phone.transform';

const ACTOR_TYPES: ActorType[] = ['customer', 'pro', 'admin'];

export class VerifyOtpDto {
  @ApiProperty({
    example: '+919876543210',
    description:
      'E.164, or a 10-digit Indian mobile number which is normalized to +91',
  })
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'phone must be E.164 or a valid 10-digit Indian mobile number',
  })
  phone: string;

  @ApiProperty({ example: '123456' })
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit number' })
  code: string;

  @ApiProperty({ description: 'providerRef returned by /auth/otp/request' })
  @IsString()
  providerRef: string;

  @ApiProperty({ enum: ACTOR_TYPES })
  @IsIn(ACTOR_TYPES)
  actorType: ActorType;

  @ApiPropertyOptional({
    description:
      'Customer only — links a guest session (created from device id) to the verified account',
  })
  @IsOptional()
  @IsString()
  deviceId?: string;
}
