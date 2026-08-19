import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A service as the customer app renders a card from.
 *
 * `price` is a NUMBER here, unlike `ServiceDto.flatPrice`, which serialises the
 * decimal as a string. That difference is deliberate and narrow: this payload
 * exists to be drawn, the client declares a number, and nothing is settled from
 * it — a booking is priced server-side from the catalogue and frozen onto the
 * row, never from anything the client sends back.
 */
export class CatalogueServiceDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({ type: Number, example: 699 })
  price: number;

  @ApiProperty()
  durationMinutes: number;

  @ApiProperty()
  supportsInstant: boolean;

  @ApiProperty()
  supportsScheduled: boolean;

  @ApiProperty()
  supportsRecurring: boolean;

  @ApiProperty()
  allowsCash: boolean;
}

/**
 * One category, with everything bookable underneath it.
 *
 * Flat rather than nested: the app draws a tile per category and a list per
 * tile, and a two-level tree would have it walking children to answer "what is
 * in here". A shelf appears in its own right AND its services roll up into the
 * trade above it, so opening either shows something.
 */
export class CatalogueCategoryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  sortOrder: number;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "Null on a trade; the trade's slug on a shelf inside it.",
  })
  parentSlug: string | null;

  @ApiProperty({
    description: 'Filed directly here, ignoring shelves beneath it.',
  })
  directCount: number;

  @ApiProperty({
    type: [CatalogueServiceDto],
    description: 'Everything under it, shelves included.',
  })
  services: CatalogueServiceDto[];
}

/**
 * The whole browsable catalogue in one request.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS BESIDE `/catalog/categories`
 * ---------------------------------------------------------------------------
 * The tree endpoint answers "what is the shape of the catalogue"; this answers
 * "what can I draw right now", in one round trip, over a phone connection. The
 * app opens on it before anyone has signed in, and the alternative — a tree
 * fetch plus a services call per category — is N+1 requests on the first
 * screen.
 *
 * Unauthenticated, like the rest of `/catalog`, and carrying no commission:
 * the platform/Pro split never appears on a customer surface (US-3.2).
 */
export class CatalogueDto {
  @ApiProperty({ type: [CatalogueCategoryDto] })
  categories: CatalogueCategoryDto[];

  @ApiProperty({
    description: 'Distinct bookable services, counted once each.',
  })
  total: number;
}
