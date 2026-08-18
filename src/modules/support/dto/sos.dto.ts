import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SOS_OUTCOMES, SOS_STATUSES, type SosOutcome } from '../support.types';

/**
 * One tap. Everything in here is optional, and that is the design.
 *
 * There is deliberately no `raisedByType` — it comes from the authenticated
 * actor, because a DTO field would let a customer file an alert as a Pro.
 */
export class RaiseSosDto {
  @ApiPropertyOptional({
    description:
      'The job this is about, when there is one. A customer alone at home ' +
      'and uncomfortable may have no live booking at all, so this is ' +
      'optional — but it is ownership-checked when supplied.',
  })
  @IsOptional()
  @IsUUID()
  bookingId?: string;

  @ApiPropertyOptional({
    description:
      'Where the raiser is. **Optional on purpose**: a phone that cannot get ' +
      'a fix must still be able to raise an alert. A missing pin degrades the ' +
      'response; refusing the alert defeats the feature.',
    example: 22.7196,
  })
  @IsOptional()
  @IsLatitude()
  lat?: number;

  @ApiPropertyOptional({ example: 75.8577 })
  @IsOptional()
  @IsLongitude()
  lng?: number;

  @ApiPropertyOptional({
    description: 'Anything the raiser had time to type. Usually nothing.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ResolveSosDto {
  @ApiProperty({
    enum: SOS_OUTCOMES,
    description:
      '`false_alarm` is a real outcome, not a failure to respond — a pocket ' +
      'tap closed honestly is better data than one closed as `resolved`.',
  })
  @IsIn(SOS_OUTCOMES)
  outcome: SosOutcome;

  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  resolutionNotes: string;
}

export class AdminSosQueryDto {
  @ApiPropertyOptional({ enum: SOS_STATUSES })
  @IsOptional()
  @IsIn(SOS_STATUSES)
  status?: string;
}

/** Response shape. Declared for Swagger; the service returns Prisma rows. */
export class SosAlertDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['customer', 'pro'] }) raisedByType: string;
  @ApiProperty({ nullable: true }) customerId: string | null;
  @ApiProperty({ nullable: true }) proId: string | null;
  @ApiProperty({ nullable: true }) bookingId: string | null;
  @ApiProperty({ nullable: true }) lat: number | null;
  @ApiProperty({ nullable: true }) lng: number | null;
  @ApiProperty() raisedAt: Date;
  @ApiProperty({
    description:
      'The booking context frozen at raise time. Never re-derived — by the ' +
      'time ops opens the alert the booking may have moved on, and the state ' +
      'that mattered is the state when someone pressed the button.',
  })
  contextSnapshot: unknown;
  @ApiProperty({ enum: SOS_STATUSES }) status: string;
  @ApiProperty({ nullable: true }) acknowledgedAt: Date | null;
  @ApiProperty({ nullable: true }) resolvedAt: Date | null;
  @ApiProperty({ nullable: true }) resolutionNotes: string | null;
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Seconds from raise to acknowledgement. Null while still open. An ' +
      'acknowledgement target nobody can measure is a target nobody meets.',
  })
  responseSeconds?: number | null;
}
