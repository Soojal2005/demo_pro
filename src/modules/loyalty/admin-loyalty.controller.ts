import { randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCreatedEnvelope,
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { apiError } from '../../common/utils';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import {
  BlockReferralCodeDto,
  ReferralDto,
  RejectReferralDto,
} from './dto/referral.dto';
import {
  ActivateSubscriptionDto,
  CancelSubscriptionDto,
  CreateSubscriptionPlanDto,
  CustomerSubscriptionDto,
  PurchaseSubscriptionDto,
  SubscriptionPlanDto,
  UpdateSubscriptionPlanDto,
} from './dto/subscription-plan.dto';
import {
  AdjustWalletDto,
  WalletStatementDto,
  WalletSummaryDto,
  WalletTransactionDto,
} from './dto/wallet.dto';
import { LoyaltyWorkerService } from './loyalty-worker.service';
import { ReferralsService } from './referrals.service';
import { SubscriptionsService } from './subscriptions.service';
import { WalletService } from './wallet.service';

/**
 * Ops' side of module 16.
 *
 * Four permission codes rather than one, split by what each hands out: reading
 * a customer's position, creating coins from nothing, pricing the plan
 * catalogue, and granting one customer a plan. Nobody needs all four, and the
 * one that mints currency should never ride along with the one that reads a
 * list.
 */
@ApiTags('Admin — Loyalty')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/loyalty')
export class AdminLoyaltyController {
  constructor(
    private readonly wallet: WalletService,
    private readonly subscriptions: SubscriptionsService,
    private readonly referrals: ReferralsService,
    private readonly worker: LoyaltyWorkerService,
  ) {}

  // ------------------------------------------------------------------
  // Wallet
  // ------------------------------------------------------------------

  @Get('customers/:customerId/wallet')
  @RequirePermissions(PermissionCode.LOYALTY_READ)
  @ApiOperation({ summary: "One customer's coin position" })
  @ApiOkEnvelope(WalletSummaryDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  walletFor(
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ): Promise<WalletSummaryDto> {
    return this.wallet.summarise(customerId);
  }

  @Get('customers/:customerId/wallet/transactions')
  @RequirePermissions(PermissionCode.LOYALTY_READ)
  @ApiOperation({
    summary: 'Their coin statement',
    description: 'The same rows the customer sees, in the same order.',
  })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiOkEnvelope(WalletStatementDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  walletTransactions(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<unknown> {
    return this.wallet.listTransactions(
      customerId,
      limit ? Number(limit) : undefined,
      cursor,
    );
  }

  @Post('wallet/adjust')
  @RequirePermissions(PermissionCode.LOYALTY_WALLET_ADJUST)
  @ApiOperation({
    summary: 'Credit or debit a customer by hand',
    description:
      'The only route in this API that creates coins from nothing, which is ' +
      'why it has its own permission code and why the row always carries your ' +
      'admin id. `reason` is shown to the customer verbatim. Adjusted coins ' +
      'never expire — an apology with a 12-month fuse on it is a second ' +
      'complaint waiting. Send `adjustmentId` to make a retry safe.',
  })
  @ApiCreatedEnvelope(WalletTransactionDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
  )
  adjust(
    @CurrentUser() admin: AuthenticatedUser,
    @Body() dto: AdjustWalletDto,
  ): Promise<unknown> {
    return this.wallet.adjust({
      customerId: dto.customerId,
      coins: dto.coins,
      reason: dto.reason,
      adminId: admin.id,
      adjustmentId: dto.adjustmentId ?? randomUUID(),
    });
  }

  @Post('customers/:customerId/wallet/rebuild')
  @RequirePermissions(PermissionCode.LOYALTY_WALLET_ADJUST)
  @ApiOperation({
    summary: 'Recompute a balance from its own log',
    description:
      'The cached balance is a counter like every other one in this system: ' +
      'incremented on write, rebuilt from source, **source wins**. The log is ' +
      'the source. Reports whether it had drifted.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  rebuild(
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ): Promise<unknown> {
    return this.wallet.rebuildBalance(customerId);
  }

  // ------------------------------------------------------------------
  // Subscription catalogue
  // ------------------------------------------------------------------

  @Get('plans')
  @RequirePermissions(PermissionCode.LOYALTY_READ)
  @ApiOperation({ summary: 'Every plan, including retired ones' })
  @ApiOkEnvelope(SubscriptionPlanDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  listPlans(): Promise<unknown[]> {
    return this.subscriptions.listAllPlans();
  }

  @Post('plans')
  @RequirePermissions(PermissionCode.SUBSCRIPTION_PLAN_MANAGE)
  @ApiOperation({ summary: 'Add a plan to the catalogue' })
  @ApiCreatedEnvelope(SubscriptionPlanDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
  )
  createPlan(@Body() dto: CreateSubscriptionPlanDto): Promise<unknown> {
    return this.subscriptions.createPlan(dto);
  }

  @Patch('plans/:id')
  @RequirePermissions(PermissionCode.SUBSCRIPTION_PLAN_MANAGE)
  @ApiOperation({
    summary: 'Reprice or retire a plan',
    description:
      '**Live subscriptions are untouched.** Every perk was copied onto the ' +
      'customer’s row when they bought it, so this changes what new buyers ' +
      'get and nothing else. Retiring a plan (`isActive: false`) removes it ' +
      'from sale and leaves existing subscribers running to their expiry.',
  })
  @ApiOkEnvelope(SubscriptionPlanDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  updatePlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSubscriptionPlanDto,
  ): Promise<unknown> {
    return this.subscriptions.updatePlan(id, dto);
  }

  // ------------------------------------------------------------------
  // One customer's subscription
  // ------------------------------------------------------------------

  @Get('customers/:customerId/subscriptions')
  @RequirePermissions(PermissionCode.LOYALTY_READ)
  @ApiOperation({ summary: 'Their subscription history' })
  @ApiOkEnvelope(CustomerSubscriptionDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  subscriptionsFor(
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ): Promise<unknown[]> {
    return this.subscriptions.listForCustomer(customerId);
  }

  @Post('customers/:customerId/subscriptions')
  @RequirePermissions(PermissionCode.SUBSCRIPTION_MANAGE)
  @ApiOperation({
    summary: 'Grant or sell a plan on a customer’s behalf',
    description:
      'The only door through which a `complimentary` subscription can be ' +
      'created — the customer’s own route refuses one.',
  })
  @ApiCreatedEnvelope(CustomerSubscriptionDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  grant(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: PurchaseSubscriptionDto,
  ): Promise<unknown> {
    return this.subscriptions.purchase(
      customerId,
      dto.planId,
      dto.paymentMode ?? 'complimentary',
    );
  }

  @Post('subscriptions/:id/activate')
  @RequirePermissions(PermissionCode.SUBSCRIPTION_MANAGE)
  @ApiOperation({
    summary: 'Money received — start the clock',
    description:
      'Sets the window from the plan’s duration and grants the welcome coins. ' +
      'Idempotent: activating an already-active subscription returns it ' +
      'unchanged rather than extending it or paying the bonus twice.',
  })
  @ApiOkEnvelope(CustomerSubscriptionDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  activate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ActivateSubscriptionDto,
  ): Promise<unknown> {
    return this.subscriptions.activate(id, dto.paymentReference ?? null);
  }

  @Post('subscriptions/:id/cancel')
  @RequirePermissions(PermissionCode.SUBSCRIPTION_MANAGE)
  @ApiOperation({
    summary: 'End a subscription',
    description:
      'Records that it was stopped and by whom. **No refund is computed** — ' +
      'what a part-used plan is worth back is a judgement, not a formula, and ' +
      'the money goes back through the refund path.',
  })
  @ApiOkEnvelope(CustomerSubscriptionDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  cancelSubscription(
    @CurrentUser() admin: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelSubscriptionDto,
  ): Promise<unknown> {
    return this.subscriptions.cancel(id, dto.reason, admin.id);
  }

  // ------------------------------------------------------------------
  // Referrals
  // ------------------------------------------------------------------

  @Get('customers/:customerId/referrals')
  @RequirePermissions(PermissionCode.LOYALTY_READ)
  @ApiOperation({ summary: 'Everyone this customer has referred' })
  @ApiOkEnvelope(ReferralDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  referralsFor(
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ): Promise<unknown[]> {
    return this.referrals.listForReferrer(customerId);
  }

  @Patch('customers/:customerId/referral-code')
  @RequirePermissions(PermissionCode.REFERRAL_MODERATE)
  @ApiOperation({
    summary: 'Block or unblock one referral code',
    description:
      'The abuse brake: stops one account’s code without disabling the ' +
      'feature, and **without touching referrals already earned** — a reward ' +
      'fairly won is not clawed back by a later suspicion.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
  )
  blockCode(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: BlockReferralCodeDto,
  ): Promise<unknown> {
    if (dto.isBlocked && !dto.reason) {
      throw apiError(
        'Say why you are blocking this code',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'reason',
            message: 'Required when blocking',
            code: 'BLOCK_REASON_REQUIRED',
          },
        ],
      );
    }
    return this.referrals.setCodeBlocked(
      customerId,
      dto.isBlocked,
      dto.reason ?? null,
    );
  }

  @Post('referrals/:id/reject')
  @RequirePermissions(PermissionCode.REFERRAL_MODERATE)
  @ApiOperation({
    summary: 'Disallow a pending referral',
    description:
      'Refused outright once the referral has been **paid** — reversing coins ' +
      'already credited is a wallet adjustment, so that it appears in the ' +
      'customer’s statement with a reason rather than vanishing.',
  })
  @ApiOkEnvelope(ReferralDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  rejectReferral(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectReferralDto,
  ): Promise<unknown> {
    return this.referrals.reject(id, dto.reason);
  }

  // ------------------------------------------------------------------
  // The sweep
  // ------------------------------------------------------------------

  @Post('sweep')
  @RequirePermissions(PermissionCode.LOYALTY_WALLET_ADJUST)
  @ApiOperation({
    summary: 'Run the loyalty sweep now',
    description:
      'Expires lapsed coins and subscriptions, retries referrals that ' +
      'qualified but did not credit, and closes referral windows that passed ' +
      'without a booking. Runs on a timer too; this is the manual handle for ' +
      'support and for tests.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  sweep(): Promise<unknown> {
    return this.worker.runOnce();
  }
}
