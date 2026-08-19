import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCreatedEnvelope,
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import type { ChatMessage, RecurringPlan } from '../../prisma/client';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { BookingCancellationService } from './booking-cancellation.service';
import { BookingRescheduleService } from './booking-reschedule.service';
import { BookingChatService } from './booking-chat.service';
import { BookingLifecycleService } from './booking-lifecycle.service';
import { BookingTrackingService } from './booking-tracking.service';
import { BookingsService } from './bookings.service';
import { BookingDto } from './dto/booking.dto';
import {
  CustomerBookingDetailDto,
  CustomerBookingDto,
} from './dto/customer-booking.dto';
import { TrackingDto } from './dto/tracking.dto';
import { CancelBookingDto } from './dto/cancel-booking.dto';
import {
  BookingQuoteDto,
  BookingQuoteRequestDto,
  CancellationPolicyDto,
  RescheduleBookingDto,
  ReschedulePreviewDto,
} from './dto/reschedule-booking.dto';
import { ChatMessageDto, SendMessageDto } from './dto/chat.dto';
import { CreateBookingDto } from './dto/create-booking.dto';
import {
  CreateRecurringPlanDto,
  RecurringPlanDto,
  UpdateRecurringPlanDto,
} from './dto/recurring-plan.dto';
import { RecurringPlansService } from './recurring-plans.service';

@ApiTags('Bookings')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('customer')
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly cancellation: BookingCancellationService,
    private readonly chat: BookingChatService,
    private readonly lifecycle: BookingLifecycleService,
    private readonly plans: RecurringPlansService,
    private readonly tracking_: BookingTrackingService,
    private readonly reschedule_: BookingRescheduleService,
  ) {}

  @Post('quote')
  @ApiOperation({
    summary: 'What would this booking cost me?',
    description:
      'Prices a booking without creating one — the endpoint behind the coin ' +
      'slider, safe to call on every drag.\n\n' +
      'The subscription discount applies first and coins fill what is left, ' +
      'so a subscriber gets the percentage they paid for whether or not they ' +
      'have a balance. `coinsToRedeem` is **clamped, never rejected**: asking ' +
      'to spend more than you hold, or more than `maxRedeemableCoins`, spends ' +
      'what is allowed and tells you so.\n\n' +
      'Runs the same code `POST /bookings` runs, so the number here is the ' +
      'number you will be charged.',
  })
  @ApiOkEnvelope(BookingQuoteDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  quote(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: BookingQuoteRequestDto,
  ): Promise<BookingQuoteDto> {
    return this.bookings.quote(
      user.id,
      dto.serviceId,
      dto.coinsToRedeem ?? 0,
      dto.addressId,
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Book a service',
    description:
      'Instant when `slotStartAt` is omitted, scheduled when it is given. The ' +
      'price is read from the catalogue and frozen — it is never an input. ' +
      '`coinsToRedeem` spends Homingo Coins against it; call ' +
      '`POST /bookings/quote` first to see what will be allowed.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Retrying with the same key returns the original booking instead of ' +
      'creating a second one.',
  })
  @ApiCreatedEnvelope(BookingDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
    HttpStatus.NOT_IMPLEMENTED,
  )
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBookingDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CustomerBookingDetailDto> {
    const booking = await this.bookings.create(user.id, dto, idempotencyKey);
    if (idempotencyKey) {
      await this.bookings.recordIdempotencyKey(
        booking.id,
        user.id,
        idempotencyKey,
      );
    }
    /*
     * Re-read with its relations rather than returning the row just written.
     * The client draws a card from this response — service name, address line,
     * price — and none of those are on the row `create` hands back.
     */
    return this.bookings.viewOf(user.id, booking.id);
  }

  @Post(':id/rebook')
  @ApiOperation({
    summary: 'Repeat a past booking',
    description:
      'Copies the service and address. **Does not** request the same Pro — ' +
      'rotation still applies, and deprioritising a household’s last Pro is ' +
      'the point of it.',
  })
  @ApiCreatedEnvelope(BookingDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async rebook(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<CustomerBookingDetailDto> {
    const booking = await this.bookings.rebook(user.id, id);
    return this.bookings.viewOf(user.id, booking.id);
  }

  @Get()
  @ApiOperation({ summary: 'My booking history' })
  @ApiOkEnvelope(CustomerBookingDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  list(@CurrentUser() user: AuthenticatedUser): Promise<CustomerBookingDto[]> {
    return this.bookings.listViewForCustomer(user.id);
  }

  @Get('live')
  @ApiOperation({ summary: 'My live orders' })
  @ApiOkEnvelope(CustomerBookingDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  listLive(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CustomerBookingDto[]> {
    return this.bookings.listLiveViewForCustomer(user.id);
  }

  @Get('recurring-plans')
  @ApiOperation({ summary: 'My recurring plans' })
  @ApiOkEnvelope(RecurringPlanDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED)
  listPlans(@CurrentUser() user: AuthenticatedUser): Promise<RecurringPlan[]> {
    return this.plans.list(user.id);
  }

  @Post('recurring-plans')
  @ApiOperation({
    summary: 'Set up a recurring plan',
    description:
      'Each occurrence is priced when it is generated, at the catalogue rate ' +
      'of that moment — not the rate when the plan was created.',
  })
  @ApiCreatedEnvelope(RecurringPlanDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  createPlan(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateRecurringPlanDto,
  ): Promise<RecurringPlan> {
    return this.plans.create(user.id, dto);
  }

  @Patch('recurring-plans/:id')
  @ApiOperation({ summary: 'Pause, resume or adjust a recurring plan' })
  @ApiOkEnvelope(RecurringPlanDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.NOT_FOUND,
  )
  updatePlan(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateRecurringPlanDto,
  ): Promise<RecurringPlan> {
    return this.plans.update(user.id, id, dto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one of my bookings' })
  @ApiOkEnvelope(CustomerBookingDetailDto)
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<CustomerBookingDetailDto> {
    return this.bookings.getOwnedBookingDetailView(user.id, id);
  }

  @Post(':id/cancel')
  @ApiOperation({
    summary: 'Cancel a booking',
    description:
      'Available until the job starts. After that only support can act — a ' +
      'partial refund on work already done is a judgement call, not a formula.',
  })
  @ApiOkEnvelope(CustomerBookingDetailDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: CancelBookingDto,
  ): Promise<CustomerBookingDetailDto> {
    await this.cancellation.cancelAsCustomer(user.id, id, dto.reason);
    /* Re-read: the client replaces its copy with this, and the cancellation
       fee and refund it needs to show are written by the call above. */
    return this.bookings.viewOf(user.id, id);
  }

  @Get(':id/cancellation-policy')
  @ApiOperation({
    summary: 'What happens if I cancel this now?',
    description:
      'The confirm screen, computed by the **same function that executes the ' +
      'cancellation** — a preview that can disagree with the action would show ' +
      'the customer one number and charge them another.\n\n' +
      'Two things decide the fee, not one: which status window the booking is ' +
      'in, and how long until the Pro was due. Cancel more than ' +
      '`freeCancellationHours` before the slot — six by default — and it is ' +
      'free whatever the window; `freeUntil` is that instant. Inside it, a ' +
      'percentage of `payableAmount` is retained, unless the customer holds a ' +
      'plan that waives it.\n\n' +
      'Redeemed coins come back regardless of the fee.',
  })
  @ApiOkEnvelope(CancellationPolicyDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async cancellationPolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<CancellationPolicyDto> {
    // Ownership first — someone else's booking must look like none.
    await this.bookings.getOwnedBooking(user.id, id);
    return this.cancellation.describeWindow(id);
  }

  @Get(':id/reschedule')
  @ApiOperation({
    summary: 'Can I move this, and to when?',
    description:
      'Ask before opening a date picker, so a customer is never offered a slot ' +
      'the next call would refuse. `earliestNewSlotAt` is where the picker ' +
      'should start.',
  })
  @ApiOkEnvelope(ReschedulePreviewDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  reschedulePreview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ReschedulePreviewDto> {
    return this.reschedule_.preview(user.id, id);
  }

  @Post(':id/reschedule')
  @ApiOperation({
    summary: 'Move this booking to another slot',
    description:
      'Free inside your allowance — two moves by default, more with a plan. ' +
      'Nothing is refunded and nothing is charged: the price stays frozen, ' +
      'coins stay spent, and the booking keeps its number.\n\n' +
      '**Refused rather than charged inside the cutoff.** Six hours out, the ' +
      "Pro's day is already built around this address, and moving it then is " +
      'the same disruption as cancelling with the platform still on the hook ' +
      'for a new slot. Cancel instead — the fee there is at least honest about ' +
      'what happened.\n\n' +
      'A booking that already had a Pro returns to `assigning` and dispatch ' +
      're-runs against the new time.',
  })
  @ApiOkEnvelope(CustomerBookingDetailDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async reschedule(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RescheduleBookingDto,
  ): Promise<CustomerBookingDetailDto> {
    await this.reschedule_.rescheduleAsCustomer(
      user.id,
      id,
      dto.slotStartAt,
      dto.reason,
    );
    /* Re-read, for the same reason `cancel` does: the client replaces its copy
       with this, and the new slot — plus the status the booking landed in when
       its Pro was released — are written by the call above. */
    return this.bookings.viewOf(user.id, id);
  }

  @Post(':id/start-otp/resend')
  @ApiOperation({
    summary: 'Resend the start code',
    description:
      'A Pro is standing at the door. This is a self-service path on purpose — ' +
      'a failed code must never become a support ticket.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async resendOtp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.bookings.getOwnedBooking(user.id, id);
    await this.lifecycle.resendStartOtp(id);
  }

  @Get(':id/tracking')
  @ApiOperation({
    summary: 'Where is my Pro?',
    description:
      'Position is read from Redis and never stored on the booking. A Pro ' +
      'whose phone has gone quiet is reported as `isStale` rather than shown ' +
      'at a frozen pin — a stuck marker reads as "they’ve parked", not "we ' +
      'lost them".\n\n' +
      '`etaMinutes` is a traffic-aware road estimate, or **null** — which is a ' +
      'real answer meaning "no number worth showing", not a placeholder. ' +
      'Render it as "on the way".',
  })
  @ApiOkEnvelope(TrackingDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  tracking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<TrackingDto> {
    return this.tracking_.getTracking(user.id, id);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Read the chat thread' })
  @ApiOkEnvelope(ChatMessageDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.NOT_FOUND)
  listMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ChatMessage[]> {
    return this.chat.listForCustomer(user.id, id);
  }

  @Post(':id/messages')
  @ApiOperation({
    summary: 'Message the Pro',
    description:
      'Neither side ever sees the other’s number. Writes close a configurable ' +
      'period after completion; reads stay open, since the thread is evidence.',
  })
  @ApiCreatedEnvelope(ChatMessageDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ): Promise<ChatMessage> {
    return this.chat.sendAsCustomer(user.id, id, dto.body);
  }
}
