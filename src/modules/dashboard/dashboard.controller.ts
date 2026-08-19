import { Controller, Get, HttpStatus, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { DashboardService } from './dashboard.service';
import type { DashboardSummary } from './dashboard.types';

/** A week reads as a week; anything longer stops being "what is happening now". */
const DEFAULT_DAYS = 7;
const MAX_DAYS = 90;

@ApiTags('Admin — Dashboard')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('admin/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * Deliberately **not** guarded by `@RequirePermissions`.
   *
   * The dashboard spans domains that different roles are allowed to see. One
   * grant on the route would make the whole page a 403 for ops, who legitimately
   * read none of the money sections; no grant at all would hand them revenue.
   * So the route admits any authenticated admin and the service omits each
   * section the caller's role does not carry — the response shape is the
   * permission check.
   */
  @Get('summary')
  @ApiOperation({
    summary: 'Everything the first screen shows, in one call',
    description:
      'Counted, never listed — every admin list in this API is capped, so a ' +
      'figure derived from one silently reports the cap once the data outgrows ' +
      'it.\n\n' +
      '**Sections are omitted, not emptied, when the caller may not read them.** ' +
      'An ops admin gets no `money`; a finance admin gets no dispatch queue. ' +
      'Treat an absent key as "not for you", not as zero.\n\n' +
      'City-scoped admins see their own cities only, the same as every list.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query('days') days?: string,
  ): Promise<DashboardSummary> {
    const parsed = Number(days);
    return this.dashboard.summary({
      roleId: user.roleId,
      cityScope: user.cityScope,
      days:
        Number.isInteger(parsed) && parsed > 0
          ? Math.min(parsed, MAX_DAYS)
          : DEFAULT_DAYS,
    });
  }
}
