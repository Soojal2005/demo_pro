import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/**
 * The editable half of an account.
 *
 * There is deliberately no `phone` here. It is the auth credential, and a
 * number that has not proved ownership through OTP must never become one.
 *
 * Every field is optional, and omitted is not the same as empty: omit to leave
 * a value alone, send "" to clear it. A single "" | undefined field would make
 * "I did not touch my email" indistinguishable from "delete my email".
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({
    description: 'Omit to leave unchanged; empty string clears it',
    example: 'Asha Nair',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    description: 'Omit to leave unchanged; empty string clears it',
    example: 'asha@example.com',
  })
  @IsOptional()
  @IsString()
  // Only validated as an address when there is one — "" is the documented way
  // to clear the field, and IsEmail would reject it.
  @ValidateIf((_object, value: unknown) => value !== '')
  @IsEmail({}, { message: 'email must be a valid email address' })
  @MaxLength(254)
  email?: string;
}
