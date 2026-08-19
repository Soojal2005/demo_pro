import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import {
  WalletStatementDto,
  WalletStatementQueryDto,
  WalletSummaryDto,
} from './dto/wallet.dto';
import { WalletService } from './wallet.service';

/**
 * The customer's Homingo Coins.
 *
 * Read-only, and deliberately so. There is no route anywhere in this API by
 * which a customer moves their own coins: they are earned by completing a
 * booking, spent by redeeming against one, and adjusted only by an admin with
 * their name on the row. A "spend coins" endpoint would be a second door into
 * the balance that the booking's own arithmetic could not see.
 */
@ApiTags('Loyalty · Wallet')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('customer')
@Controller('customers/me/wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  @ApiOperation({
    summary: 'My Homingo Coins',
    description:
      'Balance, what it is worth, the earn tier and how far the next one is. ' +
      '`earnRatePercent` is the number that answers "why am I earning what I ' +
      'am earning" without a support call.',
  })
  @ApiOkEnvelope(WalletSummaryDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  summary(@CurrentUser() user: AuthenticatedUser): Promise<WalletSummaryDto> {
    return this.wallet.summarise(user.id);
  }

  @Get('transactions')
  @ApiOperation({
    summary: 'My coin statement',
    description:
      'Every movement, newest first, each with a customer-readable reason. ' +
      'Cursor-paged — pass the previous response’s `nextCursor`.',
  })
  @ApiOkEnvelope(WalletStatementDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  transactions(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: WalletStatementQueryDto,
  ): Promise<unknown> {
    // The declared return is `unknown` rather than the DTO because `rupeeValue`
    // is a Prisma `Decimal` here and a string on the wire — its `toJSON`
    // handles the conversion, and asserting the DTO shape in TypeScript would
    // be claiming a cast that is not true at this point in the pipeline.
    // `@ApiOkEnvelope` above is what documents the real response.
    return this.wallet.listTransactions(user.id, query.limit, query.cursor);
  }
}
