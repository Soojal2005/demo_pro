import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { normalizePhone } from './phone.transform';

export class CreateAdminUserDto {
  @ApiProperty({ example: '+919876500000' })
  @Transform(({ value }: { value: unknown }) => normalizePhone(value))
  @Matches(/^\+[1-9]\d{7,14}$/, {
    message: 'phone must be E.164 or a valid 10-digit Indian mobile number',
  })
  phone: string;

  @ApiProperty()
  @IsString()
  fullName: string;

  /** Contact and audit email; Admin authentication uses the phone OTP flow. */
  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsUUID()
  roleId: string;

  @ApiPropertyOptional({
    description:
      'City ids this admin may act on. Empty/omitted = platform-wide.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  cityScopeJson?: string[];
}
