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
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import {
  CancelSubscriptionDto,
  CustomerSubscriptionDto,
  PurchaseSubscriptionDto,
  SubscriptionCheckoutDto,
  SubscriptionPlanDto,
} from './dto/subscription-plan.dto';
import { OrdersService } from '../payments/orders.service';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Buying and holding a Homingo plan.
 *
 * Purchase is **two calls**, not one: `POST /subscriptions` creates a
 * `pending_payment` row that entitles the customer to nothing, and activation
 * happens when the money actually arrives. An entitlement created in the same
 * call that takes payment would be live before the payment cleared, and a
 * failed checkout would leave a customer discounted for free.
 */
@ApiTags('Loyalty · Subscriptions')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('customer')
@Controller('customers/me/subscriptions')
export class SubscriptionsController {
  constructor(
    private readonly subscriptions: SubscriptionsService,
    private readonly orders: OrdersService,
  ) {}

  @Get('plans')
  @ApiOperation({
    summary: 'Plans I can buy',
    description:
      'City-scoped plans are only listed for their city; pass `cityId` from ' +
      'the address you book against most.',
  })
  @ApiQuery({ name: 'cityId', required: false, format: 'uuid' })
  @ApiOkEnvelope(SubscriptionPlanDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  plans(@Query('cityId') cityId?: string): Promise<unknown[]> {
    return this.subscriptions.listPurchasablePlans(cityId ?? null);
  }

  @Get('active')
  @ApiOperation({
    summary: 'My current plan and what it gets me',
    description:
      'Returns the perks in the shape the booking and cancellation screens ' +
      'need. A plan whose window has closed is reported as none, whatever the ' +
      'stored status says.',
  })
  @ApiOkEnvelope(CustomerSubscriptionDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  active(@CurrentUser() user: AuthenticatedUser): Promise<unknown> {
    return this.subscriptions.perksFor(user.id);
  }

  @Get()
  @ApiOperation({ summary: 'My subscription history' })
  @ApiOkEnvelope(CustomerSubscriptionDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  history(@CurrentUser() user: AuthenticatedUser): Promise<unknown[]> {
    return this.subscriptions.listForCustomer(user.id);
  }

  @Post()
  @ApiOperation({
    summary: 'Start buying a plan',
    description:
      'Creates a `pending_payment` subscription. It gives you nothing until ' +
      'it is activated by the payment confirmation. Refused if you already ' +
      'have a live plan.',
  })
  @ApiCreatedEnvelope(CustomerSubscriptionDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  purchase(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PurchaseSubscriptionDto,
  ): Promise<unknown> {
    // A customer asking for a free plan is refused here rather than in the
    // service, because the service is also ops' door and ops may grant one.
    if (dto.paymentMode === 'complimentary') {
      throw apiError(
        'Complimentary plans are granted by Homingo, not requested',
        HttpStatus.FORBIDDEN,
        [
          {
            field: 'paymentMode',
            message: 'Only ops may create a complimentary subscription',
            code: 'COMPLIMENTARY_NOT_SELF_SERVICE',
          },
        ],
      );
    }

    return this.subscriptions.purchase(
      user.id,
      dto.planId,
      dto.paymentMode ?? 'online',
    );
  }

  @Post(':id/checkout')
  @ApiOperation({
    summary: 'Open Razorpay checkout for a plan',
    description:
      'Second half of the purchase. Creates the gateway order **server-side** ' +
      'and hands back what the Razorpay SDK needs — the amount is read from ' +
      'the subscription, never from the client, for the same reason a booking ' +
      'order is (US-7.1).\n\n' +
      'The plan goes live when the payment is captured, through the same ' +
      'activation the admin route uses — so a redelivered webhook, or the ' +
      'verify call racing it, activates once and grants the welcome coins ' +
      'once.\n\n' +
      'Safe to call again: an unpaid order that is still valid is handed back ' +
      'rather than reissued, and an already-paid plan is refused.',
  })
  @ApiCreatedEnvelope(SubscriptionCheckoutDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.SERVICE_UNAVAILABLE,
  )
  checkout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<unknown> {
    // Ownership, status and the one-live-plan rule are all checked inside,
    // before any gateway order exists — nothing can refuse after a card has
    // been charged.
    return this.orders.createForSubscription(id, user.id);
  }

  @Post(':id/cancel')
  @ApiOperation({
    summary: 'Stop my plan',
    description:
      'Ends the entitlement. **No refund is computed here** — what a ' +
      'part-used plan is worth back is an ops judgement, and it goes through ' +
      'support with a human on it.',
  })
  @ApiOkEnvelope(CustomerSubscriptionDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelSubscriptionDto,
  ): Promise<unknown> {
    // Ownership first — someone else's subscription must be indistinguishable
    // from one that does not exist.
    await this.subscriptions.getOwnedOrFail(user.id, id);
    return this.subscriptions.cancel(id, dto.reason);
  }
}
