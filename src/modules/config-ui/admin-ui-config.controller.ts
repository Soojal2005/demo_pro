import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiCreatedEnvelope,
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { apiError } from '../../common/utils';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import {
  CreateUiConfigDto,
  PublishUiConfigDto,
  UiConfigQueryDto,
  UpdateUiConfigDto,
} from './dto/ui-config.dto';
import { UiConfigService } from './ui-config.service';

@ApiTags('Admin — Server-Driven UI')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/ui-configs')
export class AdminUiConfigController {
  constructor(private readonly configs: UiConfigService) {}

  @Get()
  @RequirePermissions(PermissionCode.UI_CONFIG_READ)
  @ApiOkEnvelope()
  list(
    @Query() query: UiConfigQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const scope = actor.cityScope ?? [];
    if (scope.length && !query.cityId)
      throw apiError(
        'A city-scoped admin must filter UI configs by cityId',
        HttpStatus.FORBIDDEN,
      );
    this.assertScope(query.cityId, actor);
    return this.configs.list(query);
  }

  @Post()
  @RequirePermissions(PermissionCode.UI_CONFIG_MANAGE)
  @ApiCreatedEnvelope()
  create(
    @Body() dto: CreateUiConfigDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    this.assertScope(dto.cityId, actor, true);
    return this.configs.create(dto, actor.id);
  }

  @Get(':id')
  @RequirePermissions(PermissionCode.UI_CONFIG_READ)
  @ApiOkEnvelope()
  async get(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const row = await this.configs.get(id);
    this.assertScope(row.cityId ?? undefined, actor);
    return row;
  }

  @Patch(':id')
  @RequirePermissions(PermissionCode.UI_CONFIG_MANAGE)
  @ApiOkEnvelope()
  async update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateUiConfigDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const row = await this.configs.get(id);
    this.assertScope(row.cityId ?? undefined, actor);
    this.assertScope(dto.cityId, actor, true);
    return this.configs.update(id, dto);
  }

  @Post(':id/validate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PermissionCode.UI_CONFIG_MANAGE)
  @ApiOperation({ summary: 'Validate and preview a draft without publishing' })
  @ApiOkEnvelope()
  async validate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const row = await this.configs.get(id);
    this.assertScope(row.cityId ?? undefined, actor);
    return this.configs.validate(id);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PermissionCode.UI_CONFIG_PUBLISH)
  @ApiOkEnvelope()
  @ApiErrorEnvelope(HttpStatus.CONFLICT, HttpStatus.SERVICE_UNAVAILABLE)
  async publish(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: PublishUiConfigDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const row = await this.configs.get(id);
    this.assertScope(row.cityId ?? undefined, actor, true);
    return this.configs.publish(id, actor.id, dto.reason);
  }

  @Post(':id/rollback')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(PermissionCode.UI_CONFIG_PUBLISH)
  @ApiOkEnvelope()
  async rollback(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: PublishUiConfigDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    const row = await this.configs.get(id);
    this.assertScope(row.cityId ?? undefined, actor, true);
    return this.configs.rollback(id, actor.id, dto.reason);
  }

  private assertScope(
    cityId: string | undefined,
    actor: AuthenticatedUser,
    globalNeedsPlatformAdmin = false,
  ): void {
    const scope = actor.cityScope ?? [];
    if (scope.length && !cityId && globalNeedsPlatformAdmin)
      throw apiError(
        'A city-scoped admin cannot manage a global UI config',
        HttpStatus.FORBIDDEN,
      );
    if (cityId && scope.length && !scope.includes(cityId))
      throw apiError('Outside your city scope', HttpStatus.FORBIDDEN);
  }
}
