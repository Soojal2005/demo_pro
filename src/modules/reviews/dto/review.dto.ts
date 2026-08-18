import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { BooleanQuery } from '../../../common/dto/boolean-query.transform';
import { RequiredText } from '../../../common/dto/required-text.decorator';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  CUSTOMER_REVIEW_TAGS,
  PRO_REVIEW_TAGS,
  REVIEWER_TYPES,
  type CustomerReviewTag,
  type ProReviewTag,
  type ReviewerType,
} from '../reviews.types';

// ---------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------

export class CreateCustomerReviewDto {
  @ApiProperty({ minimum: 1, maximum: 5, example: 5 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'Free text. Public, and moderatable.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  comment?: string;

  @ApiPropertyOptional({
    isArray: true,
    enum: CUSTOMER_REVIEW_TAGS,
    description:
      'A closed vocabulary, not free strings — so the same sentiment counts ' +
      'the same way across every app version in the field.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(CUSTOMER_REVIEW_TAGS.length)
  @IsIn(CUSTOMER_REVIEW_TAGS, { each: true })
  tags?: CustomerReviewTag[];

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      'Private S3 keys from `POST /bookings/:id/review/photos/upload-url`. ' +
      'A key belonging to another booking is rejected.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(10) // The real cap is `review.maxPhotos`, read at runtime.
  @IsString({ each: true })
  @MaxLength(300, { each: true })
  photoKeys?: string[];
}

export class CreateProReviewDto {
  @ApiProperty({ minimum: 1, maximum: 5, example: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({
    isArray: true,
    enum: PRO_REVIEW_TAGS,
    description:
      'The whole vocabulary available in this direction. **There is no ' +
      '`comment` field**, deliberately — free text about a household, held ' +
      'internally and shown to the next stranger arriving at their door, is ' +
      'the one thing this design refuses. Sending one is a 400, not a ' +
      'silently dropped field.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(PRO_REVIEW_TAGS.length)
  @IsIn(PRO_REVIEW_TAGS, { each: true })
  tags?: ProReviewTag[];
}

export class RequestReviewPhotoUploadDto {
  @ApiProperty({ example: 'image/jpeg' })
  @IsIn(['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
  contentType: string;
}

export class ReviewPhotoUploadUrlDto {
  @ApiProperty({
    description: 'Submit this in `photoKeys` once the PUT succeeds',
  })
  photoKey: string;

  @ApiProperty({ description: 'Presigned S3 PUT URL, short-lived' })
  uploadUrl: string;

  @ApiProperty()
  expiresIn: number;
}

// ---------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------
//
// Paging first: `emitDecoratorMetadata` evaluates a property's type at
// decoration time, so a DTO referenced by an @ApiProperty above its own
// declaration is a temporal-dead-zone crash at import, not a type error.

export class PageMetaDto {
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty() total: number;
  @ApiProperty() totalPages: number;
}

export class PagedQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class ReviewDto {
  @ApiProperty() id: string;
  @ApiProperty() bookingId: string;

  @ApiProperty({
    enum: REVIEWER_TYPES,
    description:
      'WHO WROTE IT. `proId` and `customerId` are the two participants, not ' +
      'the author and the subject.',
  })
  reviewerType: ReviewerType;

  @ApiProperty() rating: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null when the review is hidden, or in the Pro direction.',
  })
  comment: string | null;

  @ApiProperty({ isArray: true, type: String })
  tags: string[];

  @ApiProperty({
    isArray: true,
    type: String,
    description:
      'Short-lived presigned GETs, resolved per request. Empty when hidden.',
  })
  photoUrls: string[];

  @ApiProperty({
    description:
      'True when moderation removed the text and photos. **The rating still ' +
      'counts** — hiding is about content, not the score.',
  })
  contentHidden: boolean;

  @ApiProperty() createdAt: Date;
}

export class PublicReviewDto extends ReviewDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'First name only. A full name on a public page is not needed.',
  })
  customerName: string | null;
}

export class ReviewSummaryDto {
  @ApiProperty({ type: Number, nullable: true, example: 4.6 })
  ratingAverage: number | null;

  @ApiProperty({ example: 37 })
  ratingCount: number;

  @ApiProperty({
    description: 'How many reviews gave each star, 1 through 5.',
    example: { '1': 1, '2': 0, '3': 2, '4': 9, '5': 25 },
  })
  ratingBreakdown: Record<string, number>;

  @ApiProperty({
    description: 'Every tag in the vocabulary, zeroes included.',
    example: { punctual: 21, polite: 18, late: 2 },
  })
  tagCounts: Record<string, number>;
}

export class PublicProReviewsDto {
  @ApiProperty() summary: ReviewSummaryDto;
  @ApiProperty({ type: [PublicReviewDto] }) data: PublicReviewDto[];
  @ApiProperty() meta: PageMetaDto;
}

// ---------------------------------------------------------------------
// The customer advisory
// ---------------------------------------------------------------------

export class AdvisoryNoteDto {
  @ApiProperty() occurredAt: Date;
  @ApiProperty({ isArray: true, enum: PRO_REVIEW_TAGS }) tags: string[];
}

export class CustomerAdvisoryDto {
  @ApiProperty({ type: Number, nullable: true, example: 2.7 })
  ratingAverage: number | null;

  @ApiProperty({ example: 6 })
  ratingCount: number;

  @ApiProperty({
    description: 'Every tag in the Pro vocabulary, zeroes included.',
    example: {
      no_access: 3,
      unsafe: 0,
      pets_loose: 1,
      payment_difficulty: 0,
      pleasant: 2,
    },
  })
  tagCounts: Record<string, number>;

  @ApiProperty({
    type: [AdvisoryNoteDto],
    description:
      'The most recent notes, tags only. **No prior Pro is named** and no ' +
      'free text exists to leak — a Pro walking in learns "three people could ' +
      'not get in", not who said it.',
  })
  recentNotes: AdvisoryNoteDto[];
}

// ---------------------------------------------------------------------
// Moderation and admin reads
// ---------------------------------------------------------------------

export class HideReviewDto {
  @ApiProperty({
    maxLength: 500,
    example: 'Comment names the customer and their street.',
    description:
      'Required. Moderation carries a reason and a name, or it is not moderation.',
  })
  @RequiredText(500, 'reason')
  reason: string;
}

export class AdminReviewDto extends ReviewDto {
  @ApiProperty() proId: string;
  @ApiProperty() customerId: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Admin reads see the text even when it is hidden — that is the point of the queue.',
  })
  hiddenReason: string | null;

  @ApiProperty({ type: String, nullable: true })
  hiddenByAdminId: string | null;

  @ApiProperty({ type: Date, nullable: true })
  hiddenAt: Date | null;
}

export class AdminReviewQueryDto extends PagedQueryDto {
  @ApiPropertyOptional({
    enum: REVIEWER_TYPES,
    description: 'Omit to see both directions.',
  })
  @IsOptional()
  @IsIn(REVIEWER_TYPES)
  reviewerType?: ReviewerType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  proId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 5 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  maxRating?: number;

  @ApiPropertyOptional({
    description: 'The moderation queue is `isHidden=false&maxRating=2`.',
  })
  @IsOptional()
  @BooleanQuery()
  @IsBoolean()
  isHidden?: boolean;
}

export class CustomerFeedbackDto {
  @ApiProperty() customerId: string;

  @ApiProperty({ type: String, nullable: true }) fullName: string | null;

  @ApiProperty({
    description:
      'Already available in module 2, and the reason this screen exists ' +
      'beside it: ops could always act, they just could not see why they ' +
      'should. Nothing in module 10 sets it.',
  })
  isBlocked: boolean;

  @ApiProperty({ type: Number, nullable: true }) ratingAverage: number | null;
  @ApiProperty() ratingCount: number;
  @ApiProperty() completedBookings: number;

  @ApiProperty({ example: { no_access: 3, unsafe: 1 } })
  tagCounts: Record<string, number>;

  @ApiProperty({ type: [AdminReviewDto] })
  recent: AdminReviewDto[];
}
