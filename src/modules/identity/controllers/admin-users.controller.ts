import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ApiErrorEnvelope,
  ApiOkEnvelope,
} from '../../../common/swagger/api-envelope.decorator';
import type { AdminUser } from '../../../prisma/client';
import { PermissionCode } from '../constants/permission-code';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminUserDto } from '../dto/admin-user.dto';
import { CreateAdminUserDto } from '../dto/create-admin-user.dto';
import { UpdateAdminUserDto } from '../dto/update-admin-user.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { PermissionsGuard } from '../guards/permissions.guard';
import { AdminUsersService } from '../services/admin-users.service';

@ApiTags('Admin — Admin Users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/admin-users')
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  @RequirePermissions(PermissionCode.ADMIN_USER_MANAGE)
  @ApiOperation({ summary: 'List all admin users' })
  @ApiOkEnvelope(AdminUserDto, { isArray: true })
  @ApiErrorEnvelope(HttpStatus.FORBIDDEN)
  findAll(): Promise<AdminUser[]> {
    return this.adminUsersService.findAll();
  }

  @Post()
  @RequirePermissions(PermissionCode.ADMIN_USER_MANAGE)
  @ApiOperation({ summary: 'Provision a phone-OTP admin user' })
  @ApiOkEnvelope(AdminUserDto)
  @ApiErrorEnvelope(
    HttpStatus.FORBIDDEN,
    HttpStatus.BAD_REQUEST,
    HttpStatus.CONFLICT,
  )
  create(@Body() dto: CreateAdminUserDto): Promise<AdminUser> {
    return this.adminUsersService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(PermissionCode.ADMIN_USER_MANAGE)
  @ApiOperation({ summary: 'Update an admin user' })
  @ApiOkEnvelope(AdminUserDto)
  @ApiErrorEnvelope(
    HttpStatus.FORBIDDEN,
    HttpStatus.BAD_REQUEST,
    HttpStatus.NOT_FOUND,
  )
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAdminUserDto,
  ): Promise<AdminUser> {
    return this.adminUsersService.update(id, dto);
  }
}
