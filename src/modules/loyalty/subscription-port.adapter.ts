import { HttpStatus, Injectable } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type {
  PurchasableSubscription,
  SubscriptionPort,
} from '../payments/ports/subscription.port';
import { PrismaService } from '../../prisma/prisma.service';
import { SubscriptionsService } from './subscriptions.service';

/**
 * Module 16's half of module 7's {@link SubscriptionPort}.
 *
 * Two methods either side of a payment: price the plan before checkout opens,
 * and hand it over once the money lands. Everything that can refuse the
 * purchase lives in the first one, so nothing has to refuse after a card has
 * been charged.
 */
@Injectable()
export class SubscriptionPortAdapter implements SubscriptionPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  /**
   * Everything that could make this purchase invalid, checked **before** the
   * gateway order exists.
   *
   * Ownership first, and with the same message whether the row is missing or
   * belongs to somebody else — otherwise this endpoint enumerates other
   * customers' subscription ids.
   */
  async getPurchasable(
    subscriptionId: string,
    customerId: string,
  ): Promise<PurchasableSubscription> {
    const subscription = await this.prisma.customerSubscription.findFirst({
      where: { id: subscriptionId, customerId },
      include: { plan: { select: { code: true, name: true } } },
    });

    if (!subscription) {
      throw apiError('Subscription not found', HttpStatus.NOT_FOUND);
    }

    if (subscription.status !== 'pending_payment') {
      throw apiError(
        subscription.status === 'active'
          ? 'This plan is already active'
          : `This plan is ${subscription.status}, so it cannot be paid for`,
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message: 'Only a pending subscription can open checkout',
            code: 'SUBSCRIPTION_NOT_PENDING',
          },
        ],
      );
    }

    if (subscription.paymentMode !== 'online') {
      throw apiError(
        subscription.paymentMode === 'complimentary'
          ? 'This plan was granted by Homingo — there is nothing to pay'
          : 'This plan is settled in cash, so there is nothing to pay now',
        HttpStatus.CONFLICT,
        [
          {
            field: 'paymentMode',
            message: 'Only an online subscription has a gateway order',
            code: 'SUBSCRIPTION_NOT_ONLINE',
          },
        ],
      );
    }

    // The one-live-plan rule again, checked here as well as at purchase: a
    // customer can create a pending plan, buy a different one, and come back
    // to pay for the first. Charging them for a second live plan the database
    // would then refuse to activate is the worst possible order of events.
    const active = await this.subscriptions.findActive(customerId);
    if (active) {
      throw apiError(
        'You already have an active Homingo plan',
        HttpStatus.CONFLICT,
        [
          {
            field: 'customerId',
            message: `Subscription ${active.id} is already live`,
            code: 'SUBSCRIPTION_ALREADY_ACTIVE',
          },
        ],
      );
    }

    return {
      id: subscription.id,
      customerId: subscription.customerId,
      planCode: subscription.plan.code,
      planName: subscription.plan.name,
      // Frozen when the plan was chosen. A repricing between choosing and
      // paying must not change what the customer was quoted.
      pricePaid: subscription.pricePaid.toString(),
      status: subscription.status,
    };
  }

  /**
   * The money landed.
   *
   * Straight through to the same `activate` the admin route calls, so there is
   * exactly one activation path and one place where the window is set and the
   * welcome coins are granted. It is idempotent, which is what makes it safe
   * for a redelivered webhook and for `verifyCheckout` racing it.
   */
  async activateFromPayment(
    subscriptionId: string,
    paymentReference: string,
  ): Promise<void> {
    await this.subscriptions.activate(subscriptionId, paymentReference);
  }
}
