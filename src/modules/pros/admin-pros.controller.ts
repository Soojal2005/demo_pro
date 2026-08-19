import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../common/swagger/api-envelope.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user.type';
import type {
  Pro,
  ProApplication,
  ProBankAccount,
  ProService,
} from '../../prisma/client';
import { PermissionCode } from '../identity/constants/permission-code';
import { AdminProQueryDto } from './dto/admin-pro-query.dto';
import { AdminApplicationQueryDto } from './dto/admin-application-query.dto';
import type { Paged } from '../../common/dto/paged-query.dto';
import { RequirePermissions } from '../identity/decorators/require-permissions.decorator';
import { CityScopedResource } from '../identity/decorators/city-scoped-resource.decorator';
import { CityScopeGuard } from '../identity/guards/city-scope.guard';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PermissionsGuard } from '../identity/guards/permissions.guard';
import { AdminUpdateProProfileDto } from './dto/admin-update-pro-profile.dto';
import { ApplicationDecisionDto } from './dto/application-decision.dto';
import { AssignServiceDto } from './dto/assign-service.dto';
import { BulkAvailabilityDto } from './dto/bulk-availability.dto';
import { DocumentViewUrlResponseDto } from './dto/document-view-url-response.dto';
import { ProApplicationDto } from './dto/pro-application.dto';
import { ProBankAccountDto } from './dto/pro-bank-account.dto';
import { ProServiceDto } from './dto/pro-service.dto';
import { ProDto } from './dto/pro.dto';
import { SetAvailabilityDto } from './dto/set-availability.dto';
import { SetBankVerificationDto } from './dto/set-bank-verification.dto';
import { SuspendProDto } from './dto/suspend-pro.dto';
import { UpdateProServiceDto } from './dto/update-pro-service.dto';
import { VerifyDocumentDto } from './dto/verify-document.dto';
import { KycDocumentsService } from './kyc-documents.service';
import { ProBankAccountsService } from './pro-bank-accounts.service';
import {
  ProApplicationsService,
  type ProApplicationWithApplicant,
} from './pro-applications.service';
import { ProServiceAssignmentsService } from './pro-service-assignments.service';
import { ProsService } from './pros.service';

@ApiTags('Admin — Pros')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard, CityScopeGuard)
@Controller('admin')
export class AdminProsController {
  constructor(
    private readonly prosService: ProsService,
    private readonly applicationsService: ProApplicationsService,
    private readonly serviceAssignmentsService: ProServiceAssignmentsService,
    private readonly kycDocumentsService: KycDocumentsService,
    private readonly bankAccountsService: ProBankAccountsService,
  ) {}

  // ----- Onboarding queue -----

  @Get('pro-applications')
  @RequirePermissions(PermissionCode.PRO_APPLICATION_REVIEW)
  @ApiOperation({
    summary: 'List onboarding applications',
    description:
      'Paged, longest-waiting first — this is a queue rather than an archive. ' +
      'Returns `{ data, meta }`; a cap here would leave applications nobody ' +
      'ever sees, with the applicants waiting and no sign of why.',
  })
  @ApiOkEnvelope(ProApplicationDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN)
  listApplications(
    @Query() query: AdminApplicationQueryDto,
    @CurrentUser() actor?: AuthenticatedUser,
  ): Promise<Paged<ProApplicationWithApplicant>> {
    return this.applicationsService.findAll(
      {
        search: query.search,
        queueStatus: query.status,
        page: query.page,
        limit: query.limit,
      },
      actor?.cityScope,
    );
  }

  @Get('pro-applications/:id')
  @CityScopedResource('proApplication')
  @RequirePermissions(PermissionCode.PRO_APPLICATION_REVIEW)
  @ApiOperation({
    summary: 'One onboarding application',
    description:
      'A detail view needs its own read. Finding the row inside the list only ' +
      'worked while the list was unpaged; with paging it returns nothing for ' +
      'anything past the first page.',
  })
  @ApiOkEnvelope(ProApplicationDto)
  @ApiErrorEnvelope(
    HttpStatus.UNAUTHORIZED,
    HttpStatus.FORBIDDEN,
    HttpStatus.NOT_FOUND,
  )
  getApplication(
    @Param('id') id: string,
  ): Promise<ProApplicationWithApplicant> {
    return this.applicationsService.findOne(id);
  }

  @Patch('pro-applications/:id/verify-document')
  @CityScopedResource('proApplication')
  @RequirePermissions(PermissionCode.PRO_APPLICATION_REVIEW)
  @ApiOperation({
    summary: 'Verify or reject one document (Aadhaar/PAN independently)',
  })
  @ApiOkEnvelope(ProApplicationDto)
  @ApiErrorEnvelope(
    HttpStatus.FORBIDDEN,
    HttpStatus.BAD_REQUEST,
    HttpStatus.NOT_FOUND,
  )
  verifyDocument(
    @Param('id') id: string,
    @Body() dto: VerifyDocumentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ProApplication> {
    return this.applicationsService.verifyDocument(id, dto, actor.id);
  }

  @Get('pro-applications/:id/documents/:docType/view-url')
  @CityScopedResource('proApplication')
  @RequirePermissions(PermissionCode.PRO_APPLICATION_REVIEW)
  @ApiOperation({
    summary: 'Get a short-lived presigned URL to view a KYC document',
  })
  @ApiOkEnvelope(DocumentViewUrlResponseDto)
  @ApiErrorEnvelope(
    HttpStatus.FORBIDDEN,
    HttpStatus.BAD_REQUEST,
    HttpStatus.NOT_FOUND,
  )
  requestDocumentViewUrl(
    @Param('id') id: string,
    @Param('docType') docType: string,
  ): Promise<{ viewUrl: string; expiresIn: number }> {
    return this.kycDocumentsService.requestViewUrl(id, docType);
  }

  @Patch('pro-applications/:id/log-call')
  @CityScopedResource('proApplication')
  @RequirePermissions(PermissionCode.PRO_APPLICATION_REVIEW)
  @ApiOperation({ summary: 'Log a verification call against an application' })
  @ApiOkEnvelope(ProApplicationDto)
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  logCall(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ProApplication> {
    return this.applicationsService.logCall(id, actor.id);
  }

  @Patch('pro-applications/:id/decision')
  @CityScopedResource('proApplication')
  @RequirePermissions(PermissionCode.PRO_APPLICATION_REVIEW)
  @ApiOperation({ summary: 'Approve or reject an application' })
  @ApiOkEnvelope(ProApplicationDto)
  @ApiErrorEnvelope(
    HttpStatus.FORBIDDEN,
    HttpStatus.BAD_REQUEST,
    HttpStatus.CONFLICT,
    HttpStatus.NOT_FOUND,
  )
  decide(
    @Param('id') id: string,
    @Body() dto: ApplicationDecisionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<ProApplication> {
    return this.applicationsService.decide(id, dto, actor.id);
  }

  // ----- Roster & moderation -----

  @Get('pros')
  @RequirePermissions(PermissionCode.PRO_MODERATE)
  @ApiOperation({
    summary: 'List Pros (roster view)',
    description:
      '`search` matches name, employee code or phone in the database. The ' +
      'list is capped, so a console filtering the returned page instead would ' +
      'silently find nothing for every Pro past the cap.',
  })
  @ApiOkEnvelope(ProDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN)
  findMany(
    @Query() query: AdminProQueryDto,
    @CurrentUser() actor?: AuthenticatedUser,
  ): Promise<Pro[]> {
    return this.prosService.findMany(query, actor?.cityScope);
  }

  @Patch('pros/:id/profile')
  @CityScopedResource('pro')
  @RequirePermissions(PermissionCode.PRO_MODERATE)
  @ApiOperation({
    summary: "Set a Pro's city assignment and/or recorded monthly salary",
  })
  @ApiOkEnvelope(ProDto)
  @ApiErrorEnvelope(
    HttpStatus.FORBIDDEN,
    HttpStatus.BAD_REQUEST,
    HttpStatus.NOT_FOUND,
  )
  updateProfile(
    @Param('id') id: string,
    @Body() dto: AdminUpdateProProfileDto,
  ): Promise<Pro> {
    return this.prosService.updateProfileByAdmin(id, dto);
  }

  @Patch('pros/:id/suspend')
  @CityScopedResource('pro')
  @RequirePermissions(PermissionCode.PRO_MODERATE)
  @ApiOperation({ summary: 'Suspend a Pro' })
  @ApiOkEnvelope(ProDto)
  @ApiErrorEnvelope(
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.NOT_FOUND,
  )
  suspend(
    @Param('id') id: string,
    @Body() dto: SuspendProDto,
    @CurrentUser() actor: AuthenticatedUser,
  ): Promise<Pro> {
    return this.prosService.suspend(id, dto, actor.id);
  }

  @Patch('pros/:id/reinstate')
  @CityScopedResource('pro')
  @RequirePermissions(PermissionCode.PRO_MODERATE)
  @ApiOperation({ summary: 'Reinstate a suspended Pro' })
  @ApiOkEnvelope(ProDto)
  @ApiErrorEnvelope(
    HttpStatus.FORBIDDEN,
    HttpStatus.CONFLICT,
    HttpStatus.NOT_FOUND,
  )
  reinstate(@Param('id') id: string): Promise<Pro> {
    return this.prosService.reinstate(id);
  }

  @Patch('pros/:id/availability')
  @CityScopedResource('pro')
  @RequirePermissions(PermissionCode.PRO_AVAILABILITY_SET)
  @ApiOperation({ summary: 'Toggle a single Pro on/off duty' })
  @ApiOkEnvelope(ProDto)
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  setAvailability(
    @Param('id') id: string,
    @Body() dto: SetAvailabilityDto,
  ): Promise<Pro> {
    return this.prosService.setAvailability(id, dto.isAvailable);
  }

  @Patch('pros/availability/bulk')
  @CityScopedResource('bulkPros')
  @RequirePermissions(PermissionCode.PRO_AVAILABILITY_SET)
  @ApiOperation({ summary: 'Bulk toggle a set of Pros on/off duty' })
  @ApiOkEnvelope(ProDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.BAD_REQUEST)
  bulkSetAvailability(@Body() dto: BulkAvailabilityDto): Promise<Pro[]> {
    return this.prosService.bulkSetAvailability(dto.proIds, dto.isAvailable);
  }

  // ----- Service assignment -----

  @Get('pros/:id/services')
  @CityScopedResource('pro')
  @RequirePermissions(PermissionCode.PRO_MODERATE)
  @ApiOperation({ summary: "List a Pro's service assignments" })
  @ApiOkEnvelope(ProServiceDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  listServices(@Param('id') proId: string): Promise<ProService[]> {
    return this.serviceAssignmentsService.list(proId);
  }

  @Post('pros/:id/services')
  @CityScopedResource('pro')
  @RequirePermissions(PermissionCode.PRO_MODERATE)
  @ApiOperation({ summary: 'Assign a Pro to a service' })
  @ApiOkEnvelope(ProServiceDto)
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.CONFLICT)
  assignService(
    @Param('id') proId: string,
    @Body() dto: AssignServiceDto,
  ): Promise<ProService> {
    return this.serviceAssignmentsService.assign(proId, dto);
  }

  @Patch('pros/:id/services/:serviceId')
  @CityScopedResource('pro')
  @RequirePermissions(PermissionCode.PRO_MODERATE)
  @ApiOperation({
    summary: 'Update a Pro-service assignment (e.g. suspend one service)',
  })
  @ApiOkEnvelope(ProServiceDto)
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  updateServiceAssignment(
    @Param('id') proId: string,
    @Param('serviceId') serviceId: string,
    @Body() dto: UpdateProServiceDto,
  ): Promise<ProService> {
    return this.serviceAssignmentsService.update(proId, serviceId, dto);
  }

  // ----- Payout destinations -----

  @Get('pros/:id/bank-accounts')
  @CityScopedResource('pro')
  @RequirePermissions(PermissionCode.PRO_BANK_VERIFY)
  @ApiOperation({ summary: "List a Pro's payout destinations" })
  @ApiOkEnvelope(ProBankAccountDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  listBankAccounts(@Param('id') proId: string): Promise<ProBankAccount[]> {
    return this.bankAccountsService.list(proId);
  }

  @Patch('pros/:id/bank-accounts/:accountId/verification')
  @CityScopedResource('pro')
  @RequirePermissions(PermissionCode.PRO_BANK_VERIFY)
  @ApiOperation({ summary: 'Vouch for (or withdraw) a payout destination' })
  @ApiOkEnvelope(ProBankAccountDto)
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
  setBankVerification(
    @Param('id') proId: string,
    @Param('accountId') accountId: string,
    @Body() dto: SetBankVerificationDto,
  ): Promise<ProBankAccount> {
    return this.bankAccountsService.setVerified(
      proId,
      accountId,
      dto.isVerified,
    );
  }
}
