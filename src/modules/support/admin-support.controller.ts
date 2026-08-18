import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { DisputeEvidenceService } from './dispute-evidence.service';
import {
  AddTicketMessageDto,
  AdminCreateTicketDto,
  AdminTicketQueryDto,
  AssignTicketDto,
  EscalateTicketDto,
  ResolveTicketDto,
  SupportTicketDto,
  TicketMessageDto,
} from './dto/ticket.dto';
import { SupportTicketsService } from './support-tickets.service';
import { SupportWorkerService } from './support-worker.service';

/** The ops ticket queue, the evidence bundle, and the sweep. */
@ApiTags('Admin — Support')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/support')
export class AdminSupportController {
  constructor(
    private readonly tickets: SupportTicketsService,
    private readonly evidence: DisputeEvidenceService,
    private readonly worker: SupportWorkerService,
  ) {}

  @Get('tickets')
  @RequirePermissions(PermissionCode.SUPPORT_TICKET_READ)
  @ApiOperation({
    summary: 'The ticket queue',
    description:
      'Includes internal tickets — the system-raised no-start incidents ' +
      'live here and nowhere else.',
  })
  @ApiOkEnvelope(SupportTicketDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  list(@Query() query: AdminTicketQueryDto) {
    return this.tickets.listForAdmin(query);
  }

  @Get('tickets/:id')
  @RequirePermissions(PermissionCode.SUPPORT_TICKET_READ)
  @ApiOperation({
    summary: 'One ticket, with the full thread',
    description: 'Internal notes included — this is the ops view.',
  })
  @ApiOkEnvelope(SupportTicketDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.tickets.getForAdmin(id);
  }

  @Get('tickets/:id/evidence')
  @RequirePermissions(PermissionCode.SUPPORT_TICKET_READ)
  @ApiOperation({
    summary: 'The evidence behind a disputed job',
    description:
      'Status timeline with coordinates, geo-stamped photo proof, the chat ' +
      "log, the customer's own review photos, and the route trail.\n\n" +
      'This wraps module 4’s one-call reconstruction rather than reassembling ' +
      'it — a second evidence assembler is how two tabs of a dispute screen ' +
      'end up disagreeing about the same job.\n\n' +
      '**`routeTrail` reports `available: false` today.** Nothing accumulates ' +
      'a GPS trail until module 13 instalment 2. An empty array would read as ' +
      '"the Pro went nowhere", which is a claim this API will not make.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  forTicket(@Param('id', ParseUUIDPipe) id: string) {
    return this.evidence.forTicket(id);
  }

  @Post('tickets')
  @RequirePermissions(PermissionCode.SUPPORT_TICKET_MANAGE)
  @ApiOperation({
    summary: 'Raise a ticket on behalf of a party, or open an internal case',
  })
  @ApiCreatedEnvelope(SupportTicketDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
  )
  create(@Body() dto: AdminCreateTicketDto) {
    return this.tickets.createForAdmin(dto);
  }

  @Post('tickets/:id/messages')
  @RequirePermissions(PermissionCode.SUPPORT_TICKET_MANAGE)
  @ApiOperation({
    summary: 'Reply, or leave an internal note',
    description:
      '`isInternalNote: true` is never loaded on the raiser’s read path and ' +
      'never triggers a notification — announcing that a note arrived would ' +
      'announce a conversation they cannot read.',
  })
  @ApiCreatedEnvelope(TicketMessageDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  message(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: AddTicketMessageDto,
  ) {
    return this.tickets.addAdminMessage(id, actor.id, dto);
  }

  @Post('tickets/:id/assign')
  @RequirePermissions(PermissionCode.SUPPORT_TICKET_MANAGE)
  @ApiOperation({
    summary: 'Assign to a support admin',
    description:
      'Refused with `409` if the assignee lacks `support.ticket.manage`. An ' +
      'assignee who cannot act on the ticket produces one that looks owned ' +
      'and is parked forever — the worst state in a queue, because it stops ' +
      'being triaged without ever being worked.',
  })
  @ApiOkEnvelope(SupportTicketDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignTicketDto) {
    return this.tickets.assign(id, dto);
  }

  @Post('tickets/:id/escalate')
  @RequirePermissions(PermissionCode.SUPPORT_TICKET_MANAGE)
  @ApiOperation({
    summary: 'Escalate',
    description:
      'Always writes the reason into the thread as a system note. A status ' +
      'change with no explanation is a status change, not an escalation.',
  })
  @ApiOkEnvelope(SupportTicketDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  escalate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: EscalateTicketDto,
  ) {
    return this.tickets.escalate(id, actor.id, dto);
  }

  @Post('tickets/:id/resolve')
  @RequirePermissions(PermissionCode.SUPPORT_TICKET_MANAGE)
  @ApiOperation({
    summary: 'Close with resolution notes',
    description:
      'Notes and `actionTaken` are both required here **and** by a database ' +
      'CHECK constraint.\n\n' +
      '`actionTaken` is a **record of a decision, not an instruction**. ' +
      'Suspending a Pro is module 6’s endpoint, called separately — two ' +
      'writers of `Pro.status` is a bug pattern this codebase has already ' +
      'paid for once.',
  })
  @ApiOkEnvelope(SupportTicketDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: ResolveTicketDto,
  ) {
    return this.tickets.resolve(id, actor.id, dto);
  }

  @Post('sweep')
  @RequirePermissions(PermissionCode.SUPPORT_TICKET_MANAGE)
  @ApiOperation({
    summary: 'Run the no-start sweep now',
    description:
      'The same pass the worker runs every two minutes, exposed because a ' +
      'background job nobody can trigger is a background job nobody can ' +
      'test.\n\n' +
      'Returns what it scanned, what it raised, and what it auto-resolved — ' +
      'jobs that started late close themselves rather than leaving ops a ' +
      'queue of incidents that fixed themselves.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  sweep() {
    return this.worker.runOnce();
  }
}
