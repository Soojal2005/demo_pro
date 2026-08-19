import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BookingDto } from './booking.dto';

/**
 * Swagger shape for what the Pro app receives on every job route.
 *
 * `BookingDto` on its own documents ids where a job card needs text: a client
 * generated from it has an `addressId` and no way to turn it into a street.
 * These three objects are the difference, and they are resolved server-side
 * because there is no Pro-facing route that could resolve them afterwards.
 *
 * See `pro-booking.view.ts` for what is deliberately absent — the customer's
 * phone number above all, which US-4.8 keeps off both sides of a booking.
 */
class ProJobServiceDto {
  @ApiProperty({ example: 'Deep clean — 2BHK' })
  name: string;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description: 'The duration the job was sold against, in minutes.',
  })
  durationMinutes: number | null;
}

class ProJobAddressDto {
  @ApiProperty({ example: 'Flat 402, Sunrise Apartments, Vijay Nagar' })
  addressLine: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'What actually finds the door. Show it next to the street.',
  })
  landmark: string | null;

  @ApiProperty({
    example: 22.7196,
    description: 'Route to this, not to the street text.',
  })
  pinLat: number;

  @ApiProperty({ example: 75.8577 })
  pinLng: number;
}

class ProJobCustomerDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Null for a household that has not given a name. **There is no phone ' +
      'number here and never will be** — the booking chat exists precisely so ' +
      'neither side needs the other’s number (US-4.8).',
  })
  fullName: string | null;

  @ApiProperty({
    description:
      'The household’s rating counters, from Pro→customer reviews only. ' +
      '`ratingCount: 0` is the normal case and means nothing has been ' +
      'reported. The tags behind them are on `GET customer-advisory`.',
  })
  ratingSum: number;

  @ApiProperty()
  ratingCount: number;
}

export class ProJobDto extends BookingDto {
  @ApiProperty({ type: ProJobServiceDto, nullable: true })
  service: ProJobServiceDto | null;

  @ApiProperty({ type: ProJobAddressDto, nullable: true })
  address: ProJobAddressDto | null;

  @ApiProperty({ type: ProJobCustomerDto, nullable: true })
  customer: ProJobCustomerDto | null;
}
