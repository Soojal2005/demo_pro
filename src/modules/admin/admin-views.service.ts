import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { apiError } from '../../common/utils';

const IN_FLIGHT = ['assigning', 'assigned', 'en_route', 'arrived', 'started'];

@Injectable()
export class AdminViewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async me(adminId: string) {
    const admin = await this.prisma.adminUser.findUnique({
      where: { id: adminId },
      include: { role: true },
    });
    if (!admin || !admin.isActive)
      throw new NotFoundException('Admin not found');
    const { firebaseUid: _firebaseUid, role, ...profile } = admin;
    void _firebaseUid;
    return {
      ...profile,
      cityScope: profile.cityScopeJson as string[],
      role: {
        id: role.id,
        name: role.name,
        permissions: role.permissionCodes as string[],
      },
    };
  }

  async liveDispatch(cityId: string, allowedCityIds?: string[]) {
    if (allowedCityIds?.length && !allowedCityIds.includes(cityId))
      throw apiError('Outside your city scope', HttpStatus.FORBIDDEN);
    const [bookings, pros] = await Promise.all([
      this.prisma.booking.findMany({
        where: { status: { in: IN_FLIGHT }, address: { cityId } },
        include: {
          address: true,
          service: { select: { id: true, name: true } },
          customer: { select: { id: true, fullName: true, phone: true } },
          pro: { select: { id: true, fullName: true, employeeCode: true } },
        },
        orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.pro.findMany({
        where: { cityId, status: 'approved' },
        select: {
          id: true,
          fullName: true,
          employeeCode: true,
          isAvailable: true,
          availabilityUpdatedAt: true,
          lastKnownLat: true,
          lastKnownLng: true,
          lastLocationAt: true,
          bookings: {
            where: { status: { in: IN_FLIGHT } },
            select: { id: true, bookingNumber: true, status: true },
            take: 1,
          },
        },
        orderBy: { fullName: 'asc' },
      }),
    ]);
    const proFrames = await Promise.all(
      pros.map(async (pro) => {
        let live: { longitude: number; latitude: number } | null = null;
        try {
          live = await this.redis.geoPosition('pros:live', pro.id);
        } catch {
          /* cold fallback is deliberate */
        }
        return {
          ...pro,
          position: live
            ? { lat: live.latitude, lng: live.longitude, source: 'redis' }
            : pro.lastKnownLat !== null && pro.lastKnownLng !== null
              ? {
                  lat: pro.lastKnownLat,
                  lng: pro.lastKnownLng,
                  source: 'last_known',
                }
              : null,
          isLocationStale:
            !pro.lastLocationAt ||
            Date.now() - pro.lastLocationAt.getTime() > 5 * 60_000,
        };
      }),
    );
    return {
      serverTime: new Date(),
      cityId,
      bookings: bookings.map((booking) => ({
        ...booking,
        waitingSeconds: Math.max(
          0,
          Math.floor((Date.now() - booking.createdAt.getTime()) / 1000),
        ),
      })),
      pros: proFrames,
    };
  }

  async customer360(customerId: string, allowedCityIds?: string[]) {
    await this.assertCustomerScope(customerId, allowedCityIds);
    const cityWhere = allowedCityIds?.length
      ? { cityId: { in: allowedCityIds } }
      : {};
    const bookingWhere = allowedCityIds?.length ? { address: cityWhere } : {};
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        addresses: {
          where: cityWhere,
          include: { city: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        },
        bookings: {
          where: bookingWhere,
          include: {
            service: { select: { id: true, name: true } },
            pro: { select: { id: true, fullName: true, employeeCode: true } },
            orders: { orderBy: { createdAt: 'desc' } },
            reviews: true,
          },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        orders: {
          where: allowedCityIds?.length ? { booking: bookingWhere } : {},
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        reviews: {
          where: allowedCityIds?.length ? { booking: bookingWhere } : {},
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        notificationLogs: {
          where: allowedCityIds?.length
            ? {
                OR: [
                  { bookingId: null },
                  { booking: { address: { cityId: { in: allowedCityIds } } } },
                ],
              }
            : {},
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    return {
      ...customer,
      support: await this.supportSummary({ customerId }),
    };
  }

  async pro360(proId: string, allowedCityIds?: string[]) {
    const pro = await this.prisma.pro.findUnique({
      where: { id: proId },
      include: {
        city: { select: { id: true, name: true } },
        applications: {
          select: {
            id: true,
            createdAt: true,
            queueStatus: true,
            aadhaarStatus: true,
            panStatus: true,
            verificationCallAt: true,
            decision: true,
            rejectionReason: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        services: {
          include: { service: { select: { id: true, name: true } } },
        },
        trainingProgress: {
          include: {
            module: { select: { id: true, title: true, isMandatory: true } },
          },
          orderBy: { updatedAt: 'desc' },
        },
        commissions: { orderBy: { computedAt: 'desc' }, take: 20 },
        payouts: { orderBy: { createdAt: 'desc' }, take: 20 },
        reviews: {
          where: { reviewerType: 'customer' },
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
        notificationLogs: {
          orderBy: { createdAt: 'desc' },
          take: 50,
        },
      },
    });
    if (!pro) throw new NotFoundException('Pro not found');
    if (
      allowedCityIds?.length &&
      (!pro.cityId || !allowedCityIds.includes(pro.cityId))
    )
      throw apiError('Outside your city scope', HttpStatus.FORBIDDEN);
    const { razorpayxContactId: _contact, ...safe } = pro;
    void _contact;
    return {
      ...safe,
      rating: {
        sum: pro.ratingSum,
        count: pro.ratingCount,
        average: pro.ratingCount ? pro.ratingSum / pro.ratingCount : null,
      },
      acceptance: {
        offered: pro.assignmentsOffered,
        acknowledged: pro.assignmentsAcknowledged,
        rate: pro.acceptanceRate,
        reportingOnly: true,
      },
      support: await this.supportSummary({ proId }),
    };
  }

  /**
   * The support and safety picture on a 360, now that module 11 exists.
   *
   * Counts, not rows. A 360 is a triage screen — an admin who needs the thread
   * opens the ticket. Loading forty threads to render five numbers is how a
   * 360 becomes the slowest page in the console.
   *
   * `openDisputes` is separated out because it is the count that changes what
   * an admin does next.
   */
  private async supportSummary(scope: {
    customerId?: string;
    proId?: string;
  }): Promise<{
    available: true;
    openTickets: number;
    openDisputes: number;
    totalTickets: number;
    openSosAlerts: number;
    recentTickets: unknown[];
  }> {
    const where = scope.customerId
      ? { customerId: scope.customerId }
      : { proId: scope.proId! };
    const open = { status: { in: ['open', 'in_progress', 'escalated'] } };

    const [
      openTickets,
      openDisputes,
      totalTickets,
      openSosAlerts,
      recentTickets,
    ] = await Promise.all([
      this.prisma.supportTicket.count({ where: { ...where, ...open } }),
      this.prisma.supportTicket.count({
        where: { ...where, ...open, category: 'dispute' },
      }),
      this.prisma.supportTicket.count({ where }),
      this.prisma.sosAlert.count({
        where: { ...where, status: { in: ['open', 'acknowledged'] } },
      }),
      this.prisma.supportTicket.findMany({
        where,
        select: {
          id: true,
          category: true,
          subject: true,
          status: true,
          priority: true,
          isInternal: true,
          createdAt: true,
          resolvedAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    return {
      available: true,
      openTickets,
      openDisputes,
      totalTickets,
      openSosAlerts,
      // Internal tickets are included: this is the ops console, and the
      // no-start incidents are exactly what an admin opening a Pro's 360 after
      // a complaint needs to see.
      recentTickets,
    };
  }

  private async assertCustomerScope(
    customerId: string,
    allowedCityIds?: string[],
  ): Promise<void> {
    if (!allowedCityIds?.length) return;
    const count = await this.prisma.customerAddress.count({
      where: { customerId, cityId: { in: allowedCityIds } },
    });
    if (!count) throw apiError('Outside your city scope', HttpStatus.FORBIDDEN);
  }
}
