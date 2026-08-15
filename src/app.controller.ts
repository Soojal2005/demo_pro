import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppConfigDto } from './app-config.dto';
import { ApiOkEnvelope } from './common/swagger/api-envelope.decorator';
import { AppService } from './app.service';

@ApiTags('App')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({ summary: 'Liveness placeholder' })
  @ApiOkEnvelope()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Public on purpose — the app reads it at launch, before anyone signs in,
   * and it exposes capabilities rather than configuration.
   */
  @Get('config')
  @ApiOperation({ summary: 'What this deployment supports' })
  @ApiOkEnvelope(AppConfigDto)
  config(): AppConfigDto {
    return this.appService.config();
  }
}
