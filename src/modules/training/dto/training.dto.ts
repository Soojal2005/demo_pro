import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { BooleanQuery } from '../../../common/dto/boolean-query.transform';
import {
  PageMetaDto,
  PagedQueryDto,
} from '../../../common/dto/paged-query.dto';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNotEmptyObject,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import {
  CONTENT_TYPES,
  PROGRESS_STATUSES,
  SESSION_STATUSES,
  type ContentType,
  type ProgressStatus,
  type SessionStatus,
} from '../training.types';

// ---------------------------------------------------------------------
// Paging — declared first; @ApiProperty resolves a property's type at
// decoration time, so a forward reference is a crash at import.
// ---------------------------------------------------------------------

// Paging lives in `common/dto` now that four modules share it. Re-exported so
// this module's existing imports keep working.
export { PageMetaDto, PagedQueryDto };

// ---------------------------------------------------------------------
// Admin · content
// ---------------------------------------------------------------------

export class CreateTrainingModuleDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'The trade this belongs to. A module on a **parent** category reaches ' +
      'every Pro who does any service beneath it.',
  })
  @IsUUID()
  categoryId: string;

  @ApiProperty({ maxLength: 200, example: 'Isolating a circuit safely' })
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ enum: CONTENT_TYPES })
  @IsIn(CONTENT_TYPES)
  contentType: ContentType;

  @ApiPropertyOptional({
    description:
      'Private S3 key from `POST /admin/training/modules/upload-url`. Exactly ' +
      'one of `contentKey` / `contentUrl`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  contentKey?: string;

  @ApiPropertyOptional({ description: 'For content hosted elsewhere.' })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(1000)
  contentUrl?: string;

  @ApiPropertyOptional({
    description:
      'Object size. Without it the app cannot honour "download on wifi only", ' +
      'so a video with no size is a video Pros on a data budget will not watch.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  contentBytes?: number;

  @ApiPropertyOptional({
    description:
      'Required when `contentType` is `quiz`, and **never returned to a Pro**. ' +
      'Shape: `{ "q1": "b", "q2": ["a","c"] }`. Multi-select matching ignores ' +
      'order, duplicates and case.',
    example: { q1: 'b', q2: ['a', 'c'] },
  })
  @IsOptional()
  @IsObject()
  @IsNotEmptyObject()
  quizAnswerKey?: Record<string, string | string[]>;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    description: 'Overrides `training.quizPassPercent` for this module.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  quizPassPercent?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Blocks activating a Pro for services in this trade — but only where ' +
      '`training.gateActivation` is on, which it is not by default.',
  })
  @IsOptional()
  @IsBoolean()
  isMandatory?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  durationMinutes?: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  sortOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Every field optional — send only what changes.
 *
 * `PartialType`, the same idiom `UpdateAddressDto` and `UpdateRoleDto` use,
 * rather than re-declaring the three required fields with `@IsOptional`. That
 * version needed `declare` to satisfy TypeScript, and a `declare` field emits
 * no property at all, which makes whether its decorators still apply a
 * question about compiler internals rather than something readable from the
 * code.
 *
 * `TrainingCatalogService.update` distinguishes an omitted field from an
 * explicit `null`: omitted keeps the stored value, null clears it. That is what
 * lets a module move from a hosted URL to an uploaded file.
 */
export class UpdateTrainingModuleDto extends PartialType(
  CreateTrainingModuleDto,
) {}

export class RequestContentUploadDto {
  @ApiProperty({ example: 'video/mp4' })
  @IsIn([
    'video/mp4',
    'video/quicktime',
    'application/pdf',
    'image/jpeg',
    'image/png',
    'application/json',
  ])
  contentType: string;
}

export class ContentUploadUrlDto {
  @ApiProperty({ description: 'Submit this as `contentKey`' })
  contentKey: string;

  @ApiProperty() uploadUrl: string;
  @ApiProperty() expiresIn: number;
}

export class TrainingModuleQueryDto extends PagedQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ enum: CONTENT_TYPES })
  @IsOptional()
  @IsIn(CONTENT_TYPES)
  contentType?: ContentType;

  @ApiPropertyOptional()
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  isMandatory?: boolean;
}

/** The admin view — the only shape that ever carries the answer key. */
export class AdminTrainingModuleDto {
  @ApiProperty() id: string;
  @ApiProperty() categoryId: string;
  @ApiProperty() title: string;
  @ApiProperty({ type: String, nullable: true }) description: string | null;
  @ApiProperty({ enum: CONTENT_TYPES }) contentType: ContentType;
  @ApiProperty({ type: String, nullable: true }) contentKey: string | null;
  @ApiProperty({ type: String, nullable: true }) contentUrl: string | null;
  @ApiProperty({ type: Number, nullable: true }) contentBytes: number | null;

  @ApiProperty({
    description:
      'Bumped whenever the content is replaced. The app compares it against ' +
      'what it downloaded; without it, swapping a video leaves every Pro ' +
      'watching last month’s procedure with nothing to tell them.',
  })
  version: number;

  @ApiProperty({
    nullable: true,
    description: '**Admin-only.** Absent from every Pro-facing response.',
  })
  quizAnswerKey: unknown;

  @ApiProperty({ type: Number, nullable: true }) quizPassPercent: number | null;
  @ApiProperty() isMandatory: boolean;
  @ApiProperty({ type: Number, nullable: true }) durationMinutes: number | null;
  @ApiProperty() sortOrder: number;
  @ApiProperty() isActive: boolean;
}

// ---------------------------------------------------------------------
// Pro · curriculum
// ---------------------------------------------------------------------

export class CurriculumItemDto {
  @ApiProperty() moduleId: string;
  @ApiProperty() title: string;
  @ApiProperty({ type: String, nullable: true }) description: string | null;
  @ApiProperty({ enum: CONTENT_TYPES }) contentType: ContentType;
  @ApiProperty() categoryId: string;
  @ApiProperty() categoryName: string;
  @ApiProperty() isMandatory: boolean;
  @ApiProperty() version: number;
  @ApiProperty({ type: Number, nullable: true }) durationMinutes: number | null;

  @ApiProperty({ enum: PROGRESS_STATUSES }) status: ProgressStatus;
  @ApiProperty() percentComplete: number;

  @ApiProperty({
    description: 'Seconds. Resume here rather than restarting from zero.',
  })
  lastPositionSeconds: number;

  @ApiProperty({ type: Number, nullable: true }) bestQuizScore: number | null;
  @ApiProperty() quizAttempts: number;
  @ApiProperty({ type: Number, nullable: true }) attemptsLeft: number | null;
  @ApiProperty() isLocked: boolean;
  @ApiProperty({ type: Date, nullable: true }) completedAt: Date | null;
}

export class CurriculumDto {
  @ApiProperty({
    description:
      'Mandatory modules still outstanding. While `training.gateActivation` ' +
      'is off this is informational; with it on, these are what stand between ' +
      'the Pro and being activated for the trade.',
  })
  mandatoryOutstanding: number;

  @ApiProperty() total: number;
  @ApiProperty() completed: number;
  @ApiProperty({ type: [CurriculumItemDto] }) modules: CurriculumItemDto[];
}

export class CurriculumQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Narrow to one service’s trade — the in-job reference case: what should ' +
      'I be able to read while standing in front of this job.',
  })
  @IsOptional()
  @IsUUID()
  serviceId?: string;
}

/** One module, opened. Carries the content URL and, for a quiz, its questions. */
export class TrainingModuleDetailDto extends CurriculumItemDto {
  @ApiProperty({
    description:
      'Presigned GET valid for six hours, or the external URL as stored. Long ' +
      'because a 48 MB video on mobile data does not download in five minutes.',
  })
  contentUrl: string;

  @ApiProperty({ type: Number, nullable: true }) contentBytes: number | null;

  @ApiProperty({
    isArray: true,
    type: String,
    description:
      'Question ids for a quiz, in key order. **The answers are not here and ' +
      'never will be** — grading happens on the server, because a score the ' +
      'phone computed is not a score anyone can stand behind.',
  })
  quizQuestionIds: string[];
}

export class UpdateProgressDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  percentComplete?: number;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Where playback got to. Sent periodically, not just on exit.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  lastPositionSeconds?: number;
}

export class SubmitQuizDto {
  @ApiProperty({
    description:
      'Chosen options, keyed by question id. A question the key defines and ' +
      'this omits counts as wrong — a client cannot shrink the denominator by ' +
      'leaving out what it does not know.',
    example: { q1: 'b', q2: ['a', 'c'] },
  })
  @IsObject()
  answers: Record<string, string | string[]>;
}

export class QuizResultDto {
  @ApiProperty({ example: 80 }) score: number;
  @ApiProperty() passed: boolean;
  @ApiProperty() correct: number;
  @ApiProperty() total: number;
  @ApiProperty({ isArray: true, type: String }) incorrectQuestionIds: string[];
  @ApiProperty({ type: Number, nullable: true }) bestQuizScore: number | null;
  @ApiProperty() attemptsUsed: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      '`0` means locked — an admin has to clear it before another try.',
  })
  attemptsLeft: number | null;

  @ApiProperty() isLocked: boolean;
}

// ---------------------------------------------------------------------
// Offline manifest
// ---------------------------------------------------------------------

export class ManifestItemDto {
  @ApiProperty() moduleId: string;
  @ApiProperty() title: string;
  @ApiProperty({ enum: CONTENT_TYPES }) contentType: ContentType;

  @ApiProperty({
    description:
      'Compare against what you cached. A change means re-download; nothing ' +
      'else in this response can tell you the file moved on.',
  })
  version: number;

  @ApiProperty({ type: Number, nullable: true }) bytes: number | null;

  @ApiProperty({
    description:
      'Over 10 MB. Advice for the app, not a rule the server enforces.',
  })
  wifiRecommended: boolean;

  @ApiProperty() url: string;
  @ApiProperty() urlExpiresAt: Date;
}

export class TrainingManifestDto {
  @ApiProperty() generatedAt: Date;
  @ApiProperty() totalBytes: number;
  @ApiProperty({ type: [ManifestItemDto] }) modules: ManifestItemDto[];
}

// ---------------------------------------------------------------------
// Offline sessions
// ---------------------------------------------------------------------

export class CreateSessionDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId: string;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiProperty({ maxLength: 500, example: 'Homingo office, Vijay Nagar' })
  @IsString()
  @MaxLength(500)
  venue: string;

  @ApiProperty({ example: '2026-09-02T05:30:00.000Z' })
  @IsISO8601()
  scheduledAt: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  durationMinutes?: number;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  trainerName?: string;

  @ApiProperty({ minimum: 1, example: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  capacity: number;
}

export class UpdateSessionDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  venue?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  durationMinutes?: number;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  trainerName?: string;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'Cannot be dropped below the number already enrolled.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  capacity?: number;

  @ApiPropertyOptional({ enum: SESSION_STATUSES })
  @IsOptional()
  @IsIn(SESSION_STATUSES)
  status?: SessionStatus;
}

export class EnrolProsDto {
  @ApiProperty({
    isArray: true,
    type: String,
    format: 'uuid',
    description:
      'Enrolling a Pro who is already on the list is a no-op, not an error — ' +
      'so a half-failed bulk enrolment can simply be sent again.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID(undefined, { each: true })
  proIds: string[];
}

export class MarkAttendanceEntryDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  proId: string;

  @ApiProperty()
  @IsBoolean()
  attended: boolean;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  completionNotes?: string;
}

export class MarkAttendanceDto {
  @ApiProperty({ type: [MarkAttendanceEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  // `@ValidateNested`, not `@IsObject` — the latter checks the element is an
  // object and stops there, so every field inside it goes unvalidated and
  // `forbidNonWhitelisted` never sees the extras either. A `proId` of "yes"
  // would have reached Prisma.
  @ValidateNested({ each: true })
  @Type(() => MarkAttendanceEntryDto)
  entries: MarkAttendanceEntryDto[];
}

export class SessionQueryDto extends PagedQueryDto {
  @ApiPropertyOptional({ enum: SESSION_STATUSES })
  @IsOptional()
  @IsIn(SESSION_STATUSES)
  status?: SessionStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({
    description:
      'Sessions scheduled at or after this instant. Either bound may be sent ' +
      'on its own — "everything from Monday" and "everything before the ' +
      'quarter closed" are both whole questions.',
    example: '2026-09-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601()
  scheduledFrom?: string;

  @ApiPropertyOptional({ example: '2026-09-30T23:59:59.999Z' })
  @IsOptional()
  @IsISO8601()
  scheduledTo?: string;
}

export class SessionAttendeeDto {
  @ApiProperty() proId: string;
  @ApiProperty({ type: String, nullable: true }) fullName: string | null;
  @ApiProperty() enrolledAt: Date;
  @ApiProperty() attended: boolean;
  @ApiProperty({ type: Date, nullable: true }) markedAt: Date | null;
  @ApiProperty({ type: String, nullable: true }) markedByAdminId: string | null;
  @ApiProperty({ type: String, nullable: true }) completionNotes: string | null;
}

export class TrainingSessionDto {
  @ApiProperty() id: string;
  @ApiProperty() categoryId: string;
  @ApiProperty() title: string;
  @ApiProperty() venue: string;
  @ApiProperty() scheduledAt: Date;
  @ApiProperty({ type: Number, nullable: true }) durationMinutes: number | null;
  @ApiProperty({ type: String, nullable: true }) trainerName: string | null;
  @ApiProperty() capacity: number;
  @ApiProperty() enrolled: number;
  @ApiProperty() seatsLeft: number;
  @ApiProperty({ enum: SESSION_STATUSES }) status: SessionStatus;
  @ApiPropertyOptional({ type: [SessionAttendeeDto] })
  attendees?: SessionAttendeeDto[];
}

export class ProSessionDto {
  @ApiProperty() sessionId: string;
  @ApiProperty() title: string;
  @ApiProperty() venue: string;
  @ApiProperty() scheduledAt: Date;
  @ApiProperty({ type: String, nullable: true }) trainerName: string | null;
  @ApiProperty({ enum: SESSION_STATUSES }) status: SessionStatus;
  @ApiProperty() attended: boolean;
}

// ---------------------------------------------------------------------
// Admin · one Pro
// ---------------------------------------------------------------------

export class ServiceEligibilityDto {
  @ApiProperty() serviceId: string;
  @ApiProperty() serviceName: string;
  @ApiProperty() isActive: boolean;
  @ApiProperty() eligible: boolean;

  @ApiProperty({
    isArray: true,
    type: String,
    description:
      'Mandatory module titles still outstanding. Named rather than counted, ' +
      'because "not eligible" with no list is a support ticket.',
  })
  missingModules: string[];
}

export class ProTrainingReportDto {
  @ApiProperty() proId: string;
  @ApiProperty({ type: String, nullable: true }) fullName: string | null;

  @ApiProperty({
    description:
      'Whether the mandatory-module gate is actually enforced right now. ' +
      'False means `eligible: false` blocks nothing.',
  })
  gateEnforced: boolean;

  @ApiProperty({ type: [ServiceEligibilityDto] })
  services: ServiceEligibilityDto[];

  @ApiProperty({ type: [CurriculumItemDto] })
  modules: CurriculumItemDto[];

  @ApiProperty({ type: [ProSessionDto] })
  sessions: ProSessionDto[];
}
