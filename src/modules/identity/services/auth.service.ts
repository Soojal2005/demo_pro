import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user.type';
import { FirebaseAdminService } from '../../../firebase/firebase-admin.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { RedisService } from '../../../redis/redis.service';
import { FirebaseLoginDto } from '../dto/firebase-login.dto';
import { GuestSessionDto } from '../dto/guest-session.dto';
import { RequestOtpDto } from '../dto/request-otp.dto';
import { VerifyOtpDto } from '../dto/verify-otp.dto';
import { OTP_PROVIDER, type OtpProvider } from '../otp/otp-provider.interface';
import {
  maskPhone,
  recipientForeignKey,
} from '../../notifications/notification.types';
import { TokenPair, TokenService } from './token.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  constructor(
    @Inject(OTP_PROVIDER) private readonly otpProvider: OtpProvider,
    private readonly tokenService: TokenService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly firebase: FirebaseAdminService,
  ) {}

  async requestOtp(dto: RequestOtpDto): Promise<{ providerRef: string }> {
    const attempts = await this.redis.incrWithExpiry(
      `otp:rl:${dto.phone}`,
      this.numberConfig('OTP_REQUEST_WINDOW_SECONDS', 3600),
    );
    if (attempts > this.numberConfig('OTP_REQUEST_LIMIT', 5)) {
      throw new HttpException(
        'Too many OTP requests for this number - try again later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const result = await this.otpProvider.sendOtp(dto.phone);
    await this.redis.set(
      `otp:active:${dto.phone}`,
      result.providerRef,
      this.numberConfig('OTP_TTL_SECONDS', 300),
    );
    await this.recordOtpRequest(dto, result.providerRef);
    return result;
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<TokenPair> {
    if (await this.redis.get(`otp:lock:${dto.phone}`)) {
      throw new HttpException(
        'Too many incorrect codes - request a new OTP later',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const activeRef = await this.redis.get(`otp:active:${dto.phone}`);
    if (!activeRef || activeRef !== dto.providerRef) {
      throw new UnauthorizedException('Invalid or expired OTP request');
    }

    // Provider exceptions (including outages) deliberately propagate as 503.
    // Only a clean `false` is a user-code failure and counts toward lockout.
    const isValid = await this.otpProvider.verifyOtp(
      dto.phone,
      dto.code,
      dto.providerRef,
    );
    if (!isValid) {
      const failed = await this.redis.incrWithExpiry(
        `otp:failed:${dto.phone}`,
        this.numberConfig('OTP_VERIFY_WINDOW_SECONDS', 300),
      );
      if (failed >= this.numberConfig('OTP_VERIFY_MAX_ATTEMPTS', 5)) {
        await this.redis.set(
          `otp:lock:${dto.phone}`,
          '1',
          this.numberConfig('OTP_VERIFY_LOCKOUT_SECONDS', 900),
        );
      }
      throw new UnauthorizedException('Invalid or expired code');
    }

    const user = await this.resolveActor(dto);
    if (dto.pushToken && dto.pushPlatform)
      await this.storePushToken(user, dto.pushToken, dto.pushPlatform);
    await this.redis.del(
      `otp:active:${dto.phone}`,
      `otp:failed:${dto.phone}`,
      `otp:lock:${dto.phone}`,
    );
    return this.tokenService.issueTokenPair(user);
  }

  private async recordOtpRequest(
    dto: RequestOtpDto,
    providerRef: string,
  ): Promise<void> {
    try {
      const recipient =
        dto.actorType === 'customer'
          ? await this.prisma.customer.findUnique({
              where: { phone: dto.phone },
            })
          : dto.actorType === 'pro'
            ? await this.prisma.pro.findUnique({ where: { phone: dto.phone } })
            : await this.prisma.adminUser.findUnique({
                where: { phone: dto.phone },
              });
      await this.prisma.notificationLog.create({
        data: {
          dedupeKey: `otp:${providerRef}`,
          recipientType: dto.actorType,
          ...(recipient
            ? recipientForeignKey(dto.actorType, recipient.id)
            : {}),
          recipientMasked: maskPhone(dto.phone),
          channel:
            this.config.get<string>('SLIDE_DEFAULT_CHANNEL', 'whatsapp') ===
            'sms'
              ? 'sms'
              : 'whatsapp',
          provider: 'slide',
          templateKey: 'auth.otp',
          payloadJson: { kind: 'otp', secretStored: false },
          status: 'accepted',
          providerReference: providerRef,
          sentAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(
        `OTP ${providerRef} was sent but its notification log could not be written: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async storePushToken(
    user: AuthenticatedUser,
    pushToken: string,
    pushPlatform: 'android' | 'ios',
  ): Promise<void> {
    const data = {
      pushToken,
      pushPlatform,
      pushTokenUpdatedAt: new Date(),
    };
    if (user.actorType === 'customer')
      await this.prisma.customer.update({ where: { id: user.id }, data });
    else if (user.actorType === 'pro')
      await this.prisma.pro.update({ where: { id: user.id }, data });
    else await this.prisma.adminUser.update({ where: { id: user.id }, data });
  }

  async createGuestSession(dto: GuestSessionDto): Promise<TokenPair> {
    await this.purgeAbandonedGuests();
    let customer = await this.prisma.customer.findUnique({
      where: { deviceId: dto.deviceId },
    });
    customer ??= await this.prisma.customer.create({
      data: { deviceId: dto.deviceId, status: 'guest' },
    });
    if (customer.isBlocked) {
      throw new UnauthorizedException('This account has been blocked');
    }
    return this.tokenService.issueTokenPair({
      id: customer.id,
      actorType: 'customer',
    });
  }

  refreshTokens(refreshToken: string): Promise<TokenPair> {
    return this.tokenService.rotateRefreshToken(refreshToken);
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokenService.revokeSession(refreshToken);
  }

  async logoutAll(user: AuthenticatedUser): Promise<void> {
    await this.tokenService.revokeAllSessions(user.actorType, user.id);
  }

  /**
   * Legacy compatibility for Admins already linked to Firebase. New Admin
   * authentication uses the common phone OTP request/verify endpoints.
   */
  async loginWithFirebase(dto: FirebaseLoginDto): Promise<TokenPair> {
    const decoded = await this.firebase.verifyIdToken(dto.idToken);

    const admin = await this.prisma.adminUser.findUnique({
      where: { firebaseUid: decoded.uid },
    });
    if (!admin) {
      throw new UnauthorizedException(
        'No admin account is linked to this identity',
      );
    }
    if (!admin.isActive) {
      throw new UnauthorizedException('Admin account is deactivated');
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    return this.tokenService.issueTokenPair({
      id: admin.id,
      actorType: 'admin',
      roleId: admin.roleId,
      cityScope: (admin.cityScopeJson as string[]) ?? [],
    });
  }

  private async resolveActor(dto: VerifyOtpDto): Promise<AuthenticatedUser> {
    if (dto.actorType === 'customer') return this.resolveCustomer(dto);
    if (dto.actorType === 'pro') return this.resolvePro(dto.phone);
    return this.resolveAdmin(dto.phone);
  }

  /** OTP proves phone ownership; the existing AWS AdminUser grants access. */
  private async resolveAdmin(phone: string): Promise<AuthenticatedUser> {
    let admin = await this.prisma.adminUser.findUnique({ where: { phone } });
    // Existing AWS seeds may contain a pre-E.164 10-digit Indian number.
    // Exact E.164 always wins, avoiding ambiguity where both forms exist.
    if (!admin && /^\+91\d{10}$/.test(phone)) {
      admin = await this.prisma.adminUser.findUnique({
        where: { phone: phone.slice(3) },
      });
    }
    if (!admin) {
      throw new UnauthorizedException(
        'No admin account is linked to this phone number',
      );
    }
    if (!admin.isActive) {
      throw new UnauthorizedException('Admin account is deactivated');
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    });

    return {
      id: admin.id,
      actorType: 'admin',
      roleId: admin.roleId,
      cityScope: (admin.cityScopeJson as string[]) ?? [],
    };
  }

  private async resolveCustomer(dto: VerifyOtpDto): Promise<AuthenticatedUser> {
    let customer = await this.prisma.customer.findUnique({
      where: { phone: dto.phone },
    });

    if (dto.deviceId) {
      const guest = await this.prisma.customer.findUnique({
        where: { deviceId: dto.deviceId },
      });
      if (guest?.status === 'guest' && guest.id !== customer?.id) {
        customer = customer
          ? await this.mergeGuestIntoVerified(guest.id, customer.id)
          : await this.prisma.customer.update({
              where: { id: guest.id },
              data: {
                phone: dto.phone,
                status: 'verified',
                verifiedAt: new Date(),
              },
            });
      }
    }

    customer ??= await this.prisma.customer.create({
      data: { phone: dto.phone, status: 'verified', verifiedAt: new Date() },
    });
    if (customer.isBlocked) {
      throw new UnauthorizedException('This account has been blocked');
    }
    return { id: customer.id, actorType: 'customer' };
  }

  private async resolvePro(phone: string): Promise<AuthenticatedUser> {
    let pro = await this.prisma.pro.findUnique({ where: { phone } });
    pro ??= await this.prisma.pro.create({
      data: { phone, status: 'applied' },
    });
    return {
      id: pro.id,
      actorType: 'pro',
      accessMode: pro.status === 'suspended' ? 'suspended_read_only' : 'full',
    };
  }

  private async mergeGuestIntoVerified(guestId: string, verifiedId: string) {
    return this.prisma.$transaction(async (tx) => {
      const verified = await tx.customer.findUniqueOrThrow({
        where: { id: verifiedId },
      });
      const guest = await tx.customer.findUniqueOrThrow({
        where: { id: guestId },
      });
      if (verified.defaultAddressId) {
        await tx.customerAddress.updateMany({
          where: { customerId: guestId, isDefault: true },
          data: { isDefault: false },
        });
      }
      await tx.customerAddress.updateMany({
        where: { customerId: guestId },
        data: { customerId: verifiedId },
      });
      const updated = await tx.customer.update({
        where: { id: verifiedId },
        data: verified.defaultAddressId
          ? {}
          : { defaultAddressId: guest.defaultAddressId },
      });
      await tx.customer.delete({ where: { id: guestId } });
      return updated;
    });
  }

  private numberConfig(name: string, fallback: number): number {
    const value = Number(this.config.get<string>(name));
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  private async purgeAbandonedGuests(): Promise<void> {
    const interval = this.numberConfig('GUEST_PURGE_INTERVAL_SECONDS', 86400);
    const acquired = await this.redis.setIfAbsent(
      'maintenance:guest-purge',
      '1',
      interval,
    );
    if (!acquired) return;
    const retentionDays = this.numberConfig('GUEST_RETENTION_DAYS', 30);
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
    await this.prisma.customer.deleteMany({
      where: {
        status: 'guest',
        phone: null,
        createdAt: { lt: cutoff },
        addresses: { none: {} },
      },
    });
  }
}
