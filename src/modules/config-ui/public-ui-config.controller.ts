import {
  Controller,
  Get,
  Headers,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiOkEnvelope } from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { ResolveUiConfigQueryDto } from './dto/ui-config.dto';
import { CustomerSegmentationService } from './customer-segmentation.service';
import { OptionalCustomerAuthGuard } from './optional-customer-auth.guard';
import { UiConfigService } from './ui-config.service';

@ApiTags('Server-Driven UI')
@Controller('ui-config')
export class PublicUiConfigController {
  constructor(
    private readonly configs: UiConfigService,
    private readonly segments: CustomerSegmentationService,
  ) {}

  @Get('home')
  @UseGuards(OptionalCustomerAuthGuard)
  @ApiHeader({ name: 'X-App-Version', required: true, example: '1.0.0' })
  @ApiOperation({ summary: 'Resolve the customer home configuration' })
  @ApiOkEnvelope()
  async home(
    @Query() query: ResolveUiConfigQueryDto,
    @Headers('x-app-version') appVersion: string,
    @Req() request: FastifyRequest & { user?: AuthenticatedUser },
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    reply.header('Cache-Control', 'private, no-store');
    const segment = request.user
      ? await this.segments.segmentFor(request.user.id, query.cityId)
      : 'anonymous';
    return this.configs.resolve(query.cityId, segment, appVersion);
  }
}
