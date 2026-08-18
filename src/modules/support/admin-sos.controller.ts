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
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { AdminSosQueryDto, ResolveSosDto, SosAlertDto } from './dto/sos.dto';
import { SosService } from './sos.service';

/**
 * The ops SOS screen.
 *
 * Reading and responding are **two grants**. `safety.sos.respond` carries live
 * phone numbers and an address for somebody who has said they feel unsafe, and
 * that should be a deliberate grant rather than something riding along with
 * the ability to answer a billing question — the same reasoning that keeps
 * `payout.approve` separate from `payout.disburse`.
 */
@ApiTags('Admin — Safety')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/sos')
export class AdminSosController {
  constructor(private readonly sos: SosService) {}

  @Get()
  @RequirePermissions(PermissionCode.SOS_READ)
  @ApiOperation({
    summary: 'The alert queue',
    description:
      'Open first, then oldest first within each group — an alert waiting ' +
      'eleven minutes outranks one raised thirty seconds ago.\n\n' +
      'Each row carries `responseSeconds`, computed from the two timestamps ' +
      'rather than stored: an acknowledgement target nobody can measure is a ' +
      'target nobody meets.',
  })
  @ApiOkEnvelope(SosAlertDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  list(@Query() query: AdminSosQueryDto) {
    return this.sos.listForAdmin(query.status);
  }

  @Get(':id')
  @RequirePermissions(PermissionCode.SOS_READ)
  @ApiOperation({
    summary: 'One alert, with its frozen context',
    description:
      '`contextSnapshot` is the booking as it was **when the button was ' +
      'pressed** — booking, address, pin, and both parties’ phone numbers. It ' +
      'is never re-derived: by now the booking may be cancelled or ' +
      'reassigned, and the state that mattered is the state at the moment of ' +
      'the alert.',
  })
  @ApiOkEnvelope(SosAlertDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.sos.getForAdmin(id);
  }

  @Post(':id/acknowledge')
  @RequirePermissions(PermissionCode.SOS_RESPOND)
  @ApiOperation({
    summary: 'Acknowledge — I have seen this',
    description:
      '**Idempotent.** Two responders opening the same alert at once is the ' +
      'expected case; the first write owns the record and the second gets it ' +
      'back unchanged, so the response time is not rewritten by whoever ' +
      'clicked last.',
  })
  @ApiOkEnvelope(SosAlertDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  acknowledge(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.sos.acknowledge(id, actor.id);
  }

  @Post(':id/resolve')
  @RequirePermissions(PermissionCode.SOS_RESPOND)
  @ApiOperation({
    summary: 'Close the alert',
    description:
      'Requires a prior acknowledgement — closing something nobody admits to ' +
      'having seen is refused with `409`.\n\n' +
      '`false_alarm` is a real outcome, not a failure to respond. A pocket ' +
      'tap closed honestly is better data than one closed as `resolved`.',
  })
  @ApiOkEnvelope(SosAlertDto)
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
    @Body() dto: ResolveSosDto,
  ) {
    return this.sos.resolve(id, actor.id, dto);
  }
}
