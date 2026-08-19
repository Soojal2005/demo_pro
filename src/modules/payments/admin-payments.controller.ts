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
import { apiError, successResponse } from '../../common/utils';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { CashHandoverService } from './cash-handover.service';
import {
  CashHandoverDto,
  ConfirmHandoverDto,
  RejectHandoverDto,
} from './dto/cash.dto';
import { OrderDto } from './dto/order.dto';
import {
  InitiateRefundDto,
  PaymentAttemptDto,
  ReconciliationQueryDto,
  ReconciliationReportDto,
} from './dto/refund.dto';
import { AdminOrderQueryDto } from './dto/admin-order-query.dto';
import { pageMeta } from '../../common/dto/paged-query.dto';
import { OrdersService } from './orders.service';
import { ReconciliationService } from './reconciliation.service';
import { RefundsService } from './refunds.service';

@ApiTags('Admin — Payments')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin')
export class AdminPaymentsController {
  constructor(
    private readonly orders: OrdersService,
    private readonly refunds: RefundsService,
    private readonly handovers: CashHandoverService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  // ------------------------------------------------------------------
  // Orders — feature 7
  // ------------------------------------------------------------------

  @Get('orders')
  @RequirePermissions(PermissionCode.PAYMENT_READ)
  @ApiOperation({
    summary: 'List gateway orders',
    description:
      'Online bookings only. **A cash booking has no order row at all**, so ' +
      'this list is not a list of payments — any total taken from it ' +
      'undercounts every cash job.',
  })
  @ApiOkEnvelope(OrderDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  async list(@Query() query: AdminOrderQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [items, total] = await this.orders.list(
      {
        ...(query.search
          ? {
              OR: [
                {
                  booking: {
                    bookingNumber: {
                      contains: query.search,
                      mode: 'insensitive' as const,
                    },
                  },
                },
                {
                  razorpayOrderId: {
                    contains: query.search,
                    mode: 'insensitive' as const,
                  },
                },
              ],
            }
          : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.bookingId ? { bookingId: query.bookingId } : {}),
      },
      limit,
      (page - 1) * limit,
    );

    // `meta`, not a sentence in `message`. The total used to be readable only
    // by parsing "50 orders" out of the message, so the console never did —
    // it paged the first fifty rows client-side and every order past them was
    // unreachable, with the page numbers claiming otherwise.
    return successResponse({
      data: { data: items, meta: pageMeta(page, limit, total) },
    });
  }

  @Get('orders/:id')
  @RequirePermissions(PermissionCode.PAYMENT_READ)
  @ApiOperation({ summary: 'One order' })
  @ApiOkEnvelope(OrderDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  findOne(@Param('id') id: string): Promise<OrderDto> {
    return this.orders.findByIdOrFail(id) as unknown as Promise<OrderDto>;
  }

  /**
   * Feature 7 — the attempt list, fetched live and never stored.
   *
   * This is the module's stated trade-off honoured rather than worked around:
   * retries and duplicate charges are answered from Razorpay, by order id. The
   * route exists so support does not need a dashboard login for the common
   * case; the data still does not live here.
   */
  @Get('orders/:id/attempts')
  @RequirePermissions(PermissionCode.PAYMENT_READ)
  @ApiOperation({
    summary: 'Every attempt against an order',
    description:
      'Fetched from Razorpay on each call and never persisted. Amounts are in ' +
      'PAISE, exactly as the gateway reports them.',
  })
  @ApiOkEnvelope(PaymentAttemptDto, { isArray: true })
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  async attempts(@Param('id') id: string): Promise<PaymentAttemptDto[]> {
    const order = await this.orders.findByIdOrFail(id);
    return await this.orders.fetchAttempts(order.razorpayOrderId);
  }

  // ------------------------------------------------------------------
  // Refunds — feature 8
  // ------------------------------------------------------------------

  @Post('bookings/:id/refund')
  @RequirePermissions(PermissionCode.PAYMENT_REFUND)
  @ApiOperation({
    summary: 'Refund a booking, fully or partly',
    description:
      'Returns as soon as Razorpay accepts the call, with `refundStatus = ' +
      'initiated`. The money reaches the customer in 5–7 working days and the ' +
      '`refund.processed` webhook moves it to `settled` — the customer must be ' +
      'able to tell those apart. Partial refunds accumulate.',
  })
  @ApiCreatedEnvelope(OrderDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  refund(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') bookingId: string,
    @Body() dto: InitiateRefundDto,
  ): Promise<OrderDto> {
    return this.refunds.initiate({
      bookingId,
      amount: dto.amount,
      reason: dto.reason,
      adminId: user.id,
    }) as unknown as Promise<OrderDto>;
  }

  // ------------------------------------------------------------------
  // Cash handovers — feature 15
  // ------------------------------------------------------------------

  @Get('cash-handovers')
  @RequirePermissions(PermissionCode.CASH_HANDOVER_CONFIRM)
  @ApiOperation({ summary: 'Handovers waiting to be counted' })
  @ApiOkEnvelope(CashHandoverDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  pending(): Promise<CashHandoverDto[]> {
    return this.handovers.listPending() as unknown as Promise<
      CashHandoverDto[]
    >;
  }

  @Post('cash-handovers/:id/confirm')
  @RequirePermissions(PermissionCode.CASH_HANDOVER_CONFIRM)
  @ApiOperation({
    summary: 'Confirm a handover you have counted',
    description:
      'The **only** operation that reduces a Pro’s balance. It moves by what ' +
      'you counted, not by what was declared — so a short handover leaves the ' +
      'difference still owed rather than writing it off.',
  })
  @ApiCreatedEnvelope(CashHandoverDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ConfirmHandoverDto,
  ): Promise<CashHandoverDto> {
    return this.handovers.confirm({
      handoverId: id,
      adminId: user.id,
      confirmedAmount: dto.confirmedAmount,
      notes: dto.notes,
    }) as unknown as Promise<CashHandoverDto>;
  }

  @Post('cash-handovers/:id/reject')
  @RequirePermissions(PermissionCode.CASH_HANDOVER_CONFIRM)
  @ApiOperation({
    summary: 'Reject a handover',
    description: 'The balance is untouched — nothing was recovered.',
  })
  @ApiCreatedEnvelope(CashHandoverDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectHandoverDto,
  ): Promise<CashHandoverDto> {
    return this.handovers.reject({
      handoverId: id,
      adminId: user.id,
      reason: dto.reason,
    }) as unknown as Promise<CashHandoverDto>;
  }

  // ------------------------------------------------------------------
  // Reconciliation — features 10 and 18
  // ------------------------------------------------------------------

  @Get('payments/reconciliation')
  @RequirePermissions(PermissionCode.PAYMENT_READ)
  @ApiOperation({
    summary: 'Cross-check our records against Razorpay and against cash',
    description:
      'Computed on the call and **not stored** — `ReconciliationRun` belongs ' +
      'to module 9. Nothing is auto-corrected: a discrepancy is a question ' +
      'for a human, and quietly making our row match theirs would destroy the ' +
      'only evidence that they ever differed.',
  })
  @ApiOkEnvelope(ReconciliationReportDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
  )
  reconcile(
    @Query() query: ReconciliationQueryDto,
  ): Promise<ReconciliationReportDto> {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from
      ? new Date(query.from)
      : new Date(to.getTime() - 24 * 60 * 60 * 1000);

    if (from > to) {
      throw apiError('`from` must be before `to`', HttpStatus.BAD_REQUEST, [
        { field: 'from', message: 'Range is inverted', code: 'RANGE_INVALID' },
      ]);
    }

    return this.reconciliation.run({ scope: query.scope ?? 'both', from, to });
  }
}
