import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  BookingPerks,
  DiscountQuote,
  LoyaltyPort,
} from '../bookings/ports/loyalty.port';
import {
  coinsEarnedFor,
  computeDiscounts,
  tierForCompletedBookings,
  walletSourceRef,
} from './loyalty.types';
import { ReferralsService } from './referrals.service';
import { SubscriptionsService } from './subscriptions.service';
import { WalletService } from './wallet.service';

/**
 * Module 16's half of module 4's {@link LoyaltyPort}.
 *
 * All five methods are idempotent, because every one of them is called from a
 * path module 4 retries: a double-tapped booking, a redelivered completion, a
 * cancellation a support agent runs twice. Idempotency here is carried by
 * `WalletTransaction.sourceRef` — the unique index does the work, and this
 * class only has to build the keys correctly.
 *
 * Nothing in here throws for a customer-visible reason except
 * {@link commit}, which is allowed to: an overdrawn wallet is a real conflict
 * module 4 has an answer for.
 */
@Injectable()
export class LoyaltyPortAdapter implements LoyaltyPort {
  private readonly logger = new Logger(LoyaltyPortAdapter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly subscriptions: SubscriptionsService,
    private readonly referrals: ReferralsService,
  ) {}

  /**
   * Price a booking. A **pure read** — the contract says so, and the booking
   * quote endpoint calls it on every keystroke of the coin slider.
   */
  async quote(input: {
    customerId: string;
    flatPrice: string;
    coinsRequested: number;
    cityId: string | null;
  }): Promise<DiscountQuote> {
    const [perks, balance, config, completedBookings] = await Promise.all([
      this.subscriptions.perksFor(input.customerId),
      this.wallet.getBalance(input.customerId),
      this.wallet.readConfig(),
      this.prisma.booking.count({
        where: { customerId: input.customerId, status: 'completed' },
      }),
    ]);

    const breakdown = computeDiscounts({
      flatPrice: input.flatPrice,
      coinsRequested: input.coinsRequested,
      coinBalance: balance,
      coinValueRupees: config.coinValueRupees,
      maxRedemptionPercent: config.maxRedemptionPercent,
      subscriptionDiscountPercent: perks.discountPercent,
      subscriptionMaxDiscount: perks.maxDiscountAmount,
    });

    // The tier this booking would *land* the customer in, not the one they are
    // in now — the estimate is for a job that has not happened yet, and the
    // credit at completion is computed the same way.
    const tier = tierForCompletedBookings(
      completedBookings + 1,
      config.thresholds,
    );

    return {
      ...breakdown,
      // Only frozen onto the booking when the plan actually discounted it. A
      // subscription whose included-booking allowance is spent still gives the
      // coin multiplier, so the id is kept in that case too.
      subscriptionId: perks.subscriptionId,
      planName: perks.planName,
      coinBalance: balance,
      coinsEarnedEstimate: coinsEarnedFor({
        payableAmount: breakdown.payableAmount,
        earnRatePercent: config.earnRates[tier],
        multiplier: perks.coinEarnMultiplier,
        coinValueRupees: config.coinValueRupees,
      }),
    };
  }

  /**
   * Spend what the quote promised.
   *
   * Reads the amounts back off the booking rather than taking them as
   * arguments, so the debit can only ever match what was actually written —
   * there is no way for a caller to commit a different number from the one the
   * row and its CHECK constraints agreed on.
   *
   * **Throws** when the wallet cannot cover it. That is the one failure module
   * 4 has a recovery for, and swallowing it would leave a discounted booking
   * with no debit behind it.
   */
  async commit(bookingId: string): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        customerId: true,
        bookingNumber: true,
        coinsRedeemed: true,
        subscriptionId: true,
      },
    });
    if (!booking) return;

    if (booking.coinsRedeemed > 0) {
      await this.wallet.move({
        customerId: booking.customerId,
        type: 'redeem',
        coins: -booking.coinsRedeemed,
        reason: `${booking.coinsRedeemed} coins spent on booking ${booking.bookingNumber}`,
        sourceRef: walletSourceRef.redeem(booking.id),
        bookingId: booking.id,
      });
    }

    // Counted after the coins, so a booking whose debit failed does not also
    // burn one of the plan's included bookings. Never fatal on its own — a
    // miscounted allowance is worth a log, not a lost booking.
    if (booking.subscriptionId) {
      await this.subscriptions.recordBookingUse(booking.subscriptionId);
    }
  }

  /**
   * Cancellation: give the coins back and release the plan's booking slot.
   *
   * Idempotent by `redeem-reversal:<bookingId>`, so a support agent cancelling
   * twice returns the coins once.
   *
   * Deliberately **not** conditional on the cancellation fee. The fee is money
   * and the coins are an entitlement; retaining someone's coins on top of a
   * cash fee would charge them twice for one cancellation, and nothing in the
   * policy says to.
   */
  async release(bookingId: string): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        customerId: true,
        bookingNumber: true,
        coinsRedeemed: true,
        subscriptionId: true,
      },
    });
    if (!booking) return;

    if (booking.coinsRedeemed > 0) {
      // Only if the debit actually happened. A booking that was re-priced
      // because its debit failed still carries `coinsRedeemed = 0`, but one
      // cancelled mid-creation might not — and crediting coins that were never
      // spent is how a wallet mints itself.
      const debit = await this.prisma.walletTransaction.findUnique({
        where: { sourceRef: walletSourceRef.redeem(booking.id) },
      });

      if (debit) {
        await this.wallet.move({
          customerId: booking.customerId,
          type: 'redeem_reversal',
          coins: booking.coinsRedeemed,
          reason: `${booking.coinsRedeemed} coins returned — booking ${booking.bookingNumber} was cancelled`,
          sourceRef: walletSourceRef.redeemReversal(booking.id),
          bookingId: booking.id,
          // Expiry omitted, so the returned coins get the standard window from
          // today.
          //
          // The tempting alternative — carry the original credit's `expiresAt`
          // through — cannot be done from here and would be wrong if it could.
          // `debit` is the redemption, and a debit never carries an expiry;
          // the coins spent on this booking may have come from several credits
          // with different dates, and nothing records which. Reconstructing
          // that would mean tracking consumption credit by credit, which is a
          // FIFO lot ledger for a discount entitlement.
          //
          // What that concedes: booking and cancelling is a way to push an
          // expiring balance out by another window. It costs the customer a
          // booking they did not want and gains them nothing they did not
          // already own, so it is a cheap thing to leave open and an expensive
          // one to close.
        });
      }
    }

    if (booking.subscriptionId) {
      await this.subscriptions.releaseBookingUse(booking.subscriptionId);
    }
  }

  /**
   * A job finished: credit its coins, and settle any referral it qualifies.
   *
   * The two are independent — a referral reward is owed whether or not the
   * earn credit succeeded — so a failure in the first does not skip the
   * second.
   */
  async onBookingCompleted(bookingId: string): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        customerId: true,
        bookingNumber: true,
        payableAmount: true,
        subscriptionId: true,
      },
    });
    if (!booking) return;

    const results = await Promise.allSettled([
      this.wallet.creditForCompletedBooking({
        id: booking.id,
        customerId: booking.customerId,
        payableAmount: booking.payableAmount.toString(),
        bookingNumber: booking.bookingNumber,
        subscriptionId: booking.subscriptionId,
      }),
      this.referrals.onBookingCompleted({
        id: booking.id,
        customerId: booking.customerId,
        bookingNumber: booking.bookingNumber,
      }),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(
          `Loyalty settlement partly failed for booking ${booking.bookingNumber}.`,
          result.reason instanceof Error
            ? result.reason.stack
            : String(result.reason),
        );
      }
    }

    // Rethrown so module 4 logs it too and ops has one place to re-run from.
    // Both halves have already been attempted by this point — the throw
    // reports, it does not abort.
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error(
        `Loyalty settlement incomplete for booking ${booking.bookingNumber}`,
      );
    }
  }

  async perksFor(customerId: string): Promise<BookingPerks> {
    const perks = await this.subscriptions.perksFor(customerId);
    return {
      waivesCancellationFee: perks.waivesCancellationFee,
      extraReschedules: perks.extraReschedules,
      planName: perks.planName,
    };
  }
}
