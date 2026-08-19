import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, Matches } from 'class-validator';
import type { ActorType } from '../../../common/types/authenticated-user.type';
import { normalizePhone } from './phone.transform';

/**
 * Admins are absent on purpose. They authenticate through Firebase
 * (`POST auth/admin/firebase-login`), which is the console's only door in.
 * Rejecting `admin` here means the refusal is a clean 400 at validation
 * rather than a service that has to explain itself.
 */
const ACTOR_TYPES: ActorType[] = ['customer', 'pro'];

export class RequestOtpDto {
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

  @ApiProperty({ enum: ACTOR_TYPES })
  @IsIn(ACTOR_TYPES)
  actorType: ActorType;
}
