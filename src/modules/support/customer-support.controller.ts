import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
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
import { RaiseSosDto, SosAlertDto } from './dto/sos.dto';
import {
  AddTicketMessageDto,
  CreateTicketDto,
  SupportTicketDto,
  TicketMessageDto,
} from './dto/ticket.dto';
import { SosService } from './sos.service';
import { SupportTicketsService } from './support-tickets.service';

/**
 * The customer's side of safety and support.
 *
 * Internal tickets — the quietly-handled no-start incidents — are invisible
 * here at every depth, and a request for one returns `404` rather than `403`:
 * a `403` would confirm it exists.
 */
@ApiTags('Customer — Safety & Support')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('customer')
@Controller('customers/me')
export class CustomerSupportController {
  constructor(
    private readonly sos: SosService,
    private readonly tickets: SupportTicketsService,
  ) {}

  @Post('sos')
  @ApiOperation({
    summary: 'Raise an SOS',
    description:
      'One tap, for a situation such as being alone at home and ' +
      'uncomfortable.\n\n' +
      '**Everything in the body is optional.** Coordinates especially: a ' +
      'phone that cannot get a fix must still be able to raise an alert. A ' +
      'missing pin degrades the response; refusing the alert defeats the ' +
      'feature.\n\n' +
      'This does **not** create a support ticket and never enters the ticket ' +
      'queue. On-duty admins holding `safety.sos.respond` are notified ' +
      'directly, in the same transaction that writes the alert.\n\n' +
      'There is deliberately no rate limit. Somebody pressing this twice is ' +
      'telling us something.',
  })
  @ApiCreatedEnvelope(SosAlertDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  raiseSos(@CurrentUser() user: AuthenticatedUser, @Body() dto: RaiseSosDto) {
    return this.sos.raise(user, 'customer', dto);
  }

  @Get('sos')
  @ApiOperation({
    summary: 'My alerts',
    description:
      'Status and timestamps only. Ops notes and the context snapshot are ' +
      'not returned — they are for whoever is responding.',
  })
  @ApiOkEnvelope(SosAlertDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  listSos(@CurrentUser() user: AuthenticatedUser) {
    return this.sos.listForRaiser(user.id, 'customer');
  }

  @Post('support/tickets')
  @ApiOperation({
    summary: 'Raise a support ticket',
    description:
      'Categories: `billing`, `quality`, `dispute`, `app_issue`. ' +
      '`no_start` is **not** accepted — it is a system-detected exception, ' +
      'and a ticket that looks system-raised and is not would be worse than ' +
      'no ticket.\n\n' +
      'A `dispute` requires the `bookingId` it is about; without one the ' +
      'evidence bundle has nothing to assemble.\n\n' +
      'Priority is not yours to set. Ops triages — every self-service ticket ' +
      'would otherwise be urgent, which is the same as none being urgent.',
  })
  @ApiCreatedEnvelope(SupportTicketDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  createTicket(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTicketDto,
  ) {
    return this.tickets.createForRaiser(user.id, 'customer', dto);
  }

  @Get('support/tickets')
  @ApiOperation({ summary: 'My tickets' })
  @ApiOkEnvelope(SupportTicketDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  listTickets(@CurrentUser() user: AuthenticatedUser) {
    return this.tickets.listForRaiser(user.id, 'customer');
  }

  @Get('support/tickets/:id')
  @ApiOperation({
    summary: 'One ticket, with its thread',
    description:
      'Internal notes are **never loaded** on this path — they are excluded ' +
      'in the query, not filtered out afterwards, so a future `include` ' +
      'cannot leak them.',
  })
  @ApiOkEnvelope(SupportTicketDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  getTicket(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.tickets.getForRaiser(id, user.id, 'customer');
  }

  @Post('support/tickets/:id/messages')
  @ApiOperation({
    summary: 'Reply on a ticket',
    description:
      'A reply to a **resolved** ticket reopens it. Resolution is ops’s ' +
      'opinion that the problem is over; only your silence confirms it. ' +
      'Writes stop once a ticket is `closed`; reads never do.',
  })
  @ApiCreatedEnvelope(TicketMessageDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  reply(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AddTicketMessageDto,
  ) {
    return this.tickets.addRaiserMessage(id, user.id, 'customer', dto);
  }
}
