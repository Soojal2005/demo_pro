import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiAcceptedEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import { apiError } from '../../common/utils';
import { PermissionCode } from '../identity/constants/permission-code';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AdminJobsService } from './admin-jobs.service';
import { AdminViewsService } from './admin-views.service';
import {
  AdminAnalyticsQueryDto,
  AdminJobQueryDto,
  CreateBulkJobDto,
  CreateReportExportDto,
  PlatformSettingQueryDto,
  ResetPlatformSettingDto,
  UpsertPlatformSettingDto,
} from './dto/admin.dto';
import { PlatformSettingsAdminService } from './platform-settings-admin.service';
import { BookingsService } from '../bookings/bookings.service';
import { ReassignBookingDto } from './dto/admin.dto';

@ApiTags('Admin Console')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly views: AdminViewsService,
    private readonly settings: PlatformSettingsAdminService,
    private readonly jobs: AdminJobsService,
    private readonly analytics: AdminAnalyticsService,
    private readonly bookings: BookingsService,
  ) {}

  @Get('me')
  @RequirePermissions()
  @ApiOperation({
    summary: 'Current admin profile, role, permissions and city scope',
  })
  @ApiOkEnvelope()
  me(@CurrentUser() actor: AuthenticatedUser) {
    return this.views.me(actor.id);
  }

  @Get('dispatch/live-map')
  @RequirePermissions(
    PermissionCode.ADMIN_DASHBOARD_READ,
    PermissionCode.DISPATCH_READ,
  )
  @ApiOperation({ summary: 'Current city dispatch snapshot for a polling map' })
  @ApiOkEnvelope()
  liveMap(
    @Query('cityId', new ParseUUIDPipe({ version: '4' })) cityId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.views.liveDispatch(cityId, actor.cityScope);
  }

  @Get('customers/:id/360')
  @RequirePermissions(PermissionCode.CUSTOMER_READ)
  @ApiOkEnvelope()
  customer360(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.views.customer360(id, actor.cityScope);
  }

  @Get('pros/:id/360')
  @RequirePermissions(PermissionCode.PRO_READ)
  @ApiOkEnvelope()
  pro360(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.views.pro360(id, actor.cityScope);
  }

  @Post('bookings/:id/reassign')
  @RequirePermissions(PermissionCode.DISPATCH_OVERRIDE)
  @ApiOkEnvelope()
  reassign(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ReassignBookingDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.bookings.reassignByAdmin(id, dto, actor.id, actor.cityScope);
  }

  @Get('platform-settings')
  @RequirePermissions(PermissionCode.PLATFORM_SETTING_READ)
  @ApiOkEnvelope()
  listSettings(
    @Query() query: PlatformSettingQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (
      query.cityId &&
      actor.cityScope?.length &&
      !actor.cityScope.includes(query.cityId)
    )
      throw apiError('Outside your city scope', HttpStatus.FORBIDDEN);
    return this.settings.list(query.cityId, query.key);
  }

  @Put('platform-settings/:key')
  @RequirePermissions(PermissionCode.PLATFORM_SETTING_MANAGE)
  @ApiOkEnvelope()
  setSetting(
    @Param('key') key: string,
    @Body() dto: UpsertPlatformSettingDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (actor.cityScope?.length && !dto.cityId)
      throw apiError(
        'A city-scoped admin cannot change a global setting',
        HttpStatus.FORBIDDEN,
      );
    if (
      dto.cityId &&
      actor.cityScope?.length &&
      !actor.cityScope.includes(dto.cityId)
    )
      throw apiError('Outside your city scope', HttpStatus.FORBIDDEN);
    return this.settings.upsert(
      key,
      dto.value,
      dto.cityId,
      actor.id,
      dto.reason,
      dto.confirmImpact,
    );
  }

  @Get('platform-settings/:key/revisions')
  @RequirePermissions(PermissionCode.PLATFORM_SETTING_READ)
  @ApiOkEnvelope()
  settingRevisions(
    @Param('key') key: string,
    @Query('cityId') cityId: string | undefined,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (cityId && actor.cityScope?.length && !actor.cityScope.includes(cityId))
      throw apiError('Outside your city scope', HttpStatus.FORBIDDEN);
    return this.settings.revisions(key, cityId);
  }

  @Delete('platform-settings/:key')
  @RequirePermissions(PermissionCode.PLATFORM_SETTING_MANAGE)
  @ApiOkEnvelope()
  resetSetting(
    @Param('key') key: string,
    @Query('cityId', new ParseUUIDPipe({ version: '4' })) cityId: string,
    @Body() dto: ResetPlatformSettingDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (actor.cityScope?.length && !actor.cityScope.includes(cityId))
      throw apiError('Outside your city scope', HttpStatus.FORBIDDEN);
    return this.settings.removeOverride(
      key,
      cityId,
      actor.id,
      dto.reason,
      dto.confirmImpact,
    );
  }

  @Post('bulk-jobs')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(PermissionCode.ADMIN_BULK_EXECUTE)
  @ApiAcceptedEnvelope()
  createBulk(
    @Body() dto: CreateBulkJobDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ) {
    return this.jobs.createBulk(dto, actor.id, actor.cityScope, request.ip);
  }

  @Post('reports/exports')
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermissions(PermissionCode.REPORT_EXPORT)
  @ApiAcceptedEnvelope()
  createExport(
    @Body() dto: CreateReportExportDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() request: FastifyRequest,
  ) {
    return this.jobs.createReport(dto, actor.id, actor.cityScope, request.ip);
  }

  @Get('jobs')
  @RequirePermissions(PermissionCode.ADMIN_JOB_READ)
  @ApiOkEnvelope()
  listJobs(
    @Query() query: AdminJobQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.jobs.list(actor.id, query);
  }

  @Get('jobs/:id')
  @RequirePermissions(PermissionCode.ADMIN_JOB_READ)
  @ApiOkEnvelope()
  getJob(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.jobs.get(id, actor.id);
  }

  @Get('jobs/:id/download')
  @RequirePermissions(PermissionCode.ADMIN_JOB_READ)
  @ApiOkEnvelope()
  download(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.jobs.download(id, actor.id);
  }

  @Get('analytics/overview')
  @RequirePermissions(
    PermissionCode.REPORT_ANALYTICS_READ,
    PermissionCode.BOOKING_READ,
  )
  @ApiOkEnvelope()
  overview(
    @Query() query: AdminAnalyticsQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.analytics.overview(query, actor.cityScope);
  }

  @Get('analytics/retention')
  @RequirePermissions(
    PermissionCode.REPORT_ANALYTICS_READ,
    PermissionCode.CUSTOMER_READ,
  )
  @ApiOkEnvelope()
  retention(
    @Query() query: AdminAnalyticsQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.analytics.retention(query, actor.cityScope);
  }

  @Get('analytics/cities')
  @RequirePermissions(
    PermissionCode.REPORT_ANALYTICS_READ,
    PermissionCode.BOOKING_READ,
  )
  @ApiOkEnvelope()
  cities(
    @Query() query: AdminAnalyticsQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.analytics.cities(query, actor.cityScope);
  }
}
