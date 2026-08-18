import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { normaliseSearchTerm } from '../../../common/dto/search-term.transform';
import { PagedQueryDto } from '../../../common/dto/paged-query.dto';
import { QUEUE_STATUSES, type QueueStatus } from '../pros.types';

export class AdminApplicationQueryDto extends PagedQueryDto {
  @ApiPropertyOptional({
    description:
      'Matches the applicant’s name or phone, and the name printed on their ' +
      'documents.\n\n' +
      'Both names are searched because they routinely differ — somebody signs ' +
      'up as "Ravi" and their Aadhaar reads "Ravi Kumar Chauhan". A reviewer ' +
      'has whichever one the conversation gave them.\n\n' +
      'Employee code is deliberately absent: it is issued on approval, so ' +
      'nobody still in this queue has one.',
  })
  @IsOptional()
  @Transform(({ value }): unknown => normaliseSearchTerm(value))
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    enum: QUEUE_STATUSES,
    description: 'Omit to see the whole queue, longest-waiting first.',
  })
  @IsOptional()
  @IsIn(QUEUE_STATUSES)
  status?: QueueStatus;
}
