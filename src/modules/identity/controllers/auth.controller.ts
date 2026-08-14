import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../../common/decorators/current-user.decorator';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import { FirebaseLoginDto } from '../dto/firebase-login.dto';
import { GuestSessionDto } from '../dto/guest-session.dto';
import { OtpRequestResponseDto } from '../dto/otp-request-response.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { RequestOtpDto } from '../dto/request-otp.dto';
import { TokenPairDto } from '../dto/token-pair.dto';
import { VerifyOtpDto } from '../dto/verify-otp.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { AuthService } from '../services/auth.service';
import { TokenPair } from '../services/token.service';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('guest-session')
  @ApiOperation({
    summary: 'Create/resume a guest customer session from a device id',
  })
  @ApiOkEnvelope(TokenPairDto)
  @ApiErrorEnvelope(HttpStatus.BAD_REQUEST)
  createGuestSession(@Body() dto: GuestSessionDto): Promise<TokenPair> {
    return this.authService.createGuestSession(dto);
  }

  @Post('otp/request')
  @ApiOperation({
    summary: 'Send a Slide OTP to a Customer, Pro, or existing Admin phone',
  })
  @ApiOkEnvelope(OtpRequestResponseDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.NOT_FOUND,
    HttpStatus.TOO_MANY_REQUESTS,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  requestOtp(@Body() dto: RequestOtpDto): Promise<{ providerRef: string }> {
    return this.authService.requestOtp(dto);
  }

  @Post('otp/verify')
  @ApiOperation({
    summary: 'Verify a Slide OTP and receive an actor-scoped token pair',
  })
  @ApiOkEnvelope(TokenPairDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.TOO_MANY_REQUESTS,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  verifyOtp(@Body() dto: VerifyOtpDto): Promise<TokenPair> {
    return this.authService.verifyOtp(dto);
  }

  @Post('admin/firebase-login')
  @ApiOperation({
    summary: 'Legacy Firebase login for already-linked admin accounts',
  })
  @ApiOkEnvelope(TokenPairDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  loginWithFirebase(@Body() dto: FirebaseLoginDto): Promise<TokenPair> {
    return this.authService.loginWithFirebase(dto);
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Rotate a refresh token for a new token pair' })
  @ApiOkEnvelope(TokenPairDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  refresh(@Body() dto: RefreshTokenDto): Promise<TokenPair> {
    return this.authService.refreshTokens(dto.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke the session tied to one refresh token' })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Revoke every session for the current identity' })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  async logoutAll(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.authService.logoutAll(user);
  }
}
