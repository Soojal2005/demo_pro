import {
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Pro, Prisma } from '../../prisma/client';
import { apiError } from '../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';
import { TRACKING_CHANNEL } from '../../redis/channels';
import { RedisService } from '../../redis/redis.service';
import { TokenService } from '../identity/services/token.service';
import { Inject } from '@nestjs/common';
import { AdminUpdateProProfileDto } from './dto/admin-update-pro-profile.dto';
import { IngestLocationDto } from './dto/ingest-location.dto';
import { SuspendProDto } from './dto/suspend-pro.dto';
import { UpdateProDto } from './dto/update-pro.dto';
import {
  PRO_LOCATION_RESOLVER_PORT,
  type ProLocationResolverPort,
  type ProResolvedLocation,
} from './ports/pro-location-resolver.port';

const PRO_LIVE_GEO_KEY = 'pros:live';

@Injectable()
export class ProsService {
  private readonly logger = new Logger(ProsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly tokenService: TokenService,
    @Inject(PRO_LOCATION_RESOLVER_PORT)
    private readonly locationResolver: ProLocationResolverPort,
  ) {}

  async getById(id: string): Promise<Pro> {
    const pro = await this.prisma.pro.findUnique({ where: { id } });
    if (!pro) throw new NotFoundException('Pro not found');
    return pro;
  }

  /**
   * How many approved Pros are on the books in a city.
   *
   * Exists for the Catalog module's city-activation gate (US-3.9): launching a
   * city with no supply produces bookings nobody can serve. Counts `approved`
   * only — not `isAvailable`, which is a daily on/off-duty flag and would make
   * the answer depend on the hour ops happened to press the button.
   */
  countApprovedInCity(cityId: string): Promise<number> {
    return this.prisma.pro.count({ where: { cityId, status: 'approved' } });
  }

  async update(id: string, dto: UpdateProDto): Promise<Pro> {
    await this.getById(id);
    return this.prisma.pro.update({ where: { id }, data: dto });
  }

  /**
   * Admin-only fields — city assignment and the recorded (reference-only)
   * monthly salary. Kept separate from update() (the Pro's own self-edit
   * path) since neither field should ever be Pro-editable.
   */
  async updateProfileByAdmin(
    id: string,
    dto: AdminUpdateProProfileDto,
  ): Promise<Pro> {
    await this.getById(id);

    if (dto.cityId) {
      const city = await this.prisma.city.findUnique({
        where: { id: dto.cityId },
      });
      if (!city)
        throw apiError('cityId does not exist', HttpStatus.BAD_REQUEST);
    }

    const updated = await this.prisma.pro.update({
      where: { id },
      data: {
        ...(dto.cityId ? { cityId: dto.cityId } : {}),
        ...(dto.monthlySalary !== undefined
          ? { monthlySalary: dto.monthlySalary, salaryUpdatedAt: new Date() }
          : {}),
      },
    });

    return updated;
  }

  /**
   * Live position into Redis GEO (what dispatch will query), plus an
   * immediate cold flush to Pro.lastKnownLat/Lng — simplest correct version
   * of "periodic cold flush" until a real background job exists.
   */
  async ingestLocation(
    id: string,
    dto: IngestLocationDto,
  ): Promise<ProResolvedLocation> {
    const pro = await this.getById(id);
    if (pro.status !== 'approved' || !pro.isAvailable) {
      throw apiError(
        'Live location is accepted only while the Pro is approved and on duty',
        HttpStatus.FORBIDDEN,
      );
    }
    await this.redis.geoAdd(PRO_LIVE_GEO_KEY, dto.lng, dto.lat, id);

    // Announce it so module 4 can push the new position to whoever is
    // watching this Pro arrive — on this instance and on every other one.
    //
    // Published rather than called: BookingsModule already imports this
    // module, so a direct call would be a cycle. Redis is the decoupling, and
    // a dropped announcement costs one map frame while the durable state
    // above is already written.
    await this.redis
      .publish(TRACKING_CHANNEL, {
        proId: id,
        lat: dto.lat,
        lng: dto.lng,
        reportedAt: new Date().toISOString(),
      })
      .catch(() => undefined);
    await this.prisma.pro.update({
      where: { id },
      data: {
        lastKnownLat: dto.lat,
        lastKnownLng: dto.lng,
        lastLocationAt: new Date(),
      },
    });
    return this.locationResolver.resolve(dto.lat, dto.lng);
  }

  async findMany(
    filters: {
      search?: string;
      cityId?: string;
      isAvailable?: boolean;
      status?: string;
    },
    allowedCityIds?: string[],
  ): Promise<Pro[]> {
    const where: Prisma.ProWhereInput = {
      // In the database, not over the returned page. The three fields are the
      // three an admin actually has to hand: a name from a conversation, a
      // code off a roster, a number from a support ticket.
      ...(filters.search && {
        OR: [
          { fullName: { contains: filters.search, mode: 'insensitive' } },
          { employeeCode: { contains: filters.search, mode: 'insensitive' } },
          { phone: { contains: filters.search, mode: 'insensitive' } },
        ],
      }),
      ...(filters.cityId
        ? { cityId: filters.cityId }
        : allowedCityIds?.length
          ? { cityId: { in: allowedCityIds } }
          : {}),
      ...(filters.isAvailable !== undefined
        ? { isAvailable: filters.isAvailable }
        : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };

    return this.prisma.pro.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async setAvailability(id: string, isAvailable: boolean): Promise<Pro> {
    await this.getById(id);

    const updated = await this.prisma.pro.update({
      where: { id },
      data: { isAvailable, availabilityUpdatedAt: new Date() },
    });

    return updated;
  }

  async bulkSetAvailability(
    proIds: string[],
    isAvailable: boolean,
  ): Promise<Pro[]> {
    const results: Pro[] = [];
    for (const id of proIds) {
      results.push(await this.setAvailability(id, isAvailable));
    }
    return results;
  }

  async suspend(
    id: string,
    dto: SuspendProDto,
    actingAdminId: string,
  ): Promise<Pro> {
    const pro = await this.getById(id);
    if (pro.status !== 'approved') {
      throw apiError(
        `Cannot suspend a Pro with status "${pro.status}"`,
        HttpStatus.CONFLICT,
      );
    }

    const liveBookings = await this.prisma.booking.findMany({
      where: {
        proId: id,
        status: { in: ['assigned', 'en_route', 'arrived', 'started'] },
      },
      select: { id: true, bookingNumber: true, status: true },
    });

    if (liveBookings.length > 0 && !dto.confirmLiveBookingHandling) {
      throw apiError(
        'This Pro has live bookings that require an explicit ops decision',
        HttpStatus.CONFLICT,
        liveBookings.map((booking) => ({
          field: 'confirmLiveBookingHandling',
          code: 'LIVE_BOOKING_REQUIRES_RESOLUTION',
          message: `${booking.bookingNumber} is ${booking.status}`,
        })),
      );
    }
    if (!dto.reason?.trim()) {
      throw apiError(
        'reason is required to suspend a Pro',
        HttpStatus.BAD_REQUEST,
      );
    }
    const reason = dto.reason.trim();

    const updated = await this.prisma.$transaction(async (tx) => {
      for (const booking of liveBookings) {
        const reassign =
          booking.status === 'assigned' || booking.status === 'en_route';
        await tx.booking.update({
          where: { id: booking.id },
          data: reassign
            ? {
                status: 'assigning',
                proId: null,
                assignmentOutcome: 'ops_reassigned',
                overriddenByAdminId: actingAdminId,
                overrideReason: reason,
              }
            : {
                overriddenByAdminId: actingAdminId,
                overrideReason: reason,
              },
        });
        await tx.bookingStatusEvent.create({
          data: {
            bookingId: booking.id,
            status: reassign ? 'assigning' : booking.status,
            actorType: 'ops',
            actorId: actingAdminId,
          },
        });
      }

      return tx.pro.update({
        where: { id },
        data: {
          status: 'suspended',
          isAvailable: false,
          availabilityUpdatedAt: new Date(),
          suspendedReason: reason,
          suspendedAt: new Date(),
          suspendedByAdminId: actingAdminId,
        },
      });
    });

    try {
      await this.redis.geoRemove(PRO_LIVE_GEO_KEY, id);
    } catch (error) {
      this.logger.warn(
        `Could not remove suspended Pro ${id} from Redis GEO: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }

    await this.tokenService.revokeAllSessions('pro', id);

    return updated;
  }

  async reinstate(id: string): Promise<Pro> {
    const pro = await this.getById(id);
    if (pro.status !== 'suspended') {
      throw apiError(
        `Cannot reinstate a Pro with status "${pro.status}"`,
        HttpStatus.CONFLICT,
      );
    }

    const activeServiceCount = await this.prisma.proService.count({
      where: { proId: id, isActive: true },
    });
    const blockers = [
      ...(activeServiceCount === 0
        ? [
            {
              field: 'activeServiceGate',
              code: 'NO_ACTIVE_SERVICE',
              message: 'At least one active ProService is required',
            },
          ]
        : []),
      ...(!pro.isAvailable
        ? [
            {
              field: 'availabilityGate',
              code: 'PRO_NOT_AVAILABLE',
              message: 'The Pro must be switched on before reinstatement',
            },
          ]
        : []),
    ];
    if (blockers.length > 0) {
      throw apiError(
        'All dispatchability gates must pass before reinstatement',
        HttpStatus.CONFLICT,
        blockers,
      );
    }

    return this.prisma.pro.update({
      where: { id },
      data: { status: 'approved' },
    });
  }

  /**
   * Kept here (rather than the applications service) since it mutates Pro
   * directly. Sequence-backed so concurrent approvals can't hand out the
   * same code — see the initial Prisma migration for pro_employee_code_seq.
   */
  async generateEmployeeCode(): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ nextval: bigint }[]>`
      SELECT nextval('pro_employee_code_seq') AS nextval
    `;
    return `HG-${rows[0].nextval.toString().padStart(5, '0')}`;
  }
}
