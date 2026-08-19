/**
 * Module 16 live verification against the real database.
 *
 * Everything in `npx jest` mocks Prisma, so 1,375 green tests prove the logic
 * and prove nothing about the schema. This is the pass that exercises the
 * CHECK constraints, the row lock, the backfilled column and the real
 * arithmetic end to end — the house standard the other modules met with their
 * cURL runs.
 *
 *   NODE_ENV=local npx tsx test/manual/run-loyalty-live.ts
 *
 * **It creates real rows and deletes them again.** Every row it writes carries
 * the `LIVE-CHECK` marker, and the cleanup in `finally` removes them whether
 * the run passes or throws. Nothing pre-existing is touched.
 */
import { config as loadEnv } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/prisma/client';

loadEnv({ path: `.env.${process.env.NODE_ENV ?? 'local'}` });
loadEnv({ path: '.env' });

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const MARKER = 'LIVE-CHECK';
let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Runs a write that the database is expected to refuse. */
async function refuses(name: string, write: () => Promise<unknown>) {
  try {
    await write();
    check(name, false, 'the database ACCEPTED a row it should refuse');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const constraint = /constraint "([^"]+)"/.exec(message)?.[1] ?? 'refused';
    check(name, true, constraint);
  }
}

async function main() {
  const created = {
    customerIds: [] as string[],
    bookingIds: [] as string[],
  };

  try {
    // ---------------------------------------------------------------
    console.log('\n1 · fixtures');
    const service = await prisma.service.findFirst({
      where: { isActive: true },
    });
    const address = await prisma.customerAddress.findFirst();
    if (!service || !address)
      throw new Error('No service/address to test against.');

    const customer = await prisma.customer.create({
      data: { fullName: `${MARKER} wallet customer`, status: 'guest' },
    });
    created.customerIds.push(customer.id);
    console.log(`  service ${service.name} @ ${service.flatPrice.toString()}`);

    // ---------------------------------------------------------------
    console.log('\n2 · wallet — the row lock and the running balance');
    const wallet = await prisma.customerWallet.create({
      data: { customerId: customer.id },
    });
    await prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        customerId: customer.id,
        type: 'earn',
        coins: 500,
        balanceAfter: 500,
        rupeeValue: '500.00',
        reason: `${MARKER} opening balance`,
        sourceRef: `${MARKER}:earn:${customer.id}`,
      },
    });
    await prisma.customerWallet.update({
      where: { id: wallet.id },
      data: { balanceCoins: 500, lifetimeEarnedCoins: 500 },
    });
    const funded = await prisma.customerWallet.findUniqueOrThrow({
      where: { id: wallet.id },
    });
    check(
      'wallet credits',
      funded.balanceCoins === 500,
      `${funded.balanceCoins} coins`,
    );

    await refuses('overdraft is refused', () =>
      prisma.customerWallet.update({
        where: { id: wallet.id },
        data: { balanceCoins: -1 },
      }),
    );

    await refuses('an `earn` that debits is refused', () =>
      prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          customerId: customer.id,
          type: 'earn',
          coins: -50,
          balanceAfter: 450,
          rupeeValue: '50.00',
          reason: `${MARKER} wrong direction`,
          sourceRef: `${MARKER}:bad-direction`,
        },
      }),
    );

    await refuses('a second movement on one sourceRef is refused', () =>
      prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          customerId: customer.id,
          type: 'earn',
          coins: 500,
          balanceAfter: 1000,
          rupeeValue: '500.00',
          reason: `${MARKER} duplicate`,
          sourceRef: `${MARKER}:earn:${customer.id}`,
        },
      }),
    );

    await refuses('an adjustment with no admin is refused', () =>
      prisma.walletTransaction.create({
        data: {
          walletId: wallet.id,
          customerId: customer.id,
          type: 'adjustment',
          coins: 100,
          balanceAfter: 600,
          rupeeValue: '100.00',
          reason: `${MARKER} unattributed`,
          sourceRef: `${MARKER}:unattributed`,
        },
      }),
    );

    // ---------------------------------------------------------------
    console.log('\n3 · a discounted booking actually writes');
    const list = Number(service.flatPrice);
    const walletDiscount = 100;
    const payable = (list - walletDiscount).toFixed(2);

    const booking = await prisma.booking.create({
      data: {
        bookingNumber: `${MARKER}-${Date.now()}`,
        customerId: customer.id,
        serviceId: service.id,
        addressId: address.id,
        flatPrice: service.flatPrice,
        coinsRedeemed: 100,
        walletDiscountAmount: walletDiscount.toFixed(2),
        subscriptionDiscountAmount: '0.00',
        discountAmount: walletDiscount.toFixed(2),
        payableAmount: payable,
        paymentMode: 'cash',
        status: 'created',
      },
    });
    created.bookingIds.push(booking.id);
    /*
     * Compared as numbers, not as strings. A `Decimal` of 4899 stringifies to
     * '4899' while `toFixed(2)` gives '4899.00' — the same money and different
     * text. This is the exact trap `rupeesEqual` exists for in
     * payments.money.ts, and the first version of this check fell into it.
     */
    check(
      'discounted booking accepted',
      Number(booking.payableAmount.toString()) === Number(payable),
      `list ${list} − ${walletDiscount} = ${booking.payableAmount.toString()}`,
    );

    await refuses('a payable that is not price less discount is refused', () =>
      prisma.booking.update({
        where: { id: booking.id },
        data: { payableAmount: (list + 1).toFixed(2) },
      }),
    );

    await refuses('a discount that does not equal its parts is refused', () =>
      prisma.booking.update({
        where: { id: booking.id },
        data: { discountAmount: '999.00' },
      }),
    );

    await refuses('coins with no rupee value behind them is refused', () =>
      prisma.booking.update({
        where: { id: booking.id },
        data: { coinsRedeemed: 50, walletDiscountAmount: '0.00' },
      }),
    );

    // ---------------------------------------------------------------
    console.log('\n4 · the backfill on pre-existing bookings');
    const legacy = await prisma.booking.aggregate({
      where: { bookingNumber: { not: { startsWith: MARKER } } },
      _count: { _all: true },
    });
    const mismatched = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM "bookings"
       WHERE "payableAmount" <> "flatPrice" - "discountAmount"`;
    check(
      'every pre-existing booking backfilled consistently',
      Number(mismatched[0].n) === 0,
      `${legacy._count._all} legacy rows, ${mismatched[0].n} inconsistent`,
    );

    // ---------------------------------------------------------------
    console.log('\n5 · referrals — the anti-farming constraints');
    const referee = await prisma.customer.create({
      data: { fullName: `${MARKER} referee`, status: 'guest' },
    });
    created.customerIds.push(referee.id);

    await prisma.referralCode.create({
      data: { customerId: customer.id, code: 'LVCHK1' },
    });
    check('referral code minted', true, 'LVCHK1');

    await refuses('a lower-case code is refused', () =>
      prisma.referralCode.create({
        data: { customerId: referee.id, code: 'lower1' },
      }),
    );

    await refuses('referring yourself is refused', () =>
      prisma.referral.create({
        data: {
          referrerId: customer.id,
          refereeId: customer.id,
          code: 'LVCHK1',
          status: 'pending',
        },
      }),
    );

    const referral = await prisma.referral.create({
      data: {
        referrerId: customer.id,
        refereeId: referee.id,
        code: 'LVCHK1',
        status: 'pending',
        referrerCoins: 200,
        refereeCoins: 100,
      },
    });
    check('referral recorded as pending', referral.status === 'pending');

    await refuses('being referred twice is refused', () =>
      prisma.referral.create({
        data: {
          referrerId: customer.id,
          refereeId: referee.id,
          code: 'LVCHK1',
          status: 'pending',
        },
      }),
    );

    await refuses('a rewarded referral with no qualifying job is refused', () =>
      prisma.referral.update({
        where: { id: referral.id },
        data: { status: 'rewarded', rewardedAt: new Date() },
      }),
    );

    // ---------------------------------------------------------------
    console.log('\n6 · subscriptions — one live plan per customer');
    const plan = await prisma.subscriptionPlan.findUniqueOrThrow({
      where: { code: 'homingo_gold' },
    });
    const now = new Date();
    const later = new Date(now.getTime() + 86_400_000);

    await prisma.customerSubscription.create({
      data: {
        customerId: customer.id,
        planId: plan.id,
        status: 'active',
        pricePaid: plan.priceAmount,
        activatedAt: now,
        expiresAt: later,
        discountPercent: plan.discountPercent,
        coinEarnMultiplier: plan.coinEarnMultiplier,
        waivesCancellationFee: plan.waivesCancellationFee,
      },
    });
    check('subscription activated', true, plan.name);

    await refuses('a second live plan is refused', () =>
      prisma.customerSubscription.create({
        data: {
          customerId: customer.id,
          planId: plan.id,
          status: 'active',
          pricePaid: plan.priceAmount,
          activatedAt: now,
          expiresAt: later,
        },
      }),
    );

    // ---------------------------------------------------------------
    console.log('\n7 · orders — a subscription order is not a booking order');
    const subscription = await prisma.customerSubscription.findFirstOrThrow({
      where: { customerId: customer.id },
    });

    await refuses('an order belonging to neither is refused', () =>
      prisma.order.create({
        data: {
          customerId: customer.id,
          razorpayOrderId: `${MARKER}-none`,
          receipt: `${MARKER}-none`,
          amount: '100.00',
          amountDue: '100.00',
        },
      }),
    );

    await refuses('an order belonging to both is refused', () =>
      prisma.order.create({
        data: {
          bookingId: booking.id,
          subscriptionId: subscription.id,
          customerId: customer.id,
          razorpayOrderId: `${MARKER}-both`,
          receipt: `${MARKER}-both`,
          amount: '100.00',
          amountDue: '100.00',
        },
      }),
    );

    const subOrder = await prisma.order.create({
      data: {
        subscriptionId: subscription.id,
        customerId: customer.id,
        razorpayOrderId: `${MARKER}-sub`,
        receipt: `${MARKER}-sub`,
        amount: plan.priceAmount,
        amountDue: plan.priceAmount,
      },
    });
    check('a subscription order is accepted', subOrder.bookingId === null);

    // ---------------------------------------------------------------
    console.log('\n8 · reschedule audit');
    await refuses('a Pro rescheduling a job is refused', () =>
      prisma.bookingReschedule.create({
        data: {
          bookingId: booking.id,
          fromSlotStartAt: now,
          toSlotStartAt: later,
          toSlotEndAt: new Date(later.getTime() + 3_600_000),
          hoursBeforeSlot: '24.00',
          requestedByType: 'pro',
        },
      }),
    );
  } finally {
    // -----------------------------------------------------------------
    console.log('\n9 · cleanup');
    await prisma.order.deleteMany({
      where: { receipt: { startsWith: MARKER } },
    });
    await prisma.bookingReschedule.deleteMany({
      where: { booking: { bookingNumber: { startsWith: MARKER } } },
    });
    await prisma.booking.deleteMany({
      where: { bookingNumber: { startsWith: MARKER } },
    });
    await prisma.referral.deleteMany({ where: { code: 'LVCHK1' } });
    await prisma.referralCode.deleteMany({ where: { code: 'LVCHK1' } });
    await prisma.customerSubscription.deleteMany({
      where: { customer: { fullName: { startsWith: MARKER } } },
    });
    await prisma.walletTransaction.deleteMany({
      where: { sourceRef: { startsWith: MARKER } },
    });
    await prisma.customerWallet.deleteMany({
      where: { customer: { fullName: { startsWith: MARKER } } },
    });
    const removed = await prisma.customer.deleteMany({
      where: { fullName: { startsWith: MARKER } },
    });
    console.log(
      `  removed ${removed.count} test customer(s) and everything under them`,
    );

    const leftover = await prisma.booking.count({
      where: { bookingNumber: { startsWith: MARKER } },
    });
    console.log(`  leftover ${MARKER} rows: ${leftover}`);

    console.log(`\n${passed} passed, ${failed} failed`);
    await prisma.$disconnect();
    process.exitCode = failed === 0 ? 0 : 1;
  }
}

void main();
