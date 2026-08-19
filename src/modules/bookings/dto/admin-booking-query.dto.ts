import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { normaliseSearchTerm } from '../../../common/dto/search-term.transform';
import { BOOKING_STATUSES, type BookingStatus } from '../booking.types';

export class AdminBookingQueryDto {
  @ApiPropertyOptional({
    description:
      'Partial, case-insensitive booking number — the reference a customer ' +
      'or Pro reads out on a call.\n\n' +
      'Matched in the database rather than over the returned page, which is ' +
      'capped: a console filtering the page instead reports "not found" for ' +
      'every booking past the cap, which is indistinguishable from a booking ' +
      'that does not exist.\n\n' +
      'Names are deliberately absent — a booking row holds `customerId`, not ' +
      'a name, so searching by one would mean a join that returns different ' +
      'results as customers rename themselves. Use the customer list for that.',
  })
  @IsOptional()
  @Transform(({ value }): unknown => normaliseSearchTerm(value))
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    enum: BOOKING_STATUSES,
    description: 'Omit to see every status, most recent first.',
  })
  @IsOptional()
  @IsIn(BOOKING_STATUSES)
  status?: BookingStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  proId?: string;
}
