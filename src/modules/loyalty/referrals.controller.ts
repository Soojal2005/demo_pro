import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCreatedEnvelope,
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import {
  ApplyReferralCodeDto,
  ReferralDto,
  ReferralSummaryDto,
} from './dto/referral.dto';
import { ReferralsService } from './referrals.service';

/**
 * Refer & Earn.
 *
 * The rule every response here is written around: **the reward pays when the
 * new customer's first booking completes, not when they sign up.** Both sides
 * are told that up front — `qualifyWindowDays` on the share screen and a
 * `pending` status on the list — because a referral that silently never pays
 * is the single most common complaint this feature generates.
 */
@ApiTags('Loyalty · Referrals')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('customer')
@Controller('customers/me/referrals')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  @Get()
  @ApiOperation({
    summary: 'My referral code and how it is doing',
    description:
      'Mints the code on first call. `shareMessage` is ready to hand to the ' +
      'OS share sheet.',
  })
  @ApiOkEnvelope(ReferralSummaryDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  summary(@CurrentUser() user: AuthenticatedUser): Promise<ReferralSummaryDto> {
    return this.referrals.summarise(user.id);
  }

  @Get('sent')
  @ApiOperation({
    summary: 'People I have referred',
    description:
      'Newest first. `pending` means they have signed up but not yet had a ' +
      'job done — that is when the coins land.',
  })
  @ApiOkEnvelope(ReferralDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  sent(@CurrentUser() user: AuthenticatedUser): Promise<unknown[]> {
    return this.referrals.listForReferrer(user.id);
  }

  @Get('received')
  @ApiOperation({
    summary: 'The code I signed up with',
    description: 'Null if none. A customer can be referred once, ever.',
  })
  @ApiOkEnvelope(ReferralDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  received(@CurrentUser() user: AuthenticatedUser): Promise<unknown> {
    return this.referrals.findForReferee(user.id);
  }

  @Post('apply')
  @ApiOperation({
    summary: "Enter a friend's code",
    description:
      'Everything that can be refused is refused **here** rather than at ' +
      'reward time: unknown code, your own code, a blocked or capped code, an ' +
      'account that has already completed a booking. Nothing is credited yet — ' +
      'the coins arrive when your first job is done.',
  })
  @ApiCreatedEnvelope(ReferralDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.UNPROCESSABLE_ENTITY,
  )
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ApplyReferralCodeDto,
  ): Promise<unknown> {
    return this.referrals.attribute(user.id, dto.code);
  }
}
