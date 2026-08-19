import { Injectable, Logger } from '@nestjs/common';

export const LOYALTY_PORT = Symbol('LOYALTY_PORT');

/**
 * What one booking's price is made of, once loyalty has had its say.
 *
 * Every amount is a rupee decimal string, like every other money value that
 * crosses a boundary in this codebase (CONFLICTS_AND_DECISIONS #12).
 */
export interface DiscountQuote {
  flatPrice: string;
  subscriptionDiscountAmount: string;
  coinsRedeemed: number;
  walletDiscountAmount: string;
  discountAmount: string;
  payableAmount: string;

  /** The subscription that produced the discount, frozen onto the booking. */
  subscriptionId: string | null;
  planName: string | null;

  /** For the app's "you could save more" line — never used in arithmetic. */
  coinBalance: number;
  maxRedeemableCoins: number;
  /** What this booking would earn back on completion, at today's rate. */
  coinsEarnedEstimate: number;
}

/** The two subscription perks the cancellation and reschedule paths read. */
export interface BookingPerks {
  waivesCancellationFee: boolean;
  extraReschedules: number;
  planName: string | null;
}

/**
 * What Booking needs from Loyalty (module 16), expressed as an interface
 * Booking owns.
 *
 * The same shape as {@link COMMISSION_PORT} and for the same reason: module 4
 * is the spine and must not import a module that sits above it. Module 16 in
 * turn reads module 4's `PlatformSettingsService`, so an import in the other
 * direction would be a cycle Nest refuses to construct.
 *
 * **Everything here is optional to the booking flow.** Bound to the no-op
 * below, every booking is priced at its flat price, earns nothing, and cancels
 * under the plain policy — which is exactly how the platform behaved before
 * this module existed.
 */
export interface LoyaltyPort {
  /**
   * Price a booking before it exists.
   *
   * Called twice per booking in the normal flow: once by `POST
   * /bookings/quote` so the customer can see the number before agreeing to it,
   * and once inside `create` so the number they agreed to is the one written.
   * It must therefore be a **pure read** — nothing is spent here.
   */
  quote(input: {
    customerId: string;
    flatPrice: string;
    coinsRequested: number;
    cityId: string | null;
  }): Promise<DiscountQuote>;

  /**
   * Spend what the quote promised, now that the booking is real.
   *
   * Called immediately after the row is written, with the amounts already
   * frozen onto it. **May fail**, and the caller has to cope: a customer can
   * spend the same coins on another booking in the seconds between the quote
   * and this call. Module 4 handles that by re-pricing the booking to its full
   * amount rather than by failing the booking — see `BookingsService.create`.
   */
  commit(bookingId: string): Promise<void>;

  /**
   * Give back what a cancelled booking took: coins returned, the
   * subscription's booking allowance released.
   *
   * **Must be idempotent**, like every other method here — cancellation can be
   * retried, and a booking must not be able to refund its coins twice.
   */
  release(bookingId: string): Promise<void>;

  /**
   * A job finished: credit the coins it earned and settle any referral it
   * qualifies.
   *
   * **Must be idempotent.** The call site retries nothing; a sweeper on the
   * other side re-runs anything that failed.
   */
  onBookingCompleted(bookingId: string): Promise<void>;

  /** The subscription perks that alter the cancellation and reschedule rules. */
  perksFor(customerId: string): Promise<BookingPerks>;
}

/** What a customer with no plan and no coins gets — the honest default. */
const NO_PERKS: BookingPerks = {
  waivesCancellationFee: false,
  extraReschedules: 0,
  planName: null,
};

/**
 * Stand-in when module 16 is absent, and the delegate it registers into.
 *
 * Fails **silently and safely**, unlike module 4's payments stub and like its
 * commission one. The distinction is again what the failure costs: a booking
 * with a phantom order is unrecoverable, so `createOrder` throws. A booking
 * priced at its full flat price is simply a booking with no discount — the
 * customer pays the advertised amount, which is never wrong, only ungenerous.
 *
 * `quote` deliberately returns a real, complete quote rather than throwing, so
 * `POST /bookings/quote` keeps working and the app has one code path whether
 * or not loyalty is deployed.
 */
@Injectable()
export class NoOpLoyaltyService implements LoyaltyPort {
  private readonly logger = new Logger(NoOpLoyaltyService.name);

  /**
   * The real implementation, registered at boot by module 16 if it is present.
   *
   * The same indirection `NoOpCommissionService` uses, for the same reason:
   * Nest resolves providers per module, so re-binding `LOYALTY_PORT` inside
   * `LoyaltyModule` would never reach `BookingsService`.
   */
  private real: LoyaltyPort | null = null;

  register(implementation: LoyaltyPort): void {
    this.real = implementation;
    this.logger.log(
      'Loyalty registered — coins, subscriptions and referrals are live on bookings.',
    );
  }

  get isRegistered(): boolean {
    return this.real !== null;
  }

  quote(input: {
    customerId: string;
    flatPrice: string;
    coinsRequested: number;
    cityId: string | null;
  }): Promise<DiscountQuote> {
    if (this.real) return this.real.quote(input);

    return Promise.resolve({
      flatPrice: input.flatPrice,
      subscriptionDiscountAmount: '0.00',
      coinsRedeemed: 0,
      walletDiscountAmount: '0.00',
      discountAmount: '0.00',
      payableAmount: input.flatPrice,
      subscriptionId: null,
      planName: null,
      coinBalance: 0,
      maxRedeemableCoins: 0,
      coinsEarnedEstimate: 0,
    });
  }

  commit(bookingId: string): Promise<void> {
    if (this.real) return this.real.commit(bookingId);
    // Nothing was ever quoted as a discount, so there is nothing to spend.
    return Promise.resolve();
  }

  release(bookingId: string): Promise<void> {
    if (this.real) return this.real.release(bookingId);
    return Promise.resolve();
  }

  onBookingCompleted(bookingId: string): Promise<void> {
    if (this.real) return this.real.onBookingCompleted(bookingId);

    this.logger.debug(
      `Booking ${bookingId} completed, but Loyalty (module 16) is not built — no coins were earned.`,
    );
    return Promise.resolve();
  }

  perksFor(customerId: string): Promise<BookingPerks> {
    if (this.real) return this.real.perksFor(customerId);
    return Promise.resolve(NO_PERKS);
  }
}
