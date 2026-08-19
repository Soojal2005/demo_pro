import {
  decideCancellation,
  decideReschedule,
  hoursUntil,
  timingFor,
  type PolicyInput,
  type RescheduleInput,
} from './cancellation-policy';

const NOW = new Date('2026-08-19T12:00:00.000Z');
const HOUR = 3_600_000;

/** A slot `hours` from `NOW`. */
function slot(hours: number): Date {
  return new Date(NOW.getTime() + hours * HOUR);
}

function policy(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    status: 'assigned',
    slotStartAt: slot(48),
    payableAmount: '1000.00',
    freeCancellationHours: 6,
    lateCancellationFeePercent: 25,
    windowDFeeAmount: '0.00',
    subscriptionWaivesFee: false,
    cancelledByType: 'customer',
    now: NOW,
    ...overrides,
  };
}

describe('the clock', () => {
  it('measures hours to the slot', () => {
    expect(hoursUntil(slot(6), NOW)).toBe(6);
    expect(hoursUntil(slot(0.5), NOW)).toBe(0.5);
  });

  it('goes negative once the slot has passed', () => {
    expect(hoursUntil(slot(-2), NOW)).toBe(-2);
  });

  it('has no answer for a booking with no slot', () => {
    expect(hoursUntil(null, NOW)).toBeNull();
  });
});

describe('which side of the cutoff', () => {
  it('is early at exactly the cutoff, not late', () => {
    // The boundary belongs to the customer. Six hours out means six hours is
    // still free — a customer told "cancel 6 hours before" who is charged at
    // exactly six hours has been told the wrong thing.
    expect(timingFor(slot(6), NOW, 6)).toBe('early');
  });

  it('is late a minute inside it', () => {
    expect(timingFor(new Date(NOW.getTime() + 6 * HOUR - 60_000), NOW, 6)).toBe(
      'late',
    );
  });

  it('is late once the slot has gone by', () => {
    expect(timingFor(slot(-1), NOW, 6)).toBe('late');
  });

  it('is unscheduled with no slot — not late', () => {
    // Charging against a time that was never agreed is a surprise, not a
    // policy.
    expect(timingFor(null, NOW, 6)).toBe('unscheduled');
  });
});

describe('the cancellation fee', () => {
  it('is nothing more than six hours out, whatever the window', () => {
    for (const status of [
      'assigning',
      'assigned',
      'en_route',
      'arrived',
    ] as const) {
      const decision = decideCancellation(
        policy({ status, slotStartAt: slot(48) }),
      );
      expect(decision.feeAmount).toBe('0.00');
      expect(decision.refundAmount).toBe('1000.00');
      expect(decision.timing).toBe('early');
    }
  });

  it('retains the percentage inside the cutoff', () => {
    const decision = decideCancellation(policy({ slotStartAt: slot(2) }));
    expect(decision.feeAmount).toBe('250.00');
    expect(decision.refundAmount).toBe('750.00');
    expect(decision.reason).toContain('within 6 hours');
  });

  it('is proportionate, so a small job is not charged like a large one', () => {
    const small = decideCancellation(
      policy({ slotStartAt: slot(2), payableAmount: '300.00' }),
    );
    const large = decideCancellation(
      policy({ slotStartAt: slot(2), payableAmount: '3000.00' }),
    );
    expect(small.feeAmount).toBe('75.00');
    expect(large.feeAmount).toBe('750.00');
  });

  it('takes the flat window-D fee when it beats the percentage', () => {
    // Someone is standing at the door — the one case where the platform's
    // floor applies over the proportion.
    const decision = decideCancellation(
      policy({
        status: 'arrived',
        slotStartAt: slot(0.5),
        lateCancellationFeePercent: 5,
        windowDFeeAmount: '300.00',
      }),
    );
    expect(decision.feeAmount).toBe('300.00');
    expect(decision.reason).toContain('on the way');
  });

  it('keeps the percentage when it beats the flat fee', () => {
    const decision = decideCancellation(
      policy({
        status: 'arrived',
        slotStartAt: slot(0.5),
        windowDFeeAmount: '50.00',
      }),
    );
    expect(decision.feeAmount).toBe('250.00');
  });

  it('never exceeds what the customer owes', () => {
    // A cancellation must never turn into a debt.
    const decision = decideCancellation(
      policy({
        status: 'arrived',
        slotStartAt: slot(0.5),
        windowDFeeAmount: '99999.00',
      }),
    );
    expect(decision.feeAmount).toBe('1000.00');
    expect(decision.refundAmount).toBe('0.00');
  });

  it('is nothing in window A, whatever the clock says', () => {
    for (const status of ['created', 'awaiting_payment'] as const) {
      const decision = decideCancellation(
        policy({ status, slotStartAt: slot(0.1) }),
      );
      expect(decision.feeAmount).toBe('0.00');
    }
  });

  it('is nothing when Homingo is the party cancelling — US-4.22', () => {
    for (const actor of ['ops', 'system'] as const) {
      const decision = decideCancellation(
        policy({
          status: 'arrived',
          slotStartAt: slot(0.5),
          cancelledByType: actor,
        }),
      );
      expect(decision.feeAmount).toBe('0.00');
      expect(decision.reason).toContain('Cancelled by Homingo');
    }
  });

  it('is waived outright for a subscriber whose plan says so', () => {
    const decision = decideCancellation(
      policy({
        status: 'arrived',
        slotStartAt: slot(0.5),
        subscriptionWaivesFee: true,
      }),
    );
    expect(decision.feeAmount).toBe('0.00');
    expect(decision.feeWaivedBySubscription).toBe(true);
  });

  it('beats even the flat window-D fee for a subscriber', () => {
    // It is the headline perk people buy the plan for, so it sits above every
    // rule below it.
    const decision = decideCancellation(
      policy({
        status: 'arrived',
        slotStartAt: slot(0.1),
        windowDFeeAmount: '500.00',
        subscriptionWaivesFee: true,
      }),
    );
    expect(decision.feeAmount).toBe('0.00');
  });

  it('charges nothing on a booking that never had a slot', () => {
    const decision = decideCancellation(
      policy({ status: 'assigned', slotStartAt: null }),
    );
    expect(decision.feeAmount).toBe('0.00');
    expect(decision.timing).toBe('unscheduled');
  });

  it('still charges an unscheduled booking whose Pro is at the door', () => {
    // No slot is a reason not to hold someone to a clock, not a reason to
    // travel to their address for free.
    const decision = decideCancellation(
      policy({
        status: 'arrived',
        slotStartAt: null,
        windowDFeeAmount: '200.00',
      }),
    );
    expect(decision.feeAmount).toBe('250.00');
  });

  it('does not lose paise on an awkward amount', () => {
    // 25% of ₹1234.56 is ₹308.64.
    const decision = decideCancellation(
      policy({ slotStartAt: slot(2), payableAmount: '1234.56' }),
    );
    expect(decision.feeAmount).toBe('308.64');
    expect(decision.refundAmount).toBe('925.92');
  });

  it('always leaves fee and refund summing to the payable amount', () => {
    for (const hours of [48, 6, 5.9, 1, 0.1, -1]) {
      const decision = decideCancellation(
        policy({
          status: 'arrived',
          slotStartAt: slot(hours),
          payableAmount: '999.99',
        }),
      );
      expect(
        Number(decision.feeAmount) + Number(decision.refundAmount),
      ).toBeCloseTo(999.99, 2);
    }
  });
});

// ---------------------------------------------------------------------

function reschedule(overrides: Partial<RescheduleInput> = {}): RescheduleInput {
  return {
    status: 'assigned',
    bookingType: 'scheduled',
    slotStartAt: slot(48),
    newSlotStartAt: slot(72),
    rescheduleCount: 0,
    allowance: 2,
    freeRescheduleHours: 6,
    now: NOW,
    ...overrides,
  };
}

describe('rescheduling', () => {
  it('allows a move well outside the cutoff', () => {
    const decision = decideReschedule(reschedule());
    expect(decision.allowed).toBe(true);
    expect(decision.reschedulesRemaining).toBe(2);
  });

  it('refuses rather than charges inside the cutoff', () => {
    // Six hours out, the Pro's day is already built around this address.
    // Moving it then is the same disruption as cancelling, with the platform
    // still on the hook for a new slot — so the customer is sent to cancel,
    // where the fee is at least honest about what happened.
    const decision = decideReschedule(reschedule({ slotStartAt: slot(3) }));
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe('INSIDE_CUTOFF');
    expect(decision.message).toContain('cancel');
  });

  it('allows a move at exactly the cutoff', () => {
    expect(decideReschedule(reschedule({ slotStartAt: slot(6) })).allowed).toBe(
      true,
    );
  });

  it('refuses a new slot inside the cutoff', () => {
    // Otherwise a customer could move a job to two hours from now and land in
    // exactly the state the rule exists to prevent.
    const decision = decideReschedule(reschedule({ newSlotStartAt: slot(2) }));
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe('NEW_SLOT_INSIDE_CUTOFF');
  });

  it('refuses a new slot in the past', () => {
    const decision = decideReschedule(reschedule({ newSlotStartAt: slot(-2) }));
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe('NEW_SLOT_IN_THE_PAST');
  });

  it('refuses the slot the booking already has', () => {
    const decision = decideReschedule(reschedule({ newSlotStartAt: slot(48) }));
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe('SAME_SLOT');
  });

  it('runs out after the allowance', () => {
    const decision = decideReschedule(reschedule({ rescheduleCount: 2 }));
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe('ALLOWANCE_EXHAUSTED');
  });

  it("extends the allowance by the plan's bonus", () => {
    // The caller adds the plan's `extraReschedules` before calling; this is
    // the check that the extra ones are actually usable.
    const decision = decideReschedule(
      reschedule({ rescheduleCount: 2, allowance: 4 }),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reschedulesRemaining).toBe(2);
  });

  it('warns on the last free move', () => {
    const decision = decideReschedule(reschedule({ rescheduleCount: 1 }));
    expect(decision.allowed).toBe(true);
    expect(decision.message).toContain('last free change');
  });

  it('refuses once the job is under way', () => {
    for (const status of [
      'en_route',
      'arrived',
      'started',
      'completed',
    ] as const) {
      const decision = decideReschedule(reschedule({ status }));
      expect(decision.allowed).toBe(false);
      expect(decision.refusal).toBe('STATUS_TOO_LATE');
    }
  });

  it('refuses a cancelled booking', () => {
    expect(decideReschedule(reschedule({ status: 'cancelled' })).allowed).toBe(
      false,
    );
  });

  it('allows a move while a Pro is assigned but not yet travelling', () => {
    // The assignment is released and dispatch re-runs — that is a cost the
    // platform absorbs, and it is much smaller than losing the job.
    expect(decideReschedule(reschedule({ status: 'assigned' })).allowed).toBe(
      true,
    );
  });

  it('has nothing to move on a booking with no slot', () => {
    const decision = decideReschedule(reschedule({ slotStartAt: null }));
    expect(decision.allowed).toBe(false);
    expect(decision.refusal).toBe('NOT_SCHEDULED');
  });

  it('checks the allowance before the clock', () => {
    // A customer out of moves is told they are out of moves, not that they are
    // too late — the second is fixable by waiting and the first is not.
    const decision = decideReschedule(
      reschedule({ rescheduleCount: 2, slotStartAt: slot(1) }),
    );
    expect(decision.refusal).toBe('ALLOWANCE_EXHAUSTED');
  });
});
