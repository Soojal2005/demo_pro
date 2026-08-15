import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiOkEnvelope } from '../../common/swagger/api-envelope.decorator';
import { CatalogueDto } from './dto/catalogue.dto';
import { ServiceCatalogService } from './service-catalog.service';

/**
 * The whole catalogue, in one request, for the customer app's first screen.
 *
 * Mounted at the root rather than under `/catalog` because it is not a view of
 * the catalogue resource — it is the app's entire opening payload, and the
 * client has always asked for it here.
 *
 * Unauthenticated, like `/catalog`: this is what someone sees before they have
 * a session, and the guest flow exists so browse-then-sign-in works.
 */
@ApiTags('Catalog')
@Controller('catalogue')
export class CatalogueController {
  constructor(private readonly catalog: ServiceCatalogService) {}

  @Get()
  @ApiOperation({
    summary: 'The whole browsable catalogue',
    description:
      'Every active category with the active services under it, shelves ' +
      'rolled up into their trade. One round trip, because the alternative on ' +
      'a first screen is a tree fetch plus a call per category.',
  })
  @ApiOkEnvelope(CatalogueDto)
  getCatalogue(): Promise<CatalogueDto> {
    return this.catalog.getCatalogue();
  }
}
