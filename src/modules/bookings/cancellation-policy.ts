import { fromPaise, toPaise } from '../payments/payments.money';
import type { BookingStatus, CancellationWindow } from './booking.types';
import { cancellationWindowFor, windowChargesFee } from './booking.types';

/**
 * The time half of the cancellation policy.
 *
 * `booking.types.ts` already answers "which of the six windows is this booking
 * in", from its **status** alone. That was always only half the question. A
 * booking sitting in `assigned` for a slot three days out and a booking sitting
 * in `assigned` for a slot in forty minutes are the same window and are not
 * remotely the same decision: in the first, nobody has organised their day
 * around it; in the second, a Pro's afternoon is already committed to an
 * address they can no longer fill.
 *
 * So this file adds the second axis — **how long until the Pro was due** — and
 * the two together decide the fee. The status windows keep deciding the refund
 * mechanics, the assignment teardown and whether ops must be involved; none of
 * that changes.
 *
 * Everything here is pure and integer-only. The money arithmetic runs in paise
 * for the reason `payments.money.ts` states at length.
 */

/** Which side of the free-cancellation cutoff a booking falls on. */
export type CancellationTiming = 'early' | 'late' | 'unscheduled';

export interface PolicyInput {
  status: BookingStatus;
  /** The slot the Pro was due. Null on a booking that never had one. */
  slotStartAt: Date | null;
  /** What the customer actually owes — never `flatPrice`. */
  payableAmount: string;
  /** `booking.freeCancellationHours`, default 6. */
  freeCancellationHours: number;
  /** `booking.lateCancellationFeePercent`, default 25. */
  lateCancellationFeePercent: number;
  /** `booking.cancellationFeeAmount` — the flat window-D fee. */
  windowDFeeAmount: string;
  /** True when the customer's plan buys the fee away. */
  subscriptionWaivesFee: boolean;
  /** Only a customer is ever charged. Ops and system cancellations are free. */
  cancelledByType: 'customer' | 'ops' | 'system';
  now: Date;
}

export interface PolicyDecision {
  window: CancellationWindow;
  timing: CancellationTiming;
  /** Negative once the slot has passed. Null when there is no slot. */
  hoursUntilSlot: number | null;
  /** Rupee string. What the platform retains. */
  feeAmount: string;
  /** Rupee string. `payableAmount - feeAmount`, floored at zero. */
  refundAmount: string;
  /** Why the fee is what it is, in words a customer can be shown. */
  reason: string;
  /** True when a plan turned a chargeable cancellation into a free one. */
  feeWaivedBySubscription: boolean;
}

/** Hours from `now` to the slot. Negative once the slot has gone by. */
export function hoursUntil(slotStartAt: Date | null, now: Date): number | null {
  if (!slotStartAt) return null;
  return (slotStartAt.getTime() - now.getTime()) / 3_600_000;
}

/**
 * Early, late, or no slot at all.
 *
 * A booking with no slot is `unscheduled` rather than `late`, and that is a
 * deliberate kindness: the cutoff is a promise about a time the customer was
 * given, and charging against a time that was never agreed is not a policy,
 * it is a surprise.
 */
export function timingFor(
  slotStartAt: Date | null,
  now: Date,
  freeCancellationHours: number,
): CancellationTiming {
  const hours = hoursUntil(slotStartAt, now);
  if (hours === null) return 'unscheduled';
  return hours >= freeCancellationHours ? 'early' : 'late';
}

/**
 * The whole fee decision, in one pure function.
 *
 * The rules, in the order they are applied — the order is the policy:
 *
 * 1. **Only a customer pays.** An ops or system cancellation is the platform's
 *    own failure, and US-4.22 rules out charging for it flatly.
 * 2. **A subscriber whose plan waives the fee pays nothing.** This is the
 *    headline perk people buy the plan for, so it beats every rule below it.
 * 3. **Cancel more than `freeCancellationHours` before the slot and it is
 *    free** — whatever the status window says, including window D. A Pro
 *    marked en route six hours early has not lost the afternoon.
 * 4. **Inside the cutoff, a percentage of the payable amount is retained.**
 *    Not a flat fee: retaining ₹100 on a ₹300 job and on a ₹3,000 job are
 *    different decisions, and the percentage keeps them proportionate.
 * 5. **Window D inside the cutoff takes whichever is greater** — the
 *    percentage or the configured flat window-D fee. Someone is standing at
 *    the door; that is the one case where the platform's floor applies.
 * 6. **Window A is always free.** Nothing was ever charged, so there is
 *    nothing to retain, whatever the clock says.
 *
 * Window E is absent on purpose. A job already under way is "partial, at ops
 * discretion" — routing it to a formula is exactly what US-4.21 warns against,
 * and this function is never consulted for it.
 */
export function decideCancellation(input: PolicyInput): PolicyDecision {
  const window = cancellationWindowFor(input.status) ?? 'A';
  const timing = timingFor(
    input.slotStartAt,
    input.now,
    input.freeCancellationHours,
  );
  const hours = hoursUntil(input.slotStartAt, input.now);
  const payablePaise = toPaise(input.payableAmount);

  const free = (reason: string, waived = false): PolicyDecision => ({
    window,
    timing,
    hoursUntilSlot: hours,
    feeAmount: '0.00',
    refundAmount: fromPaise(payablePaise),
    reason,
    feeWaivedBySubscription: waived,
  });

  // 1 · the platform's own failure is never the customer's cost
  if (input.cancelledByType !== 'customer') {
    return free('Cancelled by Homingo — no charge');
  }

  // 6 · nothing was ever charged in window A
  if (window === 'A') {
    return free('Free — nothing had been charged yet');
  }

  // 2 · the perk people buy the plan for
  if (input.subscriptionWaivesFee) {
    return free('Free — your Homingo plan waives cancellation fees', true);
  }

  // 3 · outside the cutoff, free regardless of window
  if (timing === 'early') {
    return free(
      `Free — cancelled more than ${input.freeCancellationHours} hours before your slot`,
    );
  }

  // A booking with no slot has no cutoff to be inside of.
  if (timing === 'unscheduled' && !windowChargesFee(window)) {
    return free('Free — this booking had no scheduled slot');
  }

  // 4 · a proportion of what they owe
  let feePaise = Math.floor(
    (payablePaise * clampPercent(input.lateCancellationFeePercent)) / 100,
  );
  let reason =
    timing === 'late'
      ? `${clampPercent(input.lateCancellationFeePercent)}% retained — cancelled within ${input.freeCancellationHours} hours of your slot`
      : `${clampPercent(input.lateCancellationFeePercent)}% retained`;

  // 5 · someone is at the door
  if (windowChargesFee(window)) {
    const flatPaise = toPaise(input.windowDFeeAmount);
    if (flatPaise > feePaise) {
      feePaise = flatPaise;
      reason = 'Your Pro was already on the way — travel fee retained';
    }
  }

  // Never more than the customer owes. A fee that exceeds the job's price
  // would turn a cancellation into a debt.
  feePaise = Math.min(Math.max(feePaise, 0), payablePaise);

  return {
    window,
    timing,
    hoursUntilSlot: hours,
    feeAmount: fromPaise(feePaise),
    refundAmount: fromPaise(payablePaise - feePaise),
    reason,
    feeWaivedBySubscription: false,
  };
}

// ---------------------------------------------------------------------
// Rescheduling
// ---------------------------------------------------------------------

/** Statuses from which a slot can still be moved rather than cancelled. */
export const RESCHEDULABLE_STATUSES: BookingStatus[] = [
  'created',
  'awaiting_payment',
  'assigning',
  'assigned',
];

export interface RescheduleInput {
  status: BookingStatus;
  bookingType: string;
  slotStartAt: Date | null;
  newSlotStartAt: Date;
  rescheduleCount: number;
  /** `booking.maxReschedules`, plus whatever the customer's plan adds. */
  allowance: number;
  /** `booking.freeRescheduleHours`, default 6. */
  freeRescheduleHours: number;
  now: Date;
}

export type RescheduleRefusal =
  | 'STATUS_TOO_LATE'
  | 'INSIDE_CUTOFF'
  | 'ALLOWANCE_EXHAUSTED'
  | 'NEW_SLOT_IN_THE_PAST'
  | 'NEW_SLOT_INSIDE_CUTOFF'
  | 'NOT_SCHEDULED'
  | 'SAME_SLOT';

export interface RescheduleDecision {
  allowed: boolean;
  refusal: RescheduleRefusal | null;
  message: string;
  hoursUntilSlot: number | null;
  reschedulesRemaining: number;
}

/**
 * May this booking's slot move, and to when.
 *
 * A reschedule is the outcome the platform actually wants from "I can't make
 * it" — the job survives, the customer keeps their money and the Pro keeps a
 * filled slot, where a cancellation loses all three. So it is deliberately
 * *cheaper* than cancelling: free inside the allowance, and refused rather
 * than charged once the cutoff has passed.
 *
 * Refusing rather than charging is the important half. Inside six hours the
 * Pro's day is already built around this address; moving it then is not a
 * smaller version of cancelling, it is the same disruption with the platform
 * still on the hook for the new slot. The customer is told to cancel, where
 * the fee is at least honest about what happened.
 */
export function decideReschedule(input: RescheduleInput): RescheduleDecision {
  const hours = hoursUntil(input.slotStartAt, input.now);
  const remaining = Math.max(0, input.allowance - input.rescheduleCount);

  const refuse = (
    refusal: RescheduleRefusal,
    message: string,
  ): RescheduleDecision => ({
    allowed: false,
    refusal,
    message,
    hoursUntilSlot: hours,
    reschedulesRemaining: remaining,
  });

  if (!RESCHEDULABLE_STATUSES.includes(input.status)) {
    return refuse(
      'STATUS_TOO_LATE',
      'This job is already under way — cancel it instead if you need to stop it.',
    );
  }

  if (!input.slotStartAt) {
    return refuse(
      'NOT_SCHEDULED',
      'An instant booking has no slot to move. Cancel it and book again when you are ready.',
    );
  }

  if (remaining <= 0) {
    return refuse(
      'ALLOWANCE_EXHAUSTED',
      `You have already moved this booking ${input.rescheduleCount} times. Cancel it and book a new slot instead.`,
    );
  }

  if (hours !== null && hours < input.freeRescheduleHours) {
    return refuse(
      'INSIDE_CUTOFF',
      `Bookings can only be moved more than ${input.freeRescheduleHours} hours before the slot. Your Pro is already scheduled — cancel instead if you need to.`,
    );
  }

  if (input.newSlotStartAt.getTime() <= input.now.getTime()) {
    return refuse('NEW_SLOT_IN_THE_PAST', 'Pick a slot in the future.');
  }

  // The new slot has to clear the cutoff too, or the customer could move a job
  // to two hours from now and land in the state this rule exists to prevent.
  const hoursToNew =
    (input.newSlotStartAt.getTime() - input.now.getTime()) / 3_600_000;
  if (hoursToNew < input.freeRescheduleHours) {
    return refuse(
      'NEW_SLOT_INSIDE_CUTOFF',
      `Pick a slot at least ${input.freeRescheduleHours} hours from now.`,
    );
  }

  if (input.newSlotStartAt.getTime() === input.slotStartAt.getTime()) {
    return refuse('SAME_SLOT', 'That is the slot you already have.');
  }

  return {
    allowed: true,
    refusal: null,
    message:
      remaining === 1
        ? 'Free to move. This is the last free change on this booking.'
        : `Free to move. ${remaining} changes left on this booking.`,
    hoursUntilSlot: hours,
    reschedulesRemaining: remaining,
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}
