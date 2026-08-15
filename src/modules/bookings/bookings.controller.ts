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
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Book a service',
    description:
      'Instant when `slotStartAt` is omitted, scheduled when it is given. The ' +
      'price is read from the catalogue and frozen — it is never an input.',
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
