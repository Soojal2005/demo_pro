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
import type { ChatMessage, JobPhotoProof } from '../../prisma/client';
import { RequireActorType } from '../identity/decorators/require-actor-type.decorator';
import { ActorTypeGuard } from '../identity/guards/actor-type.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { BookingChatService } from './booking-chat.service';
import { BookingLifecycleService } from './booking-lifecycle.service';
import { BookingsService } from './bookings.service';
import { ProJobDto } from './dto/pro-job.dto';
import { ChatMessageDto, SendMessageDto } from './dto/chat.dto';
import {
  AttachPhotoDto,
  PhotoUploadUrlResponseDto,
  RequestPhotoUploadDto,
  TransitionCoordinatesDto,
  VerifyStartOtpDto,
} from './dto/lifecycle.dto';
import { JobPhotoProofDto } from './dto/photo-proof.dto';
import { toProJob, toProJobs, type ProJobView } from './pro-booking.view';

/**
 * The Pro App's side of a job.
 *
 * There is deliberately **no cancel route here, at any depth.** A Pro is a
 * salaried employee who cannot decline work; when they genuinely cannot
 * proceed, ops closes the assignment and dispatch re-runs. Adding one would
 * contradict principle 2 of the cancellation flow.
 */
@ApiTags('Pro — Jobs')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ActorTypeGuard)
@RequireActorType('pro')
@Controller('pros/me/bookings')
export class ProBookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly lifecycle: BookingLifecycleService,
    private readonly chat: BookingChatService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My assigned jobs' })
  @ApiOkEnvelope(ProJobDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  async list(@CurrentUser() user: AuthenticatedUser): Promise<ProJobView[]> {
    return toProJobs(await this.bookings.listForPro(user.id));
  }

  /**
   * Every transition below answers with the job as the app should now draw it,
   * rather than with the bare row the lifecycle service hands back. One extra
   * read, and it means a screen never has to choose between rendering a
   * response that is missing the address and firing a second request to get it.
   */
  private async job(proId: string, bookingId: string): Promise<ProJobView> {
    return toProJob(await this.bookings.getProJob(proId, bookingId));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one assigned job' })
  @ApiOkEnvelope(ProJobDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ProJobView> {
    return this.job(user.id, id);
  }

  @Post(':id/en-route')
  @ApiOperation({
    summary: 'Mark en route',
    description:
      'Repeatable: leaving and returning records every leg, and the log keeps ' +
      'all of them.',
  })
  @ApiOkEnvelope(ProJobDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async enRoute(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionCoordinatesDto,
  ): Promise<ProJobView> {
    await this.lifecycle.markEnRoute(user.id, id, dto);
    return this.job(user.id, id);
  }

  @Post(':id/arrived')
  @ApiOperation({
    summary: 'Mark arrival',
    description:
      'Sends the customer their start code and begins the grace window. ' +
      '`arrivedAt` is stamped on the first arrival only — returning later does ' +
      'not restart the clock. Coordinates are recorded wherever you actually ' +
      'are.',
  })
  @ApiOkEnvelope(ProJobDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async arrived(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionCoordinatesDto,
  ): Promise<ProJobView> {
    await this.lifecycle.markArrived(user.id, id, dto);
    return this.job(user.id, id);
  }

  @Post(':id/verify-otp')
  @ApiOperation({
    summary: 'Enter the customer’s start code',
    description:
      'The only thing that starts the job timer, and therefore the only basis ' +
      'for commission. Verification is the provider’s answer, never this app’s ' +
      'claim. A wrong code counts an attempt and does not pause the grace clock.',
  })
  @ApiOkEnvelope(ProJobDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async verifyOtp(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: VerifyStartOtpDto,
  ): Promise<ProJobView> {
    await this.lifecycle.verifyStartOtp(user.id, id, dto.code, {
      lat: dto.lat,
      lng: dto.lng,
    });
    return this.job(user.id, id);
  }

  @Post(':id/photos/upload-url')
  @ApiOperation({
    summary: 'Get a presigned URL for a job photo',
    description:
      'Keys are namespaced per booking; a key from another job is rejected.',
  })
  @ApiCreatedEnvelope(PhotoUploadUrlResponseDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.INTERNAL_SERVER_ERROR,
  )
  uploadUrl(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RequestPhotoUploadDto,
  ): Promise<PhotoUploadUrlResponseDto> {
    return this.lifecycle.createPhotoUploadUrl(user.id, id, dto);
  }

  @Post(':id/photos')
  @ApiOperation({ summary: 'Attach an uploaded photo to the job' })
  @ApiCreatedEnvelope(JobPhotoProofDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  attachPhoto(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: AttachPhotoDto,
  ): Promise<JobPhotoProof> {
    return this.lifecycle.attachPhoto(user.id, id, dto);
  }

  @Get(':id/photos')
  @ApiOperation({ summary: 'Photos already attached to this job' })
  @ApiOkEnvelope(JobPhotoProofDto, { isArray: true })
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async listPhotos(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<JobPhotoProof[]> {
    await this.bookings.getAssignedBooking(user.id, id);
    return this.lifecycle.listPhotos(id);
  }

  @Post(':id/complete')
  @ApiOperation({
    summary: 'Complete the job',
    description:
      'Refused without a verified start and at least one completion photo. ' +
      'Those photos are the platform’s only structured record of the finished ' +
      'work — and your primary defence in a dispute.',
  })
  @ApiOkEnvelope(ProJobDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  async complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: TransitionCoordinatesDto,
  ): Promise<ProJobView> {
    await this.lifecycle.complete(user.id, id, dto);
    return this.job(user.id, id);
  }

  @Get(':id/messages')
  @ApiOperation({ summary: 'Read the chat thread' })
  @ApiOkEnvelope(ChatMessageDto, { isArray: true })
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  listMessages(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<ChatMessage[]> {
    return this.chat.listForPro(user.id, id);
  }

  @Post(':id/messages')
  @ApiOperation({ summary: 'Message the customer' })
  @ApiCreatedEnvelope(ChatMessageDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  sendMessage(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: SendMessageDto,
  ): Promise<ChatMessage> {
    return this.chat.sendAsPro(user.id, id, dto.body);
  }
}
