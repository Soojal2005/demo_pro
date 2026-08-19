import { randomInt } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { apiError } from '../../common/utils';
import { Prisma } from '../../prisma/client';
import type { Referral, ReferralCode } from '../../prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../bookings/platform-settings.service';
import {
  LOYALTY_SETTINGS,
  REFERRAL_CODE_ALPHABET,
  isWellFormedReferralCode,
  normaliseReferralCode,
  walletSourceRef,
} from './loyalty.types';
import { WalletService } from './wallet.service';

export interface ReferralSummary {
  code: string;
  shareMessage: string;
  referrerCoins: number;
  refereeCoins: number;
  qualifyWindowDays: number;
  totalReferrals: number;
  qualifiedCount: number;
  totalCoinsEarned: number;
  pendingCount: number;
  isBlocked: boolean;
}

/**
 * Refer & Earn.
 *
 * The rule the whole design turns on: **the reward is paid when the referee's
 * first booking completes, not when they sign up.** A signup costs an attacker
 * a spare phone number; a completed job costs them a real payment at a real
 * address that a real Pro visited. Everything else here — the unique index on
 * `refereeId`, the self-referral CHECK, the per-referrer cap, the qualifying
 * window — exists to keep that one rule from being routed around.
 */
@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly settings: PlatformSettingsService,
  ) {}

  // ------------------------------------------------------------------
  // The code
  // ------------------------------------------------------------------

  /**
   * This customer's code, minting one on first ask.
   *
   * Lazily, like the wallet row: most customers never open the refer screen,
   * and a code per abandoned device id is a unique index full of noise.
   */
  async getOrCreateCode(customerId: string): Promise<ReferralCode> {
    const existing = await this.prisma.referralCode.findUnique({
      where: { customerId },
    });
    if (existing) return existing;

    // Retry on collision rather than pre-checking. At six characters from a
    // 31-letter alphabet the space is ~887 million, so a collision is rare
    // enough that the unique index is a better detector than a lookup that
    // races anyway. Same shape as `createWithUniqueBookingNumber`.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await this.prisma.referralCode.create({
          data: { customerId, code: this.generateCode() },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          // Could be the code, or could be a concurrent first ask from the
          // same customer — in which case theirs is now there to return.
          const raced = await this.prisma.referralCode.findUnique({
            where: { customerId },
          });
          if (raced) return raced;
          continue;
        }
        throw error;
      }
    }

    throw apiError(
      'Could not create a referral code — please try again',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  /** The refer & earn screen. */
  async summarise(customerId: string): Promise<ReferralSummary> {
    const [code, config, pendingCount] = await Promise.all([
      this.getOrCreateCode(customerId),
      this.readConfig(),
      this.prisma.referral.count({
        where: { referrerId: customerId, status: 'pending' },
      }),
    ]);

    return {
      code: code.code,
      shareMessage:
        `Get ₹${config.refereeCoins} off your first Homingo booking — ` +
        `use my code ${code.code} when you sign up.`,
      referrerCoins: config.referrerCoins,
      refereeCoins: config.refereeCoins,
      qualifyWindowDays: config.qualifyWindowDays,
      totalReferrals: code.totalReferrals,
      qualifiedCount: code.qualifiedCount,
      totalCoinsEarned: code.totalCoinsEarned,
      pendingCount,
      isBlocked: code.isBlocked,
    };
  }

  // ------------------------------------------------------------------
  // Attribution
  // ------------------------------------------------------------------

  /**
   * A new customer enters someone's code.
   *
   * Everything that can be refused is refused **here**, at attribution, rather
   * than at reward time: telling somebody their code was no good after they
   * have completed a booking and expected coins is a support ticket, and
   * telling them at the moment they type it is a validation message.
   *
   * The one exception is the referee having already booked — that is checked
   * here too, because a customer who is already a customer was not referred.
   */
  async attribute(refereeId: string, rawCode: string): Promise<Referral> {
    const code = normaliseReferralCode(rawCode);

    if (!isWellFormedReferralCode(code)) {
      throw apiError(
        'That referral code is not valid',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'code',
            message: 'Codes are 6–12 letters and digits',
            code: 'REFERRAL_CODE_MALFORMED',
          },
        ],
      );
    }

    const existing = await this.prisma.referral.findUnique({
      where: { refereeId },
    });
    if (existing) {
      throw apiError(
        'You have already used a referral code',
        HttpStatus.CONFLICT,
        [
          {
            field: 'code',
            message: 'A customer can be referred once, ever',
            code: 'ALREADY_REFERRED',
          },
        ],
      );
    }

    const owner = await this.prisma.referralCode.findUnique({
      where: { code },
    });
    if (!owner) {
      throw apiError('We do not recognise that code', HttpStatus.NOT_FOUND, [
        {
          field: 'code',
          message: 'No customer owns this code',
          code: 'REFERRAL_CODE_UNKNOWN',
        },
      ]);
    }

    if (owner.customerId === refereeId) {
      throw apiError(
        'You cannot refer yourself',
        HttpStatus.UNPROCESSABLE_ENTITY,
        [
          {
            field: 'code',
            message: 'This is your own code',
            code: 'SELF_REFERRAL',
          },
        ],
      );
    }

    if (owner.isBlocked) {
      // Deliberately vague to the referee, who has done nothing wrong and is
      // not owed an explanation of somebody else's account standing.
      throw apiError(
        'This code cannot be used at the moment',
        HttpStatus.CONFLICT,
        [
          {
            field: 'code',
            message: 'Referral code is blocked',
            code: 'REFERRAL_CODE_BLOCKED',
          },
        ],
      );
    }

    const config = await this.readConfig();

    if (owner.qualifiedCount >= config.maxPerReferrer) {
      throw apiError(
        'This code has reached its referral limit',
        HttpStatus.CONFLICT,
        [
          {
            field: 'code',
            message: `Cap is ${config.maxPerReferrer} rewarded referrals`,
            code: 'REFERRAL_CAP_REACHED',
          },
        ],
      );
    }

    // A customer who has already had work done was not referred to us — they
    // were already here. Checked against completed jobs rather than any
    // booking, so a cancelled first attempt does not cost someone their code.
    const priorJobs = await this.prisma.booking.count({
      where: { customerId: refereeId, status: 'completed' },
    });
    if (priorJobs > 0) {
      throw apiError(
        'Referral codes are for new customers only',
        HttpStatus.CONFLICT,
        [
          {
            field: 'code',
            message: 'This account has already completed a booking',
            code: 'REFEREE_NOT_NEW',
          },
        ],
      );
    }

    try {
      const referral = await this.prisma.referral.create({
        data: {
          referrerId: owner.customerId,
          refereeId,
          code,
          status: 'pending',
          // Frozen at attribution: a settings change must not alter what a
          // pending referral was promised.
          referrerCoins: config.referrerCoins,
          refereeCoins: config.refereeCoins,
          expiresAt: new Date(
            Date.now() + config.qualifyWindowDays * 86_400_000,
          ),
        },
      });

      await this.prisma.referralCode.update({
        where: { id: owner.id },
        data: { totalReferrals: { increment: 1 } },
      });

      return referral;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw apiError(
          'You have already used a referral code',
          HttpStatus.CONFLICT,
          [
            {
              field: 'code',
              message: 'A customer can be referred once, ever',
              code: 'ALREADY_REFERRED',
            },
          ],
        );
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------
  // Qualification and reward
  // ------------------------------------------------------------------

  /**
   * A booking completed — pay the referral it qualifies, if it qualifies one.
   *
   * Called from module 4's completion path through `LOYALTY_PORT`. Does
   * nothing at all for the overwhelming majority of bookings, which is why the
   * first query is a single indexed lookup on a unique column.
   *
   * Idempotent three times over: `Referral.status` moves off `pending` once,
   * `qualifyingBookingId` is unique, and both coin credits carry a `sourceRef`
   * derived from the referral id.
   */
  async onBookingCompleted(booking: {
    id: string;
    customerId: string;
    bookingNumber: string;
  }): Promise<Referral | null> {
    const referral = await this.prisma.referral.findUnique({
      where: { refereeId: booking.customerId },
    });

    if (!referral || referral.status !== 'pending') return null;

    if (referral.expiresAt && referral.expiresAt <= new Date()) {
      await this.prisma.referral.update({
        where: { id: referral.id },
        data: { status: 'expired' },
      });
      return null;
    }

    const now = new Date();
    let qualified: Referral;
    try {
      qualified = await this.prisma.referral.update({
        where: { id: referral.id, status: 'pending' },
        data: {
          status: 'qualified',
          qualifiedAt: now,
          qualifyingBookingId: booking.id,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2025' || error.code === 'P2002')
      ) {
        // Another completion won the race, or this one is a retry. Either way
        // the referral is already accounted for.
        return null;
      }
      throw error;
    }

    return this.payOut(qualified, booking.bookingNumber);
  }

  /**
   * Credit both sides and mark the referral rewarded.
   *
   * The two credits are separate movements with separate `sourceRef`s, so a
   * failure after the first does not have to be undone — a retry credits only
   * the side that is missing. The status only moves to `rewarded` once both
   * have landed, which is what makes the retry safe to run blind.
   */
  private async payOut(
    referral: Referral,
    bookingNumber: string,
  ): Promise<Referral> {
    try {
      if (referral.referrerCoins > 0) {
        await this.wallet.move({
          customerId: referral.referrerId,
          type: 'referral',
          coins: referral.referrerCoins,
          reason: `${referral.referrerCoins} coins — someone you referred completed their first booking`,
          sourceRef: walletSourceRef.referrerReward(referral.id),
          referralId: referral.id,
        });
      }

      if (referral.refereeCoins > 0) {
        await this.wallet.move({
          customerId: referral.refereeId,
          type: 'referral',
          coins: referral.refereeCoins,
          reason: `${referral.refereeCoins} welcome coins for using code ${referral.code} — booking ${bookingNumber}`,
          sourceRef: walletSourceRef.refereeReward(referral.id),
          referralId: referral.id,
        });
      }
    } catch (error) {
      // Left `qualified`. The nightly sweep finds it and tries again — the
      // referral is genuinely earned, and the customer is owed it whether or
      // not the credit landed on the first attempt.
      this.logger.error(
        `Referral ${referral.id} qualified but its coins did not credit; the sweep will retry.`,
        error instanceof Error ? error.stack : String(error),
      );
      return referral;
    }

    const rewarded = await this.prisma.referral.update({
      where: { id: referral.id },
      data: { status: 'rewarded', rewardedAt: new Date() },
    });

    await this.prisma.referralCode
      .update({
        where: { customerId: referral.referrerId },
        data: {
          qualifiedCount: { increment: 1 },
          totalCoinsEarned: { increment: referral.referrerCoins },
        },
      })
      .catch((error: unknown) => {
        // Counters are derived data, rebuilt from `Referral` by the nightly
        // job. Source wins, so this is a log and not a failure.
        this.logger.warn(
          `Referral counters for ${referral.referrerId} did not increment: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

    return rewarded;
  }

  /**
   * The sweep: retry qualified-but-unpaid referrals, and expire the ones whose
   * window closed without a booking.
   *
   * Both halves exist because the alternative to each is a customer quietly
   * not getting something they were told they would get.
   */
  async sweep(now = new Date()): Promise<{ paid: number; expired: number }> {
    const stuck = await this.prisma.referral.findMany({
      where: { status: 'qualified' },
      take: 200,
      include: {
        qualifyingBooking: { select: { bookingNumber: true } },
      },
    });

    let paid = 0;
    for (const referral of stuck) {
      try {
        const result = await this.payOut(
          referral,
          referral.qualifyingBooking?.bookingNumber ?? 'their first booking',
        );
        if (result.status === 'rewarded') paid += 1;
      } catch (error) {
        this.logger.error(
          `Referral ${referral.id} still could not be paid.`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    const expired = await this.prisma.referral.updateMany({
      where: { status: 'pending', expiresAt: { lte: now } },
      data: { status: 'expired' },
    });

    return { paid, expired: expired.count };
  }

  // ------------------------------------------------------------------
  // Reads and ops
  // ------------------------------------------------------------------

  listForReferrer(customerId: string): Promise<Referral[]> {
    return this.prisma.referral.findMany({
      where: { referrerId: customerId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /** What the referee sees — at most one row, by construction. */
  findForReferee(customerId: string): Promise<Referral | null> {
    return this.prisma.referral.findUnique({
      where: { refereeId: customerId },
    });
  }

  /**
   * The abuse brake. Blocks one account's code without disabling the feature,
   * and without touching referrals already earned — a reward that was fairly
   * won is not clawed back by a later suspicion.
   */
  async setCodeBlocked(
    customerId: string,
    isBlocked: boolean,
    reason: string | null,
  ): Promise<ReferralCode> {
    const code = await this.getOrCreateCode(customerId);
    return this.prisma.referralCode.update({
      where: { id: code.id },
      data: { isBlocked, blockedReason: isBlocked ? reason : null },
    });
  }

  /** Ops rejects a pending referral outright — a duplicate account, say. */
  async reject(referralId: string, reason: string): Promise<Referral> {
    const referral = await this.prisma.referral.findUnique({
      where: { id: referralId },
    });
    if (!referral) throw apiError('Referral not found', HttpStatus.NOT_FOUND);

    if (referral.status === 'rewarded') {
      throw apiError(
        'This referral has already been paid',
        HttpStatus.CONFLICT,
        [
          {
            field: 'status',
            message:
              'Coins already credited. Reverse them with a wallet adjustment instead.',
            code: 'REFERRAL_ALREADY_REWARDED',
          },
        ],
      );
    }

    return this.prisma.referral.update({
      where: { id: referralId },
      data: { status: 'rejected', rejectedReason: reason },
    });
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * Six characters from an alphabet with no `0/O` and no `1/I/L`.
   *
   * `randomInt` from `node:crypto`, not `Math.random`: a predictable code is
   * one an attacker can enumerate to attribute referrals to strangers.
   */
  private generateCode(): string {
    let code = '';
    for (let index = 0; index < 6; index += 1) {
      code += REFERRAL_CODE_ALPHABET[randomInt(REFERRAL_CODE_ALPHABET.length)];
    }
    return code;
  }

  private async readConfig(): Promise<{
    referrerCoins: number;
    refereeCoins: number;
    qualifyWindowDays: number;
    maxPerReferrer: number;
  }> {
    const [referrerCoins, refereeCoins, qualifyWindowDays, maxPerReferrer] =
      await Promise.all([
        this.settings.getNumber(
          LOYALTY_SETTINGS.referrerCoins.key,
          LOYALTY_SETTINGS.referrerCoins.fallback,
        ),
        this.settings.getNumber(
          LOYALTY_SETTINGS.refereeCoins.key,
          LOYALTY_SETTINGS.refereeCoins.fallback,
        ),
        this.settings.getNumber(
          LOYALTY_SETTINGS.qualifyWindowDays.key,
          LOYALTY_SETTINGS.qualifyWindowDays.fallback,
        ),
        this.settings.getNumber(
          LOYALTY_SETTINGS.maxPerReferrer.key,
          LOYALTY_SETTINGS.maxPerReferrer.fallback,
        ),
      ]);

    return {
      referrerCoins: Math.max(0, Math.floor(referrerCoins)),
      refereeCoins: Math.max(0, Math.floor(refereeCoins)),
      qualifyWindowDays: Math.max(1, Math.floor(qualifyWindowDays)),
      maxPerReferrer: Math.max(0, Math.floor(maxPerReferrer)),
    };
  }
}
