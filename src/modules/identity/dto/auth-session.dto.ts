import { ApiProperty } from '@nestjs/swagger';
import { TokenPairDto } from './token-pair.dto';

/**
 * Swagger-only shape for AuthService's AuthAccount — see auth.service.ts.
 *
 * Nullable across the board because the three actor tables behind it disagree
 * about which of these they store: a Customer has no photo, a brand-new Pro
 * has no name yet, and only an Admin is required to have an email.
 */
export class AuthAccountDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ type: String, nullable: true, example: '+919876543210' })
  phone: string | null;

  @ApiProperty({ type: String, nullable: true })
  name: string | null;

  @ApiProperty({ type: String, nullable: true })
  email: string | null;

  @ApiProperty({ type: String, nullable: true })
  photoUrl: string | null;
}

/** Swagger-only shape for AuthService's AuthSession — see auth.service.ts. */
export class AuthSessionDto extends TokenPairDto {
  @ApiProperty({ description: 'True the first time this phone has verified' })
  isNewUser: boolean;

  @ApiProperty({ type: AuthAccountDto })
  user: AuthAccountDto;
}
