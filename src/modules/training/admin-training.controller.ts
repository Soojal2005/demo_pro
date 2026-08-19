import {
  Body,
  Controller,
  Delete,
  Get,
  HttpStatus,
  Param,
  Patch,
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
import {
  AdminTrainingModuleDto,
  ContentUploadUrlDto,
  CreateSessionDto,
  CreateTrainingModuleDto,
  EnrolProsDto,
  MarkAttendanceDto,
  ProTrainingReportDto,
  RequestContentUploadDto,
  SessionQueryDto,
  TrainingModuleQueryDto,
  TrainingSessionDto,
  UpdateSessionDto,
  UpdateTrainingModuleDto,
} from './dto/training.dto';
import { TrainingCatalogService } from './training-catalog.service';
import { TrainingSessionsService } from './training-sessions.service';

/**
 * Training content, offline sessions, and one Pro's standing against both.
 *
 * One permission for all of it — `training.manage`. Module 8 needed four
 * grants because money moved; the worst an over-granted admin can do here is
 * write a bad training module, which is fixed by editing it.
 *
 * Reading a Pro's progress is the exception: it rides on `pro.moderate`, which
 * ops already holds, because it is a read of the same person's record they are
 * already looking at.
 */
@ApiTags('Admin — Training')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/training')
export class AdminTrainingController {
  constructor(
    private readonly catalog: TrainingCatalogService,
    private readonly sessions: TrainingSessionsService,
  ) {}

  // ------------------------------------------------------------------
  // Content
  // ------------------------------------------------------------------

  @Get('modules')
  @RequirePermissions(PermissionCode.TRAINING_MANAGE)
  @ApiOperation({
    summary: 'Browse training modules',
    description:
      'This is the only place `quizAnswerKey` is ever returned. It is absent ' +
      'from every Pro-facing response by construction — the DTO has no field ' +
      'for it and a spec fails if the string reaches one.',
  })
  @ApiOkEnvelope(AdminTrainingModuleDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  listModules(@Query() query: TrainingModuleQueryDto) {
    return this.catalog.list(query);
  }

  @Post('modules')
  @RequirePermissions(PermissionCode.TRAINING_MANAGE)
  @ApiOperation({
    summary: 'Create a training module',
    description:
      'Attach it to the **trade** it belongs to. A module on a parent ' +
      'category reaches every Pro who does any service beneath it, so a ' +
      'safety procedure written once covers the whole trade rather than ' +
      'needing a copy per service.\n\n' +
      'Exactly one of `contentKey` (uploaded here) or `contentUrl` (hosted ' +
      'elsewhere). A `quiz` needs `quizAnswerKey`, without which the score ' +
      'would mean nothing.\n\n' +
      '`isMandatory` only bites where `training.gateActivation` is on, which ' +
      'it is not by default.',
  })
  @ApiCreatedEnvelope(AdminTrainingModuleDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  createModule(
    @Body() dto: CreateTrainingModuleDto,
  ): Promise<AdminTrainingModuleDto> {
    return this.catalog.create(dto);
  }

  @Post('modules/upload-url')
  @RequirePermissions(PermissionCode.TRAINING_MANAGE)
  @ApiOperation({
    summary: 'Presigned URL for module content',
    description:
      'PUT the file, then send the returned `contentKey` when creating or ' +
      'updating the module. Also record `contentBytes` — without a size the ' +
      'app cannot honour "download on wifi only", and a Pro on a data budget ' +
      'will simply not watch it.',
  })
  @ApiCreatedEnvelope(ContentUploadUrlDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
  )
  contentUploadUrl(
    @Body() dto: RequestContentUploadDto,
  ): Promise<ContentUploadUrlDto> {
    return this.catalog.createContentUploadUrl(dto.contentType);
  }

  @Patch('modules/:id')
  @RequirePermissions(PermissionCode.TRAINING_MANAGE)
  @ApiOperation({
    summary: 'Edit a training module',
    description:
      '**Replacing the content bumps `version` automatically.** Not a field ' +
      'you can forget: a swapped video with an unchanged version is invisible ' +
      'to every phone that already cached it, and they keep playing the old ' +
      'procedure. Renaming or reordering does not bump.\n\n' +
      'Deactivating a module removes it from every curriculum immediately and ' +
      'keeps the progress rows — a Pro who completed a retired module has ' +
      'still completed it.',
  })
  @ApiOkEnvelope(AdminTrainingModuleDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  updateModule(
    @Param('id') id: string,
    @Body() dto: UpdateTrainingModuleDto,
  ): Promise<AdminTrainingModuleDto> {
    return this.catalog.update(id, dto);
  }

  // ------------------------------------------------------------------
  // One Pro
  // ------------------------------------------------------------------

  @Get('pros/:proId')
  @RequirePermissions(PermissionCode.PRO_MODERATE)
  @ApiOperation({
    summary: 'One Pro’s training and eligibility',
    description:
      'Per-service eligibility with the missing modules **named**, every ' +
      'module with progress, and their offline sessions.\n\n' +
      'Read `gateEnforced` before acting on `eligible: false`. While ' +
      '`training.gateActivation` is off — which is how it ships — an ' +
      'ineligible Pro can still be activated, and the flag is advice.',
  })
  @ApiOkEnvelope(ProTrainingReportDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  proReport(@Param('proId') proId: string): Promise<ProTrainingReportDto> {
    return this.catalog.proReport(proId);
  }

  @Post('pros/:proId/modules/:moduleId/reset-quiz')
  @RequirePermissions(PermissionCode.TRAINING_MANAGE)
  @ApiOperation({
    summary: 'Give a Pro their quiz attempts back',
    description:
      'The reason the retry cap can exist at all. A limit with no way back is ' +
      'a Pro permanently unable to be activated for a trade, over a quiz they ' +
      'may have failed because the questions were wrong.\n\n' +
      'Attempts reset to zero rather than the lock alone being lifted — one ' +
      'attempt back would put them at the cap again on the next failure. ' +
      '`bestQuizScore` survives; it is a record of what they achieved.',
  })
  @ApiOkEnvelope()
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  async resetQuiz(
    @Param('proId') proId: string,
    @Param('moduleId') moduleId: string,
  ) {
    await this.catalog.resetQuiz(proId, moduleId);
    return successResponse({ message: 'Quiz attempts reset.' });
  }

  // ------------------------------------------------------------------
  // Offline sessions
  // ------------------------------------------------------------------

  @Get('sessions')
  @RequirePermissions(PermissionCode.TRAINING_MANAGE)
  @ApiOperation({ summary: 'Browse offline training sessions' })
  @ApiOkEnvelope(TrainingSessionDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  listSessions(@Query() query: SessionQueryDto) {
    return this.sessions.list(query);
  }

  @Post('sessions')
  @RequirePermissions(PermissionCode.TRAINING_MANAGE)
  @ApiOperation({
    summary: 'Schedule a classroom or field session',
    description: '`capacity` is the room. Enrolment is refused past it.',
  })
  @ApiCreatedEnvelope(TrainingSessionDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  createSession(@Body() dto: CreateSessionDto): Promise<TrainingSessionDto> {
    return this.sessions.create(dto);
  }

  @Get('sessions/:id')
  @RequirePermissions(PermissionCode.TRAINING_MANAGE)
  @ApiOperation({ summary: 'One session and its attendee list' })
  @ApiOkEnvelope(TrainingSessionDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  getSession(@Param('id') id: string): Promise<TrainingSessionDto> {
    return this.sessions.get(id);
  }

  @Patch('sessions/:id')
  @RequirePermissions(PermissionCode.TRAINING_MANAGE)
  @ApiOperation({
    summary: 'Reschedule, cancel or close a session',
    description:
      'Capacity cannot go below the number already enrolled — the alternative ' +
      'is silently over-subscribing the room, or this endpoint picking ' +
      'somebody to remove.',
  })
  @ApiOkEnvelope(TrainingSessionDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  updateSession(
    @Param('id') id: string,
    @Body() dto: UpdateSessionDto,
  ): Promise<TrainingSessionDto> {
    return this.sessions.update(id, dto);
  }

  @Post('sessions/:id/enrolments')
  @RequirePermissions(PermissionCode.TRAINING_MANAGE)
  @ApiOperation({
    summary: 'Enrol Pros',
    description:
      'Already-enrolled ids are skipped, so a half-failed bulk enrolment can ' +
      'simply be sent again.\n\n' +
      'Going over capacity refuses the **whole call** rather than filling the ' +
      'remaining seats in id order — an admin who asked for twelve and ' +
      'silently got three has been given a wrong answer that looks right.',
  })
  @ApiOkEnvelope(TrainingSessionDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  enrol(
    @Param('id') id: string,
    @Body() dto: EnrolProsDto,
  ): Promise<TrainingSessionDto> {
    return this.sessions.enrol(id, dto);
  }

  @Delete('sessions/:id/enrolments/:proId')
  @RequirePermissions(PermissionCode.TRAINING_MANAGE)
  @ApiOperation({
    summary: 'Take a Pro off the list',
    description:
      'Gives the seat back. Without this there was no way to undo an enrolment ' +
      'at all — a Pro added by mistake, or one who called to say they could ' +
      'not come, held a seat permanently, and capacity cannot be lowered past ' +
      'the enrolled count either.\n\n' +
      'Refused once attendance has been marked: that row records whether ' +
      'somebody was in a room, and removing it would erase the record rather ' +
      'than correct the list.',
  })
  @ApiOkEnvelope(TrainingSessionDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  removeEnrolment(
    @Param('id') id: string,
    @Param('proId') proId: string,
  ): Promise<TrainingSessionDto> {
    return this.sessions.removeEnrolment(id, proId);
  }

  @Post('sessions/:id/attendance')
  @RequirePermissions(PermissionCode.TRAINING_MANAGE)
  @ApiOperation({
    summary: 'Mark who turned up',
    description:
      'Enrolled Pros only. Marking a walk-in would create a seat after the ' +
      'fact and put the session over capacity in the record — enrol them ' +
      'first, then mark them.\n\n' +
      'Your admin id and the time are stored against each row: attendance is ' +
      'an assertion by somebody who was in the room.',
  })
  @ApiOkEnvelope(TrainingSessionDto)
  @ApiErrorEnvelope(
    HttpStatus.BAD_REQUEST,
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
    HttpStatus.CONFLICT,
  )
  markAttendance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: MarkAttendanceDto,
  ): Promise<TrainingSessionDto> {
    return this.sessions.markAttendance(id, user.id, dto);
  }
}
