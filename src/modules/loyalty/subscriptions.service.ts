import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { Prisma } from '../../prisma/client';
import type {
  CustomerSubscription,
  SubscriptionPlan,
} from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from './wallet.service';
import { walletSourceRef } from './loyalty.types';
import type {
  CreateSubscriptionPlanDto,
  UpdateSubscriptionPlanDto,
} from './dto/subscription-plan.dto';

/** What the discount path needs to know about a customer's plan. */
export interface ActiveSubscriptionPerks {
  subscriptionId: string | null;
  planCode: string | null;
  planName: string | null;
  discountPercent: number;
  maxDiscountAmount: string | null;
  coinEarnMultiplier: number;
  waivesCancellationFee: boolean;
  extraReschedules: number;
  /** Null when the plan discounts every booking. */
  bookingsRemaining: number | null;
  expiresAt: Date | null;
}

/** The perks of having no subscription at all — the honest default. */
export const NO_SUBSCRIPTION: ActiveSubscriptionPerks = {
  subscriptionId: null,
  planCode: null,
  planName: null,
  discountPercent: 0,
  maxDiscountAmount: null,
  coinEarnMultiplier: 1,
  waivesCancellationFee: false,
  extraReschedules: 0,
  bookingsRemaining: null,
  expiresAt: null,
};

/**
 * Subscription plans, and what a customer's purchase of one entitles them to.
 *
 * The distinction this service exists to keep straight: `SubscriptionPlan` is
 * a **catalogue** row that marketing edits, and `CustomerSubscription` is an
 * **entitlement** that must not move once bought. Every perk is copied onto
 * the subscription at activation, exactly as `Booking.flatPrice` is frozen
 * from `Service` — a customer who bought 15% off keeps 15% off for the whole
 * cycle, whatever happens to the plan next week.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
  ) {}

  // ------------------------------------------------------------------
  // Catalogue
  // ------------------------------------------------------------------

  /**
   * The plans a customer can actually buy right now.
   *
   * A city-scoped plan is only offered in its city; a global plan is offered
   * everywhere. `cityId` comes from the caller's default address, so a
   * customer with no address yet sees the global plans only.
   */
  listPurchasablePlans(cityId?: string | null): Promise<SubscriptionPlan[]> {
    return this.prisma.subscriptionPlan.findMany({
      where: {
        isActive: true,
        ...(cityId ? { OR: [{ cityId: null }, { cityId }] } : { cityId: null }),
      },
      orderBy: [{ sortOrder: 'asc' }, { priceAmount: 'asc' }],
    });
  }

  listAllPlans(): Promise<SubscriptionPlan[]> {
    return this.prisma.subscriptionPlan.findMany({
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
    });
  }

  async createPlan(dto: CreateSubscriptionPlanDto): Promise<SubscriptionPlan> {
    try {
      return await this.prisma.subscriptionPlan.create({
        data: {
          code: dto.code,
          name: dto.name,
          description: dto.description ?? null,
          tier: dto.tier,
          sortOrder: dto.sortOrder ?? 0,
          priceAmount: dto.priceAmount,
          durationDays: dto.durationDays,
          discountPercent: dto.discountPercent ?? 0,
          maxDiscountAmount: dto.maxDiscountAmount ?? null,
          coinEarnMultiplier: dto.coinEarnMultiplier ?? 1,
          bonusCoins: dto.bonusCoins ?? 0,
          waivesCancellationFee: dto.waivesCancellationFee ?? false,
          extraReschedules: dto.extraReschedules ?? 0,
          priorityDispatch: dto.priorityDispatch ?? false,
          includedBookings: dto.includedBookings ?? null,
          cityId: dto.cityId ?? null,
          isActive: dto.isActive ?? true,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw apiError(
          'A plan with this code already exists',
          HttpStatus.CONFLICT,
          [
            {
              field: 'code',
              message: 'Must be unique',
              code: 'PLAN_CODE_TAKEN',
            },
          ],
        );
      }
      throw error;
    }
  }

  /**
   * Edit the catalogue row. **Live subscriptions are untouched** — that is the
   * point of freezing the perks at activation, and it is why this method takes
   * no care to migrate anyone.
   */
  async updatePlan(
    planId: string,
    dto: UpdateSubscriptionPlanDto,
  ): Promise<SubscriptionPlan> {
    await this.getPlanOrFail(planId);
    return this.prisma.subscriptionPlan.update({
      where: { id: planId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.tier !== undefined ? { tier: dto.tier } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        ...(dto.priceAmount !== undefined
          ? { priceAmount: dto.priceAmount }
          : {}),
        ...(dto.durationDays !== undefined
          ? { durationDays: dto.durationDays }
          : {}),
        ...(dto.discountPercent !== undefined
          ? { discountPercent: dto.discountPercent }
          : {}),
        ...(dto.maxDiscountAmount !== undefined
          ? { maxDiscountAmount: dto.maxDiscountAmount }
          : {}),
        ...(dto.coinEarnMultiplier !== undefined
          ? { coinEarnMultiplier: dto.coinEarnMultiplier }
          : {}),
        ...(dto.bonusCoins !== undefined ? { bonusCoins: dto.bonusCoins } : {}),
        ...(dto.waivesCancellationFee !== undefined
          ? { waivesCancellationFee: dto.waivesCancellationFee }
          : {}),
        ...(dto.extraReschedules !== undefined
          ? { extraReschedules: dto.extraReschedules }
          : {}),
        ...(dto.priorityDispatch !== undefined
          ? { priorityDispatch: dto.priorityDispatch }
          : {}),
        ...(dto.includedBookings !== undefined
          ? { includedBookings: dto.includedBookings }
          : {}),
        ...(dto.cityId !== undefined ? { cityId: dto.cityId } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
    });
  }

  // ------------------------------------------------------------------
  // Buying
  // ------------------------------------------------------------------

  /**
   * Start a purchase. Returns a subscription in `pending_payment`, which
   * entitles the customer to nothing until it is activated.
   *
   * **Deliberately two steps.** An entitlement created in the same call that
   * takes the money would be live before the money arrived, and a failed
   * checkout would leave a customer discounted for free. `pending_payment` is
   * the state where the plan is chosen and priced and nothing has been given
   * away.
   */
  async purchase(
    customerId: string,
    planId: string,
    paymentMode: 'online' | 'cash' | 'complimentary' = 'online',
  ): Promise<CustomerSubscription> {
    const plan = await this.getPlanOrFail(planId);

    if (!plan.isActive) {
      throw apiError('This plan is no longer on sale', HttpStatus.CONFLICT, [
        { field: 'planId', message: 'Plan is inactive', code: 'PLAN_INACTIVE' },
      ]);
    }

    const active = await this.findActive(customerId);
    if (active) {
      throw apiError(
        'You already have an active Homingo plan',
        HttpStatus.CONFLICT,
        [
          {
            field: 'planId',
            message: `Subscription ${active.id} runs until ${active.expiresAt?.toISOString() ?? 'an unset date'}`,
            code: 'SUBSCRIPTION_ALREADY_ACTIVE',
          },
        ],
      );
    }

    return this.prisma.customerSubscription.create({
      data: {
        customerId,
        planId: plan.id,
        status: 'pending_payment',
        pricePaid: plan.priceAmount,
        paymentMode,
        // Frozen here rather than at activation so the customer is shown, and
        // agrees to, exactly what they will get before they pay.
        discountPercent: plan.discountPercent,
        maxDiscountAmount: plan.maxDiscountAmount,
        coinEarnMultiplier: plan.coinEarnMultiplier,
        waivesCancellationFee: plan.waivesCancellationFee,
        extraReschedules: plan.extraReschedules,
        includedBookings: plan.includedBookings,
      },
    });
  }

  /**
   * Money received — the plan goes live.
   *
   * Idempotent: calling it on an already-active subscription returns it
   * unchanged rather than extending the window or granting the bonus coins a
   * second time. The caller is a payment confirmation, and payment
   * confirmations are redelivered.
   *
   * The one-active-per-customer rule is enforced by a **partial unique index**,
   * not by the `findActive` check above it. Two concurrent activations would
   * both pass that check; only one can win the index.
   */
  async activate(
    subscriptionId: string,
    paymentReference?: string | null,
    now = new Date(),
  ): Promise<CustomerSubscription> {
    const subscription = await this.getOrFail(subscriptionId);

    if (subscription.status === 'active') return subscription;
    if (subscription.status !== 'pending_payment') {
      throw apiError(
        'This subscription can no longer be activated',
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message: `Subscription is ${subscription.status}`,
            code: 'SUBSCRIPTION_NOT_PENDING',
          },
        ],
      );
    }

    const plan = await this.getPlanOrFail(subscription.planId);
    const expiresAt = new Date(now.getTime() + plan.durationDays * 86_400_000);

    let activated: CustomerSubscription;
    try {
      activated = await this.prisma.customerSubscription.update({
        where: { id: subscription.id },
        data: {
          status: 'active',
          activatedAt: now,
          expiresAt,
          ...(paymentReference ? { paymentReference } : {}),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw apiError(
          'You already have an active Homingo plan',
          HttpStatus.CONFLICT,
          [
            {
              field: 'status',
              message:
                'Another subscription for this customer is already active',
              code: 'SUBSCRIPTION_ALREADY_ACTIVE',
            },
          ],
        );
      }
      throw error;
    }

    // Non-fatal, and deliberately so: the subscription is bought and live. A
    // welcome bonus that failed to credit is worth a log and a support fix,
    // never a customer who paid and got nothing. Idempotent by `sourceRef`, so
    // a retry of this whole method still grants it once.
    if (plan.bonusCoins > 0) {
      try {
        await this.wallet.move({
          customerId: activated.customerId,
          type: 'subscription_bonus',
          coins: plan.bonusCoins,
          reason: `${plan.bonusCoins} welcome coins for joining ${plan.name}`,
          sourceRef: walletSourceRef.subscriptionBonus(activated.id),
          subscriptionId: activated.id,
        });
      } catch (error) {
        this.logger.error(
          `Subscription ${activated.id} activated, but its ${plan.bonusCoins} bonus coins were not credited.`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return activated;
  }

  /**
   * Stop a subscription early.
   *
   * **No refund is computed here.** What a part-used plan is worth back is an
   * ops judgement, the same as a window-E booking refund, and routing it to a
   * formula is exactly the mistake the cancellation flow warns against. The
   * row records that it was stopped and by whom; money goes back through the
   * refund path with a human on it.
   */
  async cancel(
    subscriptionId: string,
    reason: string,
    adminId?: string,
    now = new Date(),
  ): Promise<CustomerSubscription> {
    const subscription = await this.getOrFail(subscriptionId);

    if (['cancelled', 'expired'].includes(subscription.status)) {
      return subscription;
    }

    return this.prisma.customerSubscription.update({
      where: { id: subscription.id },
      data: {
        status: 'cancelled',
        cancelledAt: now,
        cancelReason: reason,
        cancelledByAdminId: adminId ?? null,
        // The CHECK constraint requires a cancelled row to keep a complete
        // window. A subscription cancelled before it was ever activated has
        // none, so one is written that starts and ends now — it was live for
        // no time at all, which is the truth.
        ...(subscription.activatedAt
          ? {}
          : { activatedAt: now, expiresAt: new Date(now.getTime() + 1000) }),
      },
    });
  }

  // ------------------------------------------------------------------
  // Reads the rest of the platform depends on
  // ------------------------------------------------------------------

  /**
   * The customer's live plan, or null.
   *
   * Lapses it in passing: a subscription whose `expiresAt` has gone by is
   * `expired` from that moment, and the sweep that writes the status down is a
   * tidy-up, not the thing that decides it. Reading a stale `active` row as
   * live would discount a booking against a plan that ended last night.
   */
  async findActive(
    customerId: string,
    now = new Date(),
  ): Promise<CustomerSubscription | null> {
    const subscription = await this.prisma.customerSubscription.findFirst({
      where: { customerId, status: 'active' },
    });

    if (!subscription) return null;

    if (subscription.expiresAt && subscription.expiresAt <= now) {
      await this.prisma.customerSubscription
        .update({
          where: { id: subscription.id },
          data: { status: 'expired' },
        })
        .catch(() => undefined);
      return null;
    }

    return subscription;
  }

  /**
   * The perks, in the shape the booking and cancellation paths want.
   *
   * Returns {@link NO_SUBSCRIPTION} rather than null, so no caller can forget
   * to handle "this customer has no plan" and accidentally read `undefined` as
   * a discount.
   */
  async perksFor(
    customerId: string,
    now = new Date(),
  ): Promise<ActiveSubscriptionPerks> {
    const subscription = await this.findActive(customerId, now);
    if (!subscription) return NO_SUBSCRIPTION;

    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id: subscription.planId },
      select: { code: true, name: true },
    });

    const bookingsRemaining =
      subscription.includedBookings === null
        ? null
        : Math.max(
            0,
            subscription.includedBookings - subscription.bookingsUsed,
          );

    // An exhausted allowance is not an expired plan — the coin multiplier, the
    // fee waiver and the extra reschedules all still apply. Only the
    // per-booking percentage stops.
    const discountPercent =
      bookingsRemaining === 0 ? 0 : Number(subscription.discountPercent);

    return {
      subscriptionId: subscription.id,
      planCode: plan?.code ?? null,
      planName: plan?.name ?? null,
      discountPercent,
      maxDiscountAmount: subscription.maxDiscountAmount?.toString() ?? null,
      coinEarnMultiplier: Number(subscription.coinEarnMultiplier),
      waivesCancellationFee: subscription.waivesCancellationFee,
      extraReschedules: subscription.extraReschedules,
      bookingsRemaining,
      expiresAt: subscription.expiresAt,
    };
  }

  /** Called once a subscription has actually discounted a booking. */
  async recordBookingUse(subscriptionId: string): Promise<void> {
    await this.prisma.customerSubscription
      .update({
        where: { id: subscriptionId },
        data: { bookingsUsed: { increment: 1 } },
      })
      .catch((error: unknown) => {
        this.logger.error(
          `Could not increment bookingsUsed on subscription ${subscriptionId}.`,
          error instanceof Error ? error.stack : String(error),
        );
      });
  }

  /** Undoes {@link recordBookingUse} when the booking it counted is cancelled. */
  async releaseBookingUse(subscriptionId: string): Promise<void> {
    // `updateMany` with a guard rather than `update`: decrementing past zero
    // would fail the CHECK constraint, and a subscription whose counter is
    // already zero has nothing to give back.
    await this.prisma.customerSubscription.updateMany({
      where: { id: subscriptionId, bookingsUsed: { gt: 0 } },
      data: { bookingsUsed: { decrement: 1 } },
    });
  }

  listForCustomer(customerId: string): Promise<CustomerSubscription[]> {
    return this.prisma.customerSubscription.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Write down every subscription whose window has closed.
   *
   * A tidy-up, not an authority: {@link findActive} already treats a lapsed row
   * as gone. This exists so the admin list and the analytics query do not each
   * have to reimplement that rule.
   */
  async expireLapsed(now = new Date()): Promise<{ expired: number }> {
    const result = await this.prisma.customerSubscription.updateMany({
      where: { status: 'active', expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    return { expired: result.count };
  }

  async getOrFail(subscriptionId: string): Promise<CustomerSubscription> {
    const subscription = await this.prisma.customerSubscription.findUnique({
      where: { id: subscriptionId },
    });
    if (!subscription) {
      throw apiError('Subscription not found', HttpStatus.NOT_FOUND);
    }
    return subscription;
  }

  /** Ownership first — someone else's subscription must look like none. */
  async getOwnedOrFail(
    customerId: string,
    subscriptionId: string,
  ): Promise<CustomerSubscription> {
    const subscription = await this.prisma.customerSubscription.findFirst({
      where: { id: subscriptionId, customerId },
    });
    if (!subscription) {
      throw apiError('Subscription not found', HttpStatus.NOT_FOUND);
    }
    return subscription;
  }

  private async getPlanOrFail(planId: string): Promise<SubscriptionPlan> {
    const plan = await this.prisma.subscriptionPlan.findUnique({
      where: { id: planId },
    });
    if (!plan) throw apiError('Plan not found', HttpStatus.NOT_FOUND);
    return plan;
  }
}
