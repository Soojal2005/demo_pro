import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
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
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { VerifyOtpDto } from '../dto/verify-otp.dto';
import { OTP_PROVIDER, type OtpProvider } from '../otp/otp-provider.interface';
import { TokenPair, TokenService } from './token.service';

/**
 * The account behind a verified session, in the one shape every client reads.
 *
 * Customers, Pros and Admins are three tables with three different column
 * names for the same four facts, and the apps do not care which table they
 * came out of — so the mapping happens here, once, rather than in each client.
 * `photoUrl` is null for the two actors that have nowhere to store one.
 */
export interface AuthAccount {
  id: string;
  phone: string | null;
  name: string | null;
  email: string | null;
  photoUrl: string | null;
}

/**
 * What a successful OTP verify returns.
 *
 * The token pair alone is not enough: the client has just learned who it is
 * talking to and immediately needs the account to show. Sending it here rather
 * than making the app follow up with a profile request keeps sign-in to one
 * round trip, and means there is no window where the app is signed in but has
 * nothing to display.
 */
export interface AuthSession extends TokenPair {
  /** True the first time this phone has ever verified. */
  isNewUser: boolean;
  user: AuthAccount;
}

/**
 * `resolveActor`'s answer: who the token is minted for, what the client shows,
 * and whether this account came into existence just now.
 */
interface ResolvedActor {
  actor: AuthenticatedUser;
  account: AuthAccount;
  isNewUser: boolean;
}

/**
 * "" means clear the field, not store an empty string.
 *
 * A column holding '' reads as set everywhere downstream — an invoice would
 * address itself to nobody rather than falling back to the phone number.
 */
const blankToNull = (value: string): string | null => value.trim() || null;

@Injectable()
export class AuthService {
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
    return result;
  }

  async verifyOtp(dto: VerifyOtpDto): Promise<AuthSession> {
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

    const { actor, account, isNewUser } = await this.resolveActor(dto);
    await this.redis.del(
      `otp:active:${dto.phone}`,
      `otp:failed:${dto.phone}`,
      `otp:lock:${dto.phone}`,
    );
    const tokens = await this.tokenService.issueTokenPair(actor);
    return { ...tokens, isNewUser, user: account };
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

  /**
   * The account behind the presented access token.
   *
   * What an app calls on a cold start to find out whether a stored token is
   * still worth anything — a 401 here is its signal to sign out. The row is
   * read fresh rather than decoded from the JWT: a name edited on another
   * device, or an account blocked since the token was minted, has to show up.
   */
  async me(user: AuthenticatedUser): Promise<AuthAccount> {
    if (user.actorType === 'customer') {
      const customer = await this.prisma.customer.findUnique({
        where: { id: user.id },
      });
      if (!customer || customer.isBlocked) {
        throw new UnauthorizedException('This account is no longer active');
      }
      return this.customerAccount(customer);
    }

    if (user.actorType === 'pro') {
      const pro = await this.prisma.pro.findUnique({ where: { id: user.id } });
      if (!pro) {
        throw new UnauthorizedException('This account is no longer active');
      }
      return this.proAccount(pro);
    }

    const admin = await this.prisma.adminUser.findUnique({
      where: { id: user.id },
    });
    if (!admin || !admin.isActive) {
      throw new UnauthorizedException('This account is no longer active');
    }
    return this.adminAccount(admin);
  }

  /**
   * Edit the parts of an account its owner is allowed to change.
   *
   * An omitted field is left alone and an empty string clears it — the two are
   * different intentions, and collapsing them would make "I never touched my
   * email" indistinguishable from "delete my email".
   *
   * The phone number is not editable here by anyone. It is the auth
   * credential, and changing it would hand the account to a number that has
   * never proved ownership through OTP.
   */
  async updateProfile(
    user: AuthenticatedUser,
    dto: UpdateProfileDto,
  ): Promise<AuthAccount> {
    if (user.actorType === 'admin') {
      throw new ForbiddenException(
        'Admin profiles are managed in the admin console',
      );
    }

    if (user.actorType === 'pro') {
      // Pro.fullName is copied from the approved KYC application and is the
      // name a customer is shown at their door. Self-service must not touch it.
      if (dto.name !== undefined) {
        throw new ForbiddenException(
          'A Pro name comes from their verified KYC application and cannot be edited here',
        );
      }
      if (dto.email === undefined) {
        return this.me(user);
      }
      const pro = await this.prisma.pro.update({
        where: { id: user.id },
        data: { email: blankToNull(dto.email) },
      });
      return this.proAccount(pro);
    }

    const data: { fullName?: string | null; email?: string | null } = {};
    if (dto.name !== undefined) data.fullName = blankToNull(dto.name);
    if (dto.email !== undefined) data.email = blankToNull(dto.email);

    // Nothing to write — but the caller still asked "what is my account", and
    // `me` re-checks that it is still active, which a bare update would not.
    if (Object.keys(data).length === 0) return this.me(user);

    const customer = await this.prisma.customer.findUnique({
      where: { id: user.id },
    });
    if (!customer || customer.isBlocked) {
      throw new UnauthorizedException('This account is no longer active');
    }

    return this.customerAccount(
      await this.prisma.customer.update({ where: { id: user.id }, data }),
    );
  }

  async logout(refreshToken: string): Promise<void> {
    await this.tokenService.revokeSession(refreshToken);
  }

  async logoutAll(user: AuthenticatedUser): Promise<void> {
    await this.tokenService.revokeAllSessions(user.actorType, user.id);
  }

  /**
   * The only way into the admin console.
   *
   * Firebase proves *who* someone is — by password or by Google, both of which
   * resolve to the same uid for one person. The `AdminUser` lookup below
   * decides whether that identity is *allowed*, and it is never created here:
   * an admin exists because another admin provisioned them, or not at all.
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

  // `admin` never reaches here: `VerifyOtpDto` rejects it at validation, so
  // the console has exactly one way in and this method has two actors to
  // consider rather than a third that quietly bypassed Firebase.
  private async resolveActor(dto: VerifyOtpDto): Promise<ResolvedActor> {
    if (dto.actorType === 'customer') return this.resolveCustomer(dto);
    return this.resolvePro(dto.phone);
  }

  private async resolveCustomer(dto: VerifyOtpDto): Promise<ResolvedActor> {
    let customer = await this.prisma.customer.findUnique({
      where: { phone: dto.phone },
    });

    /*
     * Read before any of the branches below run. Once a guest row has been
     * converted or a fresh row created, nothing left in scope can still tell
     * the two apart — and the app uses this to decide whether to ask a
     * first-time customer for their name.
     */
    const isNewUser = !customer;

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
    return {
      actor: { id: customer.id, actorType: 'customer' },
      account: this.customerAccount(customer),
      isNewUser,
    };
  }

  private async resolvePro(phone: string): Promise<ResolvedActor> {
    let pro = await this.prisma.pro.findUnique({ where: { phone } });
    const isNewUser = !pro;
    pro ??= await this.prisma.pro.create({
      data: { phone, status: 'applied' },
    });
    return {
      actor: {
        id: pro.id,
        actorType: 'pro',
        accessMode: pro.status === 'suspended' ? 'suspended_read_only' : 'full',
      },
      account: this.proAccount(pro),
      isNewUser,
    };
  }

  /*
   * The three table-to-account mappings, in one place.
   *
   * Structurally typed rather than taking the Prisma models, so the only thing
   * they depend on is the handful of columns actually read. Both `verifyOtp`
   * and `/auth/me` go through these — the account a client is handed at
   * sign-in and the one it re-reads later must not be allowed to drift apart.
   */
  private customerAccount(customer: {
    id: string;
    phone: string | null;
    fullName: string | null;
    email: string | null;
  }): AuthAccount {
    return {
      id: customer.id,
      phone: customer.phone ?? null,
      name: customer.fullName ?? null,
      email: customer.email ?? null,
      // No column for it on Customer. Pros have a photo because their profile
      // is shown to customers; the reverse is not true.
      photoUrl: null,
    };
  }

  private proAccount(pro: {
    id: string;
    phone: string;
    fullName: string | null;
    email: string | null;
    profilePhotoUrl: string | null;
  }): AuthAccount {
    return {
      id: pro.id,
      phone: pro.phone,
      name: pro.fullName ?? null,
      email: pro.email ?? null,
      photoUrl: pro.profilePhotoUrl ?? null,
    };
  }

  private adminAccount(admin: {
    id: string;
    phone: string;
    fullName: string;
    email: string;
  }): AuthAccount {
    return {
      id: admin.id,
      phone: admin.phone,
      name: admin.fullName,
      email: admin.email,
      photoUrl: null,
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
