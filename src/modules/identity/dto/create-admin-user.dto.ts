import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MinLength,
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

  /**
   * The login identity. Firebase matches a Google sign-in to a password
   * account by this address, which is why both buttons on the console's login
   * screen land on the same admin.
   */
  @ApiProperty()
  @IsEmail()
  email: string;

  /**
   * Handed to Firebase and never stored here — this database holds no
   * credential to leak. The admin changes it through Firebase's own reset
   * flow, not through us.
   */
  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;

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
