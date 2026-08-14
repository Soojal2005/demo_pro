import {
  BadRequestException,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AssignmentCandidate } from '../../prisma/client';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { AssignmentCandidateDto } from './dto/assignment-candidate.dto';
import { DispatchService } from './dispatch.service';

/**
 * The Live Dispatch surface.
 *
 * Most of it exists so ops never has to escalate "why was this Pro chosen?" to
 * engineering — that is the entire justification for persisting candidates.
 */
@ApiTags('Admin — Dispatch')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/dispatch')
export class AdminDispatchController {
  constructor(private readonly dispatch: DispatchService) {}

  @Get('queue')
  @RequirePermissions(PermissionCode.DISPATCH_OVERRIDE)
  @ApiOperation({ summary: 'How many bookings are waiting to be dispatched' })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  async queue(): Promise<{ depth: number }> {
    return { depth: await this.dispatch.queueDepth() };
  }

  @Post('drain')
  @RequirePermissions(PermissionCode.DISPATCH_OVERRIDE)
  @ApiOperation({
    summary: 'Run the queue now',
    description:
      'Safe to call concurrently — the per-booking lock is what guarantees a ' +
      'booking is never double-assigned, not the caller.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  drain(@Query('max') max?: string) {
    let parsedMax: number | undefined;
    if (max !== undefined) {
      if (!/^\d+$/.test(max)) {
        throw new BadRequestException('max must be an integer from 0 to 100');
      }
      parsedMax = Number(max);
      if (parsedMax > 100) {
        throw new BadRequestException('max must be an integer from 0 to 100');
      }
    }
    return this.dispatch.drain(parsedMax);
  }

  @Post('bookings/:id/run')
  @RequirePermissions(PermissionCode.DISPATCH_OVERRIDE)
  @ApiOperation({
    summary: 'Dispatch one booking now',
    description:
      'Retries a booking that failed to assign, without waiting for a drain.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  run(@Param('id') id: string) {
    return this.dispatch.run(id);
  }

  @Get('bookings/:id/candidates')
  @RequirePermissions(PermissionCode.DISPATCH_OVERRIDE)
  @ApiOperation({
    summary: 'Why this Pro, and why not that one',
    description:
      'Every Pro the engine considered, per attempt. A **null `rank` with an ' +
      '`excludedReason`** means never a candidate; a rank means considered and ' +
      'ranked. Those are different conversations (US-5.11). `ratingScore` is ' +
      'the **smoothed** value, not the Pro’s displayed rating — a 5.0 from two ' +
      'reviews can legitimately lose to a 4.6 from two hundred.',
  })
  @ApiOkEnvelope(AssignmentCandidateDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  candidates(@Param('id') id: string): Promise<AssignmentCandidate[]> {
    return this.dispatch.listCandidates(id);
  }

  @Get('unassignable')
  @RequirePermissions(PermissionCode.DISPATCH_OVERRIDE)
  @ApiOperation({
    summary: 'Bookings nobody could take',
    description:
      '`no_supply` means nobody holds this service here at all — a structural ' +
      'supply gap. `exhausted` means candidates existed and were all tried. ' +
      'They are different problems and must not be triaged together.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  unassignable() {
    return this.dispatch.listUnassignable();
  }

  @Post('expire-acknowledgements')
  @RequirePermissions(PermissionCode.DISPATCH_OVERRIDE)
  @ApiOperation({
    summary: 'Close attempts nobody acknowledged and retry them',
    description:
      'The silent Pro is excluded as `already_tried` on the next attempt. ' +
      'Their acceptance rate moves; their ranking does not.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  expire(@Query('at') at?: string) {
    if (!at) return this.dispatch.expireAcknowledgements();

    const parsedAt = new Date(at);
    if (Number.isNaN(parsedAt.getTime())) {
      throw new BadRequestException('at must be a valid ISO-8601 timestamp');
    }
    return this.dispatch.expireAcknowledgements(parsedAt);
  }
}
