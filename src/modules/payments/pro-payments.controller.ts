import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
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
import { PrismaService } from '../../prisma/prisma.service';
import { BookingDto } from '../bookings/dto/booking.dto';
import { toProBooking } from '../bookings/pro-booking.view';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { CashCollectionService } from './cash-collection.service';
import { CashEligibilityService } from './cash-eligibility.service';
import { CashHandoverService } from './cash-handover.service';
import {
  CashBalanceDto,
  CashHandoverDto,
  DeclareHandoverDto,
  DeclineCashDto,
} from './dto/cash.dto';

/**
 * The Pro's side of cash: take it at the door, carry it, hand it back.
 *
 * Notice what has no route here — editing a collected amount. Cash is
 * `flatPrice` or nothing, and there is nowhere in this API to say otherwise.
 */
@ApiTags('Pro — Payments')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('pro')
@Controller('pros/me')
export class ProPaymentsController {
  constructor(
    private readonly collection: CashCollectionService,
    private readonly handovers: CashHandoverService,
    private readonly eligibility: CashEligibilityService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('bookings/:id/cash-collection')
  @ApiOperation({
    summary: 'Record cash collected at the door',
    description:
      'Takes no amount. It is the booking’s flat price or nothing — a part ' +
      'payment cannot be recorded, here or anywhere. Idempotent: recording ' +
      'twice is not an error and does not collect twice.',
  })
  @ApiCreatedEnvelope(BookingDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async collect(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') bookingId: string,
  ): Promise<BookingDto> {
    const booking = await this.collection.collect(user.id, bookingId);
    return toProBooking(booking) as unknown as BookingDto;
  }

  @Post('bookings/:id/cash-collection/decline')
  @ApiOperation({
    summary: 'Report that the customer would not pay',
    description:
      'The job still completes and you are still paid your commission. This ' +
      'raises a billing ticket for ops to chase; it is not held against you.',
  })
  @ApiCreatedEnvelope(BookingDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async decline(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') bookingId: string,
    @Body() dto: DeclineCashDto,
  ): Promise<BookingDto> {
    const booking = await this.collection.decline(
      user.id,
      bookingId,
      dto.reason,
    );
    return toProBooking(booking) as unknown as BookingDto;
  }

  @Get('cash-balance')
  @ApiOperation({
    summary: 'What you are carrying',
    description:
      'Past the ceiling, cash jobs stop being assigned to you until you hand ' +
      'over. Your online work and your commission are unaffected — commission ' +
      'is never netted against this balance.',
  })
  @ApiOkEnvelope(CashBalanceDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async balance(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CashBalanceDto> {
    const pro = await this.prisma.pro.findUnique({
      where: { id: user.id },
      select: { cashInHand: true, cityId: true },
    });

    const ceiling = await this.eligibility.ceiling(pro?.cityId);
    const blocked = await this.eligibility.isProBlocked(user.id, pro?.cityId);
    const open = await this.prisma.cashHandover.findFirst({
      where: { proId: user.id, status: 'declared' },
      select: { id: true },
    });

    return {
      cashInHand: pro?.cashInHand.toString() ?? '0.00',
      ceiling: ceiling.toFixed(2),
      isBlockedFromCashJobs: blocked,
      openHandoverId: open?.id ?? null,
    };
  }

  @Post('cash-handovers')
  @ApiOperation({
    summary: 'Declare a handover',
    description:
      'Declaring alone clears nothing. An admin has to count it first — that ' +
      'two-person step is the only control on this flow. One open declaration ' +
      'at a time.',
  })
  @ApiCreatedEnvelope(CashHandoverDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  declare(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: DeclareHandoverDto,
  ): Promise<CashHandoverDto> {
    return this.handovers.declare(
      user.id,
      dto.declaredAmount,
    ) as unknown as Promise<CashHandoverDto>;
  }

  @Get('cash-handovers')
  @ApiOperation({ summary: 'Your handover history' })
  @ApiOkEnvelope(CashHandoverDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  listHandovers(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CashHandoverDto[]> {
    return this.handovers.listForPro(user.id) as unknown as Promise<
      CashHandoverDto[]
    >;
  }
}
