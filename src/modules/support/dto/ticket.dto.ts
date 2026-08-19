import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  SELF_SERVICE_CATEGORIES,
  TICKET_ACTIONS,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type SelfServiceCategory,
  type TicketAction,
  type TicketCategory,
  type TicketPriority,
} from '../support.types';

/**
 * What a customer or a Pro may raise for themselves.
 *
 * Two omissions carry rules:
 *
 * - **`category` excludes `no_start`.** It is a system-detected exception by
 *   definition; a raiser able to file one would produce a ticket that looks
 *   system-raised and is not.
 * - **There is no `priority`.** Every self-service ticket would be urgent,
 *   which is the same as none of them being urgent. Ops sets it.
 */
export class CreateTicketDto {
  @ApiProperty({
    enum: SELF_SERVICE_CATEGORIES,
    description:
      '`no_start` is deliberately absent — it is raised by the system alone.',
  })
  @IsIn(SELF_SERVICE_CATEGORIES)
  category: SelfServiceCategory;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  subject: string;

  @ApiProperty({
    maxLength: 4000,
    description: 'Becomes the first message on the thread.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(4000)
  body: string;

  @ApiPropertyOptional({
    description:
      'Required for `dispute` — a dispute with no job to dispute has no ' +
      'evidence to assemble. Ownership-checked when supplied.',
  })
  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @ApiPropertyOptional({
    description: 'S3 object key from the storage upload flow.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  attachmentKey?: string;
}

/** Ops raising on behalf of either party, or opening an internal case. */
export class AdminCreateTicketDto {
  @ApiProperty({ enum: TICKET_CATEGORIES })
  @IsIn(TICKET_CATEGORIES)
  category: TicketCategory;

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  subject: string;

  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @MinLength(3)
  @MaxLength(4000)
  body: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @ApiPropertyOptional({ enum: TICKET_PRIORITIES, default: 'normal' })
  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: TicketPriority;

  @ApiPropertyOptional({
    default: false,
    description:
      'Ops-only. An internal ticket is invisible to the customer and the Pro ' +
      'on every route, at any depth.',
  })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;
}

export class AddTicketMessageDto {
  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  body: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  attachmentKey?: string;

  @ApiPropertyOptional({
    default: false,
    description:
      '**Admin only.** A customer or Pro sending `true` is rejected with 400 ' +
      'rather than having it silently downgraded — a note the sender believes ' +
      'is private and is not would be worse than an error.',
  })
  @IsOptional()
  @IsBoolean()
  isInternalNote?: boolean;
}

export class AssignTicketDto {
  @ApiProperty({
    description:
      'Must hold `support.ticket.manage`. An assignee who cannot act on the ' +
      'ticket is a ticket parked forever.',
  })
  @IsUUID()
  adminUserId: string;
}

export class EscalateTicketDto {
  @ApiProperty({
    maxLength: 1000,
    description: 'Written into the thread as a system message.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;

  @ApiPropertyOptional({ enum: TICKET_PRIORITIES })
  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: TicketPriority;

  @ApiPropertyOptional({ description: 'Reassign as part of the escalation.' })
  @IsOptional()
  @IsUUID()
  assignToAdminUserId?: string;
}

export class ResolveTicketDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  resolutionNotes: string;

  @ApiProperty({
    enum: TICKET_ACTIONS,
    description:
      'A **record of a decision, not an instruction**. Suspending a Pro is ' +
      "module 6's endpoint, called separately — two writers of `Pro.status` " +
      'is a bug pattern this codebase has already paid for once.',
  })
  @IsIn(TICKET_ACTIONS)
  actionTaken: TicketAction;
}

export class AdminTicketQueryDto {
  @ApiPropertyOptional({ enum: TICKET_STATUSES })
  @IsOptional()
  @IsIn(TICKET_STATUSES)
  status?: string;

  @ApiPropertyOptional({ enum: TICKET_CATEGORIES })
  @IsOptional()
  @IsIn(TICKET_CATEGORIES)
  category?: string;

  @ApiPropertyOptional({ enum: TICKET_PRIORITIES })
  @IsOptional()
  @IsIn(TICKET_PRIORITIES)
  priority?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assignedAdminId?: string;
}

// ---------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------

export class TicketMessageDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['customer', 'pro', 'admin', 'system'] })
  senderType: string;
  @ApiProperty() senderId: string;
  @ApiProperty() body: string;
  @ApiProperty({ nullable: true }) attachmentUrl: string | null;
  @ApiProperty({
    description:
      'Always `false` on a raiser-facing response — internal notes are never ' +
      'loaded on that path, so the field cannot be true there.',
  })
  isInternalNote: boolean;
  @ApiProperty() sentAt: Date;
}

export class SupportTicketDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['customer', 'pro', 'system'] }) raisedByType: string;
  @ApiProperty({ nullable: true }) customerId: string | null;
  @ApiProperty({ nullable: true }) proId: string | null;
  @ApiProperty({ nullable: true }) bookingId: string | null;
  @ApiProperty({ enum: TICKET_CATEGORIES }) category: string;
  @ApiProperty() subject: string;
  @ApiProperty({ enum: TICKET_PRIORITIES }) priority: string;
  @ApiProperty({ enum: TICKET_STATUSES }) status: string;
  @ApiProperty() isInternal: boolean;
  @ApiProperty({ nullable: true }) assignedAdminId: string | null;
  @ApiProperty({ nullable: true }) resolutionNotes: string | null;
  @ApiProperty({ nullable: true, enum: TICKET_ACTIONS })
  actionTaken: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ nullable: true }) resolvedAt: Date | null;
  @ApiPropertyOptional({ type: [TicketMessageDto] })
  messages?: TicketMessageDto[];
}
