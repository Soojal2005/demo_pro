import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
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
import { successResponse } from '../../common/utils';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { CommissionAdminService } from './commission-admin.service';
import { CommissionReversalService } from './commission-reversal.service';
import { CommissionService } from './commission.service';
import { DeductionsService } from './deductions.service';
import {
  AdminCommissionQueryDto,
  DeductionLineDto,
  AdminDeductionStatementDto,
  MissingCommissionServiceDto,
  RaiseDeductionDto,
  ReversalOutcomeDto,
  ReverseCommissionDto,
  SweepResultDto,
  WaiveDeductionDto,
} from './dto/earnings.dto';

/**
 * Commissions, reversals and deductions, for finance.
 *
 * `payout.read` browses; `payout.adjust` changes what somebody is owed. They
 * are separate grants because the second one is the only way, anywhere in this
 * API, to reduce a Pro's pay — and it should not ride along with the ability to
 * look at a list.
 */
@ApiTags('Admin — Commission')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin')
export class AdminCommissionController {
  constructor(
    private readonly admin: CommissionAdminService,
    private readonly commissions: CommissionService,
    private readonly reversals: CommissionReversalService,
    private readonly deductions: DeductionsService,
  ) {}

  // ------------------------------------------------------------------
  // Commissions
  // ------------------------------------------------------------------

  @Get('commissions')
  @RequirePermissions(PermissionCode.PAYOUT_READ)
  @ApiOperation({
    summary: 'List computed commissions',
    description:
      'Each row carries the rate snapshotted at completion, not the service’s ' +
      'rate today — which is what lets a change of rate be told apart from a ' +
      'mistake.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  list(@Query() query: AdminCommissionQueryDto) {
    return this.admin.commissions(query);
  }

  @Get('commissions/:id')
  @RequirePermissions(PermissionCode.PAYOUT_READ)
  @ApiOperation({ summary: 'One commission in full' })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  one(@Param('id') id: string) {
    return this.admin.commission(id);
  }

  @Post('commissions/:id/reverse')
  @RequirePermissions(PermissionCode.PAYOUT_ADJUST)
  @ApiOperation({
    summary: 'Reverse a commission',
    description:
      'Does the right thing for the state the row is in. Not yet paid: it is ' +
      'marked reversed and never enters a payout. Already paid: it **stays ' +
      'paid** — it was — and an itemised deduction is raised against the next ' +
      'payout. **No bank debit exists anywhere in this API.**\n\n' +
      'Bonus progress the job contributed to is unwound at the same time, and ' +
      'any bonus already credited against it is recovered the same way.\n\n' +
      'Idempotent: reversing twice returns the first result and charges nothing ' +
      'further.',
  })
  @ApiOkEnvelope(ReversalOutcomeDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async reverse(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ReverseCommissionDto,
  ) {
    const outcome = await this.reversals.reverse(id, dto.reason, user.id);
    return successResponse({
      data: outcome,
      message:
        outcome.effect === 'deducted'
          ? `Reversed. ${outcome.deductedAmount} will be deducted from the next payout.`
          : 'Reversed before payment — nothing is owed.',
    });
  }

  @Post('commissions/:id/deduction')
  @RequirePermissions(PermissionCode.PAYOUT_ADJUST)
  @ApiOperation({
    summary: 'Raise a deduction against one job',
    description:
      'For a cost attributable to a job — damage, a replacement uniform. Comes ' +
      'off a future payout, never out of a bank account. Unlike a reversal this ' +
      'has no dedupe key, because ops may legitimately raise two against the ' +
      'same job.',
  })
  @ApiCreatedEnvelope(DeductionLineDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async deduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RaiseDeductionDto,
  ) {
    const commission = await this.admin.commission(id);
    const raised = await this.deductions.raise({
      proId: commission.proId,
      amount: dto.amount,
      kind: 'manual',
      reason: dto.reason,
      sourceCommissionId: commission.id,
      raisedByAdminId: user.id,
    });
    await this.commissions.refreshTotals(commission.id);

    return successResponse({
      data: raised,
      message: `${dto.amount} will be deducted from this Pro’s next payout.`,
      statusCode: HttpStatus.CREATED,
    });
  }

  @Post('commissions/recompute-missing')
  @RequirePermissions(PermissionCode.PAYOUT_ADJUST)
  @ApiOperation({
    summary: 'Run the missing-commission sweeper now',
    description:
      'The same pass that runs on a timer. Run it by hand after setting a rate ' +
      'on a service that was live without one — every completed job on it ' +
      'inside the lookback window is then paid.',
  })
  @ApiOkEnvelope(SweepResultDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  async sweep() {
    const result = await this.commissions.sweepMissing();
    return successResponse({
      data: result,
      message:
        result.found === 0
          ? 'Nothing missing — every completed job in the window has been paid.'
          : `Found ${result.found} unpaid completed job(s) and wrote ${result.written}.`,
    });
  }

  @Get('services/missing-commission')
  @RequirePermissions(PermissionCode.CATALOG_COMMISSION_SET)
  @ApiOperation({
    summary: 'Services with no commission rate',
    description:
      'Should always be empty: activation is gated on a rate being set ' +
      '(US-3.11). A non-empty result is an alert, not a report — every ' +
      '`unpaidCompletedJobs` is work somebody did for nothing (US-8.8).',
  })
  @ApiOkEnvelope(MissingCommissionServiceDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  missingRates() {
    return this.admin.servicesMissingCommission();
  }

  // ------------------------------------------------------------------
  // Deductions
  // ------------------------------------------------------------------

  @Get('pros/:id/deductions')
  @RequirePermissions(PermissionCode.PAYOUT_READ)
  @ApiOperation({ summary: 'Everything outstanding against one Pro' })
  @ApiOkEnvelope(AdminDeductionStatementDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  proDeductions(@Param('id') proId: string) {
    return this.admin.deductionsForPro(proId);
  }

  @Post('deductions/:id/waive')
  @RequirePermissions(PermissionCode.PAYOUT_ADJUST)
  @ApiOperation({
    summary: 'Forgive what is left of a deduction',
    description:
      'Only the unrecovered part can be waived. A part already taken out of a ' +
      'payout that has been sent cannot be un-taken here — doing so would leave ' +
      'the books saying the Pro was paid an amount they were not.',
  })
  @ApiOkEnvelope(DeductionLineDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async waive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: WaiveDeductionDto,
  ) {
    const waived = await this.deductions.waive(id, dto.reason, user.id);
    return successResponse({ data: waived, message: 'Deduction waived.' });
  }
}
