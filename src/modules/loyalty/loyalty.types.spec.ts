import {
  coinsEarnedFor,
  coinsToRupees,
  computeDiscounts,
  isWellFormedReferralCode,
  normaliseReferralCode,
  tierForCompletedBookings,
  walletSourceRef,
} from './loyalty.types';

const THRESHOLDS = { silver: 5, gold: 15, platinum: 40 };

describe('the tier ladder', () => {
  it('is the last threshold the customer has passed', () => {
    expect(tierForCompletedBookings(0, THRESHOLDS)).toBe('bronze');
    expect(tierForCompletedBookings(4, THRESHOLDS)).toBe('bronze');
    expect(tierForCompletedBookings(5, THRESHOLDS)).toBe('silver');
    expect(tierForCompletedBookings(14, THRESHOLDS)).toBe('silver');
    expect(tierForCompletedBookings(15, THRESHOLDS)).toBe('gold');
    expect(tierForCompletedBookings(39, THRESHOLDS)).toBe('gold');
    expect(tierForCompletedBookings(40, THRESHOLDS)).toBe('platinum');
    expect(tierForCompletedBookings(4000, THRESHOLDS)).toBe('platinum');
  });

  it('promotes exactly at the threshold, not one job later', () => {
    // The off-by-one that generates support tickets: a customer told "5
    // bookings for silver" who is still bronze on their fifth.
    expect(tierForCompletedBookings(THRESHOLDS.silver, THRESHOLDS)).toBe(
      'silver',
    );
  });
});

describe('earning coins', () => {
  const base = { earnRatePercent: 5, multiplier: 1, coinValueRupees: 1 };

  it('returns the configured percentage of what was actually paid', () => {
    expect(coinsEarnedFor({ ...base, payableAmount: '500.00' })).toBe(25);
  });

  it('multiplies for a subscriber', () => {
    expect(
      coinsEarnedFor({ ...base, payableAmount: '500.00', multiplier: 2 }),
    ).toBe(50);
  });

  it('rounds down — the platform never grants a coin it did not intend to', () => {
    // 5% of ₹499 is ₹24.95, which is 24 whole coins.
    expect(coinsEarnedFor({ ...base, payableAmount: '499.00' })).toBe(24);
  });

  it('earns nothing on a job too small to be worth a coin', () => {
    // 5% of ₹19 is ₹0.95. A zero-coin row is not worth making the customer
    // read past.
    expect(coinsEarnedFor({ ...base, payableAmount: '19.00' })).toBe(0);
  });

  it('earns nothing on a booking a discount took to zero', () => {
    expect(coinsEarnedFor({ ...base, payableAmount: '0.00' })).toBe(0);
  });

  it('scales with the coin value, so a rate change is a settings change', () => {
    // At ₹2 a coin, the same 5% of ₹500 buys half as many coins.
    expect(
      coinsEarnedFor({ ...base, payableAmount: '500.00', coinValueRupees: 2 }),
    ).toBe(12);
  });

  it('survives a nonsense multiplier without minting anything', () => {
    expect(
      coinsEarnedFor({ ...base, payableAmount: '500.00', multiplier: 0 }),
    ).toBe(0);
  });

  it('does not lose paise to floating point', () => {
    // 3% of ₹1234.56 is ₹37.0368 → 37 coins. Computed on the decimal string,
    // never on a float, for the reason payments.money.ts states at length.
    expect(
      coinsEarnedFor({
        payableAmount: '1234.56',
        earnRatePercent: 3,
        multiplier: 1,
        coinValueRupees: 1,
      }),
    ).toBe(37);
  });
});

describe('what coins are worth', () => {
  it('converts at the configured rate', () => {
    expect(coinsToRupees(250, 1)).toBe('250.00');
    expect(coinsToRupees(250, 0.5)).toBe('125.00');
  });

  it('never reports a negative value', () => {
    expect(coinsToRupees(-50, 1)).toBe('0.00');
  });
});

describe('pricing a booking', () => {
  const base = {
    flatPrice: '1000.00',
    coinsRequested: 0,
    coinBalance: 0,
    coinValueRupees: 1,
    maxRedemptionPercent: 20,
    subscriptionDiscountPercent: 0,
    subscriptionMaxDiscount: null as string | null,
  };

  it('charges the flat price when there is nothing to apply', () => {
    const quote = computeDiscounts(base);
    expect(quote.payableAmount).toBe('1000.00');
    expect(quote.discountAmount).toBe('0.00');
  });

  it('applies the subscription percentage', () => {
    const quote = computeDiscounts({
      ...base,
      subscriptionDiscountPercent: 10,
    });
    expect(quote.subscriptionDiscountAmount).toBe('100.00');
    expect(quote.payableAmount).toBe('900.00');
  });

  it("honours the plan's per-booking cap", () => {
    const quote = computeDiscounts({
      ...base,
      subscriptionDiscountPercent: 25,
      subscriptionMaxDiscount: '150.00',
    });
    expect(quote.subscriptionDiscountAmount).toBe('150.00');
  });

  it('caps coins at the redemption ceiling', () => {
    // 20% of ₹1,000 is ₹200, so 200 coins — even holding 900.
    const quote = computeDiscounts({
      ...base,
      coinsRequested: 900,
      coinBalance: 900,
    });
    expect(quote.coinsRedeemed).toBe(200);
    expect(quote.maxRedeemableCoins).toBe(200);
    expect(quote.payableAmount).toBe('800.00');
  });

  it('clamps to the balance rather than refusing', () => {
    // Asking for more than you hold spends what you have. Refusing would make
    // the coin slider an error state instead of a control.
    const quote = computeDiscounts({
      ...base,
      coinsRequested: 500,
      coinBalance: 60,
    });
    expect(quote.coinsRedeemed).toBe(60);
    expect(quote.payableAmount).toBe('940.00');
  });

  it('applies the subscription first and lets coins fill what is left', () => {
    // The order is the policy: a subscriber is entitled to their percentage
    // whether or not they have coins, and computing it on an already
    // discounted amount would shrink the benefit they paid for.
    const quote = computeDiscounts({
      ...base,
      subscriptionDiscountPercent: 10,
      coinsRequested: 500,
      coinBalance: 500,
    });
    expect(quote.subscriptionDiscountAmount).toBe('100.00');
    // Coins still cap against the *list* price, so the ceiling means the same
    // thing to every customer.
    expect(quote.coinsRedeemed).toBe(200);
    expect(quote.discountAmount).toBe('300.00');
    expect(quote.payableAmount).toBe('700.00');
  });

  it('never lets the two discounts take a booking below zero', () => {
    const quote = computeDiscounts({
      ...base,
      subscriptionDiscountPercent: 100,
      coinsRequested: 5000,
      coinBalance: 5000,
      maxRedemptionPercent: 100,
    });
    expect(quote.payableAmount).toBe('0.00');
    // Nothing was left for coins to pay, so none were spent.
    expect(quote.coinsRedeemed).toBe(0);
  });

  it('keeps the parts adding up, which the CHECK constraints also require', () => {
    const quote = computeDiscounts({
      ...base,
      flatPrice: '1234.56',
      subscriptionDiscountPercent: 7,
      coinsRequested: 100,
      coinBalance: 100,
    });

    const parts =
      Number(quote.subscriptionDiscountAmount) +
      Number(quote.walletDiscountAmount);
    expect(Number(quote.discountAmount)).toBeCloseTo(parts, 2);
    expect(Number(quote.payableAmount)).toBeCloseTo(
      Number(quote.flatPrice) - Number(quote.discountAmount),
      2,
    );
  });

  it('spends nothing when the customer asks for nothing', () => {
    const quote = computeDiscounts({ ...base, coinBalance: 900 });
    expect(quote.coinsRedeemed).toBe(0);
    // But still tells the app what was available, so it can offer.
    expect(quote.maxRedeemableCoins).toBe(200);
  });

  it('treats a negative request as zero rather than a credit', () => {
    const quote = computeDiscounts({
      ...base,
      coinsRequested: -500,
      coinBalance: 900,
    });
    expect(quote.coinsRedeemed).toBe(0);
    expect(quote.payableAmount).toBe('1000.00');
  });
});

describe('referral codes', () => {
  it('strips what a person typing a code read aloud would add', () => {
    expect(normaliseReferralCode(' hm4k-2p ')).toBe('HM4K2P');
  });

  it('accepts what the database CHECK accepts, and no more', () => {
    expect(isWellFormedReferralCode('HM4K2P')).toBe(true);
    expect(isWellFormedReferralCode('hm4k2p')).toBe(false);
    expect(isWellFormedReferralCode('HM4K')).toBe(false);
    expect(isWellFormedReferralCode('HM4K2P-EXTRA')).toBe(false);
  });
});

describe('exactly-once keys', () => {
  it('derives every key from the thing that happened, never from a clock', () => {
    // Called twice, a second apart, they must be identical — that is the whole
    // guarantee, and a timestamp anywhere in one would break it silently.
    expect(walletSourceRef.earn('bk-1')).toBe(walletSourceRef.earn('bk-1'));
    expect(walletSourceRef.earn('bk-1')).not.toBe(walletSourceRef.earn('bk-2'));
  });

  it('keeps a redemption and its reversal apart', () => {
    // Same booking, opposite directions. One key would make the reversal look
    // like a repeat of the debit and silently do nothing.
    expect(walletSourceRef.redeem('bk-1')).not.toBe(
      walletSourceRef.redeemReversal('bk-1'),
    );
  });

  it("keeps a referral's two sides apart", () => {
    expect(walletSourceRef.referrerReward('ref-1')).not.toBe(
      walletSourceRef.refereeReward('ref-1'),
    );
  });
});
