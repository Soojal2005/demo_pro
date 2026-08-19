import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PagedQueryDto } from '../../../common/dto/paged-query.dto';

export class AdminOrderQueryDto extends PagedQueryDto {
  @ApiPropertyOptional({
    description:
      'Partial match on the booking number or the Razorpay order id — the two ' +
      'references a payment conversation actually starts from.\n\n' +
      'Matched in the database, because the list is paged: filtering the ' +
      'returned page would search twenty rows and report nothing for the rest.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({
    description: 'Razorpay order status, e.g. `paid`, `attempted`, `created`.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  bookingId?: string;
}
