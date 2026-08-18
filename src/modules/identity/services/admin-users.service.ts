import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { AdminUser } from '../../../prisma/client';
import { apiError } from '../../../common/utils';
import { FirebaseAdminService } from '../../../firebase/firebase-admin.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { CreateAdminUserDto } from '../dto/create-admin-user.dto';
import { UpdateAdminUserDto } from '../dto/update-admin-user.dto';
import { TokenService } from './token.service';

@Injectable()
export class AdminUsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly firebase: FirebaseAdminService,
  ) {}

  findAll(): Promise<AdminUser[]> {
    return this.prisma.adminUser.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async create(dto: CreateAdminUserDto): Promise<AdminUser> {
    const role = await this.prisma.role.findUnique({
      where: { id: dto.roleId },
    });
    if (!role) throw apiError('roleId does not exist', HttpStatus.BAD_REQUEST);

    const [existingPhone, existingEmail] = await Promise.all([
      this.prisma.adminUser.findUnique({ where: { phone: dto.phone } }),
      this.prisma.adminUser.findUnique({ where: { email: dto.email } }),
    ]);
    if (existingPhone) {
      throw apiError(
        'An admin with this phone already exists',
        HttpStatus.CONFLICT,
      );
    }
    if (existingEmail) {
      throw apiError(
        'An admin with this email already exists',
        HttpStatus.CONFLICT,
      );
    }

    // Creating the admin here *is* the registration step — there is no other
    // one, which is what keeps identity alone from ever granting access.
    const { uid: firebaseUid } = await this.firebase.createUser({
      email: dto.email,
      password: dto.password,
      displayName: dto.fullName,
    });

    try {
      return await this.prisma.adminUser.create({
        data: {
          phone: dto.phone,
          fullName: dto.fullName,
          email: dto.email,
          firebaseUid,
          roleId: dto.roleId,
          cityScopeJson: dto.cityScopeJson ?? [],
        },
      });
    } catch (error) {
      // Firebase is outside the Postgres transaction, so the rollback is
      // manual. Without it a failed insert leaves a Firebase account that
      // matches no admin row — an identity nobody can use and nobody can see.
      await this.firebase.deleteUser(firebaseUid);
      throw error;
    }
  }

  async update(id: string, dto: UpdateAdminUserDto): Promise<AdminUser> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id } });
    if (!admin) throw new NotFoundException('Admin user not found');

    if (dto.roleId) {
      const role = await this.prisma.role.findUnique({
        where: { id: dto.roleId },
      });
      if (!role)
        throw apiError('roleId does not exist', HttpStatus.BAD_REQUEST);
    }

    const updated = await this.prisma.adminUser.update({
      where: { id },
      data: {
        fullName: dto.fullName,
        email: dto.email,
        roleId: dto.roleId,
        cityScopeJson: dto.cityScopeJson,
        isActive: dto.isActive,
      },
    });

    if (dto.isActive === false) {
      await this.tokenService.revokeAllSessions('admin', id);
      // Keep a legacy Firebase-linked identity in sync. OTP-only Admins have
      // no Firebase uid; isActive is enforced during OTP verification.
      if (admin.firebaseUid) {
        await this.firebase.setDisabled(admin.firebaseUid, true);
      }
    } else if (dto.isActive === true && admin.firebaseUid) {
      await this.firebase.setDisabled(admin.firebaseUid, false);
    }

    return updated;
  }
}
