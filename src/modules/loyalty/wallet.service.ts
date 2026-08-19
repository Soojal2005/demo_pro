import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import type {
  CustomerWallet,
  Prisma,
  WalletTransaction,
} from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import {
  LOYALTY_SETTINGS,
  TIER_SETTINGS,
  coinsEarnedFor,
  coinsToRupees,
  tierForCompletedBookings,
  walletSourceRef,
  type WalletTier,
  type WalletTxnType,
} from './loyalty.types';

/** What a caller must supply to move coins. */
export interface CoinMovement {
  customerId: string;
  type: WalletTxnType;
  /** **Signed.** Positive credits, negative debits. Never zero. */
  coins: number;
  /** Customer-facing — it is shown verbatim in the coin statement. */
  reason: string;
  /** Exactly-once key. Build it with `walletSourceRef`, never by hand. */
  sourceRef: string;

  bookingId?: string | null;
  referralId?: string | null;
  subscriptionId?: string | null;
  adjustedByAdminId?: string | null;
  /** Overrides the configured expiry. Credits only. */
  expiresAt?: Date | null;
}

export interface WalletSummary {
  balanceCoins: number;
  balanceValue: string;
  tier: WalletTier;
  nextTier: WalletTier | null;
  bookingsToNextTier: number | null;
  earnRatePercent: number;
  completedBookings: number;
  lifetimeEarnedCoins: number;
  lifetimeRedeemedCoins: number;
  coinValueRupees: string;
  maxRedemptionPercent: number;
  /** Coins that lapse inside the next 30 days, so the app can nudge. */
  expiringSoonCoins: number;
}

/**
 * Homingo Coins.
 *
 * One public write method — {@link move} — and it is the only place in the
 * codebase that inserts into `wallet_transactions` or touches
 * `CustomerWallet.balanceCoins`. The shape is lifted directly from
 * `LedgerService.append`, because the problem is the same one: several
 * unrelated callers, every one of them retryable, all appending to a running
 * total that must never double-count.
 *
 * Two differences from the ledger, both deliberate:
 *
 * - **No hash chain.** Coins are a discount entitlement, not currency. Nothing
 *   reconciles them against Razorpay, and a chain would make every coin grant
 *   a finance event with a nightly verification cost.
 * - **The lock is per customer, not global.** The ledger serialises platform
 *   wide because its chain is global; a wallet balance is one row, so
 *   `SELECT … FOR UPDATE` on that row is both sufficient and far cheaper.
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
  ) {}

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  /**
   * The wallet screen: balance, what it is worth, the tier, and how far the
   * next one is.
   *
   * Answers "why am I earning 5%" without the customer having to ask support,
   * which is the whole reason the tier is surfaced rather than applied
   * silently.
   */
  async summarise(customerId: string): Promise<WalletSummary> {
    const [wallet, completedBookings, config] = await Promise.all([
      this.prisma.customerWallet.findUnique({ where: { customerId } }),
      this.countCompletedBookings(customerId),
      this.readConfig(),
    ]);

    const tier = tierForCompletedBookings(completedBookings, config.thresholds);
    const next = this.nextTierAfter(tier);

    const balanceCoins = wallet?.balanceCoins ?? 0;

    const expiringSoonCoins = await this.sumExpiringWithin(customerId, 30);

    return {
      balanceCoins,
      balanceValue: coinsToRupees(balanceCoins, config.coinValueRupees),
      tier,
      nextTier: next,
      bookingsToNextTier: next
        ? Math.max(0, config.thresholds[next] - completedBookings)
        : null,
      earnRatePercent: config.earnRates[tier],
      completedBookings,
      lifetimeEarnedCoins: wallet?.lifetimeEarnedCoins ?? 0,
      lifetimeRedeemedCoins: wallet?.lifetimeRedeemedCoins ?? 0,
      coinValueRupees: config.coinValueRupees.toFixed(2),
      maxRedemptionPercent: config.maxRedemptionPercent,
      expiringSoonCoins,
    };
  }

  /** The statement. Paged, newest first. */
  async listTransactions(
    customerId: string,
    limit = 50,
    cursor?: string,
  ): Promise<{ items: WalletTransaction[]; nextCursor: string | null }> {
    const take = Math.min(Math.max(limit, 1), 100);

    const items = await this.prisma.walletTransaction.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    return {
      items: hasMore ? items.slice(0, take) : items,
      nextCursor: hasMore ? items[take - 1].id : null,
    };
  }

  /** The balance alone — what the booking quote needs and nothing more. */
  async getBalance(customerId: string): Promise<number> {
    const wallet = await this.prisma.customerWallet.findUnique({
      where: { customerId },
      select: { balanceCoins: true },
    });
    return wallet?.balanceCoins ?? 0;
  }

  // ------------------------------------------------------------------
  // The one write
  // ------------------------------------------------------------------

  /**
   * Move coins, once.
   *
   * Returns the existing row when `sourceRef` has already been written rather
   * than throwing — every caller is a retryable path, and for all of them
   * "it is already recorded" is success. Same decision, and the same reasoning,
   * as `LedgerService.append`.
   *
   * Throws only when a **debit** would overdraw. That is a real conflict a
   * caller has to handle: it means the customer spent the coins somewhere else
   * between the quote and the commit.
   */
  async move(input: CoinMovement): Promise<WalletTransaction> {
    if (!Number.isInteger(input.coins) || input.coins === 0) {
      // Not an apiError: reaching here means our own code tried to move a
      // fraction of a coin or nothing at all, which is a bug rather than
      // something a client did.
      throw new Error(
        `Refusing a wallet movement of ${input.coins} coins (${input.sourceRef})`,
      );
    }

    const existing = await this.prisma.walletTransaction.findUnique({
      where: { sourceRef: input.sourceRef },
    });
    if (existing) return existing;

    const coinValueRupees = await this.settings.getNumber(
      LOYALTY_SETTINGS.coinValueRupees.key,
      LOYALTY_SETTINGS.coinValueRupees.fallback,
    );
    const expiresAt =
      input.expiresAt !== undefined
        ? input.expiresAt
        : input.coins > 0
          ? await this.defaultExpiry()
          : null;

    return this.prisma.$transaction(async (tx) => {
      const wallet = await this.lockWallet(tx, input.customerId);

      // Re-read inside the lock. The check above keeps the common repeat off
      // the lock entirely; this is the one that counts.
      const raced = await tx.walletTransaction.findUnique({
        where: { sourceRef: input.sourceRef },
      });
      if (raced) return raced;

      const balanceAfter = wallet.balanceCoins + input.coins;
      if (balanceAfter < 0) {
        throw apiError(
          'You do not have enough Homingo Coins for this',
          HttpStatus.CONFLICT,
          [
            {
              field: 'coins',
              message: `Balance is ${wallet.balanceCoins}, tried to spend ${Math.abs(input.coins)}`,
              code: 'INSUFFICIENT_COIN_BALANCE',
            },
          ],
        );
      }

      const created = await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          customerId: input.customerId,
          type: input.type,
          coins: input.coins,
          balanceAfter,
          rupeeValue: coinsToRupees(Math.abs(input.coins), coinValueRupees),
          bookingId: input.bookingId ?? null,
          referralId: input.referralId ?? null,
          subscriptionId: input.subscriptionId ?? null,
          adjustedByAdminId: input.adjustedByAdminId ?? null,
          reason: input.reason,
          sourceRef: input.sourceRef,
          expiresAt: input.coins > 0 ? expiresAt : null,
        },
      });

      await tx.customerWallet.update({
        where: { id: wallet.id },
        data: {
          balanceCoins: balanceAfter,
          // Lifetime totals are never decremented — a customer who spends
          // their balance must not fall back down a tier.
          ...(input.coins > 0
            ? { lifetimeEarnedCoins: { increment: input.coins } }
            : {}),
          ...(input.coins < 0 && input.type === 'redeem'
            ? { lifetimeRedeemedCoins: { increment: -input.coins } }
            : {}),
          ...(input.coins < 0 && input.type === 'expire'
            ? { lifetimeExpiredCoins: { increment: -input.coins } }
            : {}),
        },
      });

      return created;
    });
  }

  // ------------------------------------------------------------------
  // Earning
  // ------------------------------------------------------------------

  /**
   * Credit the coins a completed booking earned.
   *
   * Called from module 4's completion path through `LOYALTY_PORT`, and
   * idempotent by `sourceRef` — the port's contract requires that, because the
   * sweeper on the other side re-runs anything that failed.
   *
   * The tier is computed from the count of completed bookings **including this
   * one**, so the job that takes a customer to silver earns at the silver rate.
   * Rewarding the fifth booking at the fourth booking's rate is the kind of
   * detail that generates support tickets.
   */
  async creditForCompletedBooking(booking: {
    id: string;
    customerId: string;
    payableAmount: string;
    bookingNumber: string;
    subscriptionId: string | null;
  }): Promise<WalletTransaction | null> {
    const [completedBookings, config, multiplier] = await Promise.all([
      this.countCompletedBookings(booking.customerId),
      this.readConfig(),
      this.earnMultiplierFor(booking.subscriptionId),
    ]);

    const tier = tierForCompletedBookings(completedBookings, config.thresholds);
    const coins = coinsEarnedFor({
      payableAmount: booking.payableAmount,
      earnRatePercent: config.earnRates[tier],
      multiplier,
      coinValueRupees: config.coinValueRupees,
    });

    if (coins <= 0) {
      // A ₹49 job at 3% is worth less than one coin. Not an error, and not
      // worth a zero row the customer would have to read past.
      return null;
    }

    const moved = await this.move({
      customerId: booking.customerId,
      type: 'earn',
      coins,
      reason:
        multiplier > 1
          ? `${coins} coins for booking ${booking.bookingNumber} — ${config.earnRates[tier]}% ${tier} rate, ${multiplier}× subscriber bonus`
          : `${coins} coins for booking ${booking.bookingNumber} — ${config.earnRates[tier]}% ${tier} rate`,
      sourceRef: walletSourceRef.earn(booking.id),
      bookingId: booking.id,
      subscriptionId: booking.subscriptionId,
    });

    // Cached on the wallet purely so a receipt can say why the customer got
    // the coins they did. Never read back as the source of truth.
    await this.prisma.customerWallet.updateMany({
      where: { customerId: booking.customerId },
      data: { tier },
    });

    return moved;
  }

  // ------------------------------------------------------------------
  // Expiry
  // ------------------------------------------------------------------

  /**
   * Expire credits that have passed `expiresAt`.
   *
   * **Credit-by-credit, not balance-by-balance.** A customer with 300 coins of
   * which 100 have lapsed loses 100, and the sweep writes one debit naming the
   * grant that lapsed — so the statement explains the loss instead of showing
   * a balance that fell for no visible reason.
   *
   * Clamped to what the customer actually still holds: coins already spent
   * cannot lapse a second time.
   */
  async expireLapsedCoins(
    now = new Date(),
    batchSize = 500,
  ): Promise<{
    expired: number;
    coins: number;
  }> {
    const due = await this.prisma.walletTransaction.findMany({
      where: { expiredAt: null, expiresAt: { not: null, lte: now } },
      orderBy: { expiresAt: 'asc' },
      take: batchSize,
    });

    let expired = 0;
    let coins = 0;

    for (const credit of due) {
      try {
        const balance = await this.getBalance(credit.customerId);
        const amount = Math.min(credit.coins, balance);

        if (amount > 0) {
          await this.move({
            customerId: credit.customerId,
            type: 'expire',
            coins: -amount,
            reason: `${amount} coins expired — earned ${credit.createdAt.toISOString().slice(0, 10)}`,
            sourceRef: walletSourceRef.expiry(credit.id),
          });
          coins += amount;
        }

        // Marked regardless of whether anything was debited: a credit the
        // customer already spent is still done expiring, and leaving it unset
        // would make the sweep revisit it forever.
        await this.prisma.walletTransaction.update({
          where: { id: credit.id },
          data: { expiredAt: now },
        });
        expired += 1;
      } catch (error) {
        this.logger.error(
          `Could not expire wallet credit ${credit.id}; the next sweep will retry.`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return { expired, coins };
  }

  // ------------------------------------------------------------------
  // Ops
  // ------------------------------------------------------------------

  /**
   * A manual credit or debit, with a name against it.
   *
   * The only movement in this module with a human behind it, which is why the
   * database refuses an `adjustment` row with no `adjustedByAdminId`. Support
   * uses it to make good on a botched job; nothing else should.
   */
  adjust(input: {
    customerId: string;
    coins: number;
    reason: string;
    adminId: string;
    adjustmentId: string;
  }): Promise<WalletTransaction> {
    return this.move({
      customerId: input.customerId,
      type: 'adjustment',
      coins: input.coins,
      reason: input.reason,
      sourceRef: walletSourceRef.adjustment(input.adjustmentId),
      adjustedByAdminId: input.adminId,
      // Goodwill does not lapse. An adjustment is usually an apology, and an
      // apology with a 12-month fuse on it is a second complaint waiting.
      expiresAt: null,
    });
  }

  /**
   * Recompute one wallet from its own log.
   *
   * The counterpart to every other counter in this schema: incremented on
   * write, rebuilt nightly from source, **source wins**. The log is the source.
   */
  async rebuildBalance(customerId: string): Promise<{
    before: number;
    after: number;
    drifted: boolean;
  }> {
    const wallet = await this.prisma.customerWallet.findUnique({
      where: { customerId },
    });
    if (!wallet) return { before: 0, after: 0, drifted: false };

    const [sum, credits, redeemed, expired] = await Promise.all([
      this.prisma.walletTransaction.aggregate({
        where: { customerId },
        _sum: { coins: true },
      }),
      this.prisma.walletTransaction.aggregate({
        where: { customerId, coins: { gt: 0 } },
        _sum: { coins: true },
      }),
      this.prisma.walletTransaction.aggregate({
        where: { customerId, type: 'redeem' },
        _sum: { coins: true },
      }),
      this.prisma.walletTransaction.aggregate({
        where: { customerId, type: 'expire' },
        _sum: { coins: true },
      }),
    ]);

    const after = sum._sum.coins ?? 0;
    const before = wallet.balanceCoins;

    if (before !== after) {
      this.logger.warn(
        `Wallet ${wallet.id} drifted: cached ${before}, log says ${after}. Taking the log.`,
      );
    }

    await this.prisma.customerWallet.update({
      where: { id: wallet.id },
      data: {
        balanceCoins: after,
        lifetimeEarnedCoins: credits._sum.coins ?? 0,
        lifetimeRedeemedCoins: -(redeemed._sum.coins ?? 0),
        lifetimeExpiredCoins: -(expired._sum.coins ?? 0),
      },
    });

    return { before, after, drifted: before !== after };
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Take the wallet row, creating it if this is the customer's first movement.
   *
   * `FOR UPDATE` rather than an optimistic read: two concurrent credits on one
   * wallet would otherwise both read the same balance and write the same
   * `balanceAfter`, losing one of them. It is a single-row lock held for the
   * length of one insert and one update.
   */
  private async lockWallet(
    tx: Prisma.TransactionClient,
    customerId: string,
  ): Promise<CustomerWallet> {
    const locked = await tx.$queryRaw<
      Array<{ id: string; balanceCoins: number }>
    >`SELECT "id", "balanceCoins" FROM "customer_wallets" WHERE "customerId" = ${customerId}::uuid FOR UPDATE`;

    if (locked.length > 0) {
      return {
        id: locked[0].id,
        balanceCoins: locked[0].balanceCoins,
      } as CustomerWallet;
    }

    // Created lazily: a guest who has never completed a job does not need a
    // row, and creating one at signup would put an empty wallet against every
    // abandoned device id. `upsert` rather than `create` because two first
    // movements can race here as easily as anywhere else.
    const created = await tx.customerWallet.upsert({
      where: { customerId },
      create: { customerId },
      update: {},
    });

    // Re-take it under the lock the same way, so the caller's arithmetic runs
    // against a row nobody else can move.
    const relocked = await tx.$queryRaw<
      Array<{ id: string; balanceCoins: number }>
    >`SELECT "id", "balanceCoins" FROM "customer_wallets" WHERE "id" = ${created.id}::uuid FOR UPDATE`;

    return {
      id: relocked[0].id,
      balanceCoins: relocked[0].balanceCoins,
    } as CustomerWallet;
  }

  private countCompletedBookings(customerId: string): Promise<number> {
    // Served by the existing `bookings(customerId, status)` index.
    return this.prisma.booking.count({
      where: { customerId, status: 'completed' },
    });
  }

  private async sumExpiringWithin(
    customerId: string,
    days: number,
  ): Promise<number> {
    const horizon = new Date(Date.now() + days * 86_400_000);
    const result = await this.prisma.walletTransaction.aggregate({
      where: {
        customerId,
        expiredAt: null,
        expiresAt: { not: null, lte: horizon },
      },
      _sum: { coins: true },
    });

    // Clamped to the live balance: a lapsing credit the customer already spent
    // is not coins they are about to lose.
    const lapsing = result._sum.coins ?? 0;
    const balance = await this.getBalance(customerId);
    return Math.min(Math.max(lapsing, 0), balance);
  }

  private async defaultExpiry(): Promise<Date | null> {
    const days = await this.settings.getNumber(
      LOYALTY_SETTINGS.coinExpiryDays.key,
      LOYALTY_SETTINGS.coinExpiryDays.fallback,
    );
    if (days <= 0) return null;
    return new Date(Date.now() + days * 86_400_000);
  }

  private async earnMultiplierFor(
    subscriptionId: string | null,
  ): Promise<number> {
    if (!subscriptionId) return 1;
    const subscription = await this.prisma.customerSubscription.findUnique({
      where: { id: subscriptionId },
      select: { coinEarnMultiplier: true },
    });
    const multiplier = Number(subscription?.coinEarnMultiplier ?? 1);
    return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  }

  private nextTierAfter(
    tier: WalletTier,
  ): Exclude<WalletTier, 'bronze'> | null {
    if (tier === 'bronze') return 'silver';
    if (tier === 'silver') return 'gold';
    if (tier === 'gold') return 'platinum';
    return null;
  }

  /** One read of every tunable this module's arithmetic needs. */
  async readConfig(): Promise<{
    coinValueRupees: number;
    maxRedemptionPercent: number;
    earnRates: Record<WalletTier, number>;
    thresholds: Record<Exclude<WalletTier, 'bronze'>, number>;
  }> {
    const [
      coinValueRupees,
      maxRedemptionPercent,
      bronze,
      silver,
      gold,
      platinum,
      silverAt,
      goldAt,
      platinumAt,
    ] = await Promise.all([
      this.settings.getNumber(
        LOYALTY_SETTINGS.coinValueRupees.key,
        LOYALTY_SETTINGS.coinValueRupees.fallback,
      ),
      this.settings.getNumber(
        LOYALTY_SETTINGS.maxRedemptionPercent.key,
        LOYALTY_SETTINGS.maxRedemptionPercent.fallback,
      ),
      this.settings.getNumber(
        TIER_SETTINGS.bronze.rateKey,
        TIER_SETTINGS.bronze.rateFallback,
      ),
      this.settings.getNumber(
        TIER_SETTINGS.silver.rateKey,
        TIER_SETTINGS.silver.rateFallback,
      ),
      this.settings.getNumber(
        TIER_SETTINGS.gold.rateKey,
        TIER_SETTINGS.gold.rateFallback,
      ),
      this.settings.getNumber(
        TIER_SETTINGS.platinum.rateKey,
        TIER_SETTINGS.platinum.rateFallback,
      ),
      this.settings.getNumber(
        TIER_SETTINGS.silver.thresholdKey as string,
        TIER_SETTINGS.silver.thresholdFallback,
      ),
      this.settings.getNumber(
        TIER_SETTINGS.gold.thresholdKey as string,
        TIER_SETTINGS.gold.thresholdFallback,
      ),
      this.settings.getNumber(
        TIER_SETTINGS.platinum.thresholdKey as string,
        TIER_SETTINGS.platinum.thresholdFallback,
      ),
    ]);

    return {
      coinValueRupees,
      maxRedemptionPercent,
      earnRates: { bronze, silver, gold, platinum },
      thresholds: { silver: silverAt, gold: goldAt, platinum: platinumAt },
    };
  }
}
