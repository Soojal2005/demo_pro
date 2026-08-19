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
 * The Pro's side of safety and support — the same six routes the customer
 * has, and deliberately not a lesser version of them.
 *
 * Feature 2 makes the Pro's SOS symmetric with the customer's: a Pro in
 * transit or on site who does not feel safe, or who can see a dispute coming,
 * has the same one tap. A Pro app with a thinner safety feature than the
 * customer app would be a statement about whose safety counts.
 *
 * **The no-start ticket is not visible here.** A Pro who arrived and could not
 * start has an internal ops case opened about that job, and feature 13 makes
 * never surfacing it a design rule — handled quietly. `GET support/tickets`
 * excludes internal tickets in the query, and requesting one by id returns
 * `404`, not `403`.
 */
@ApiTags('Pro — Safety & Support')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('pro')
@Controller('pros/me')
export class ProSupportController {
  constructor(
    private readonly sos: SosService,
    private readonly tickets: SupportTicketsService,
  ) {}

  @Post('sos')
  @ApiOperation({
    summary: 'Raise an SOS',
    description:
      'One tap, for a Pro in transit or on site who does not feel safe, or ' +
      'who is facing a dispute risk.\n\n' +
      'Coordinates and `bookingId` are both optional. This does not create a ' +
      'ticket and never enters the ticket queue — on-duty admins are ' +
      'notified directly.',
  })
  @ApiCreatedEnvelope(SosAlertDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  raiseSos(@CurrentUser() user: AuthenticatedUser, @Body() dto: RaiseSosDto) {
    return this.sos.raise(user, 'pro', dto);
  }

  @Get('sos')
  @ApiOperation({ summary: 'My alerts' })
  @ApiOkEnvelope(SosAlertDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  listSos(@CurrentUser() user: AuthenticatedUser) {
    return this.sos.listForRaiser(user.id, 'pro');
  }

  @Post('support/tickets')
  @ApiOperation({
    summary: 'Raise a support ticket',
    description:
      'Categories: `billing`, `quality`, `dispute`, `app_issue`. ' +
      '`no_start` is not accepted here — it is raised by the system alone.',
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
    return this.tickets.createForRaiser(user.id, 'pro', dto);
  }

  @Get('support/tickets')
  @ApiOperation({
    summary: 'My tickets',
    description:
      'Tickets you raised. Internal ops cases about your jobs are not listed ' +
      'here and are not meant to be.',
  })
  @ApiOkEnvelope(SupportTicketDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  listTickets(@CurrentUser() user: AuthenticatedUser) {
    return this.tickets.listForRaiser(user.id, 'pro');
  }

  @Get('support/tickets/:id')
  @ApiOperation({ summary: 'One ticket, with its thread' })
  @ApiOkEnvelope(SupportTicketDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  getTicket(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.tickets.getForRaiser(id, user.id, 'pro');
  }

  @Post('support/tickets/:id/messages')
  @ApiOperation({ summary: 'Reply on a ticket' })
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
    return this.tickets.addRaiserMessage(id, user.id, 'pro', dto);
  }
}
