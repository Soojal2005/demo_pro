import { Injectable, Logger } from '@nestjs/common';

export const SUBSCRIPTION_PORT = Symbol('SUBSCRIPTION_PORT');

/** What Payments needs to know before it can charge for a plan. */
export interface PurchasableSubscription {
  id: string;
  customerId: string;
  planCode: string;
  planName: string;
  /** Rupee decimal string, frozen on the subscription at purchase. */
  pricePaid: string;
  status: string;
}

/**
 * What Payments needs from Loyalty (module 16), expressed as an interface
 * Payments owns.
 *
 * Two methods, both for the same flow: a customer buying a plan with a card.
 * Payments must be able to price the thing before it opens checkout, and to
 * hand the plan over the moment the money lands.
 */
export interface SubscriptionPort {
  /**
   * Price and validate a pending subscription before checkout opens.
   *
   * Throws rather than returning null when the subscription is not
   * purchasable — every caller's only sensible response is to refuse with a
   * reason, and a null invites one of them to forget.
   */
  getPurchasable(
    subscriptionId: string,
    customerId: string,
  ): Promise<PurchasableSubscription>;

  /**
   * Money captured — the plan goes live.
   *
   * **Must be idempotent.** Razorpay redelivers webhooks, and `verifyCheckout`
   * races the webhook by design, so this is called twice on a healthy
   * purchase. A second call must not extend the cycle or re-grant the welcome
   * coins.
   */
  activateFromPayment(
    subscriptionId: string,
    paymentReference: string,
  ): Promise<void>;
}

/**
 * Stand-in when module 16 is absent, and the delegate it registers into.
 *
 * `getPurchasable` **throws**, like module 4's `createOrder` and unlike the
 * ledger and support stubs. The reasoning is the same one that split those
 * two groups: this runs *before* any money moves, so refusing costs a customer
 * a checkout screen they can retry. Returning a fake price would take a real
 * payment for a plan nothing can grant.
 *
 * `activateFromPayment` runs *after* the money has moved, so it cannot refuse
 * — but it is the loudest log in this module. A customer has been charged and
 * has nothing to show for it, and that is a support call, not a statistic.
 */
@Injectable()
export class NoOpSubscriptionService implements SubscriptionPort {
  private readonly logger = new Logger(NoOpSubscriptionService.name);

  private real: SubscriptionPort | null = null;

  register(implementation: SubscriptionPort): void {
    this.real = implementation;
    this.logger.log(
      'Subscriptions registered — a customer can now buy a plan online.',
    );
  }

  get isRegistered(): boolean {
    return this.real !== null;
  }

  getPurchasable(
    subscriptionId: string,
    customerId: string,
  ): Promise<PurchasableSubscription> {
    if (this.real) return this.real.getPurchasable(subscriptionId, customerId);

    // Deliberately an Error rather than an apiError: `LoyaltyModule` registers
    // unconditionally at boot, so reaching this means the module was removed
    // from `AppModule` while its routes were still being called — a wiring
    // bug, not something a client did.
    return Promise.reject(
      new Error(
        `Cannot price subscription ${subscriptionId} for customer ${customerId}: ` +
          'Loyalty (module 16) is not registered.',
      ),
    );
  }

  activateFromPayment(
    subscriptionId: string,
    paymentReference: string,
  ): Promise<void> {
    if (this.real) {
      return this.real.activateFromPayment(subscriptionId, paymentReference);
    }

    this.logger.error(
      `PAID BUT NOT ACTIVATED: payment ${paymentReference} was captured for ` +
        `subscription ${subscriptionId}, but Loyalty (module 16) is not ` +
        'registered. The customer has been charged and has no plan — activate ' +
        'it by hand from POST /admin/loyalty/subscriptions/:id/activate.',
    );
    return Promise.resolve();
  }
}
