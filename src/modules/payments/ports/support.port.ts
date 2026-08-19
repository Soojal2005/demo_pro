import { Injectable, Logger } from '@nestjs/common';

export const SUPPORT_PORT = Symbol('SUPPORT_PORT');

export interface BillingTicket {
  bookingId: string;
  proId: string;
  customerId: string;
  amount: string;
  reason: string;
}

/**
 * What Payments needs from Support & Disputes (module 11), expressed as an
 * interface Payments owns.
 *
 * One method, for one situation: a cash job the customer will not pay for.
 */
export interface SupportPort {
  raiseBillingTicket(ticket: BillingTicket): Promise<void>;
}

/**
 * Stand-in until module 11 lands, and the delegate it registers into.
 *
 * Quiet, for the same reason as the ledger stub: feature 17 is explicit that
 * an unpaid job still **completes** and the Pro is still **paid their
 * commission**. Blocking completion on a ticketing system that does not exist
 * would invert that, punishing the Pro for the customer's refusal.
 *
 * The booking itself is the durable record in the meantime —
 * `cashDeclinedAt` and `cashDeclinedReason` are set, and a `paymentMode = cash`
 * booking that is `completed` while still `unpaid` is a query, not a mystery.
 */
@Injectable()
export class NoOpSupportService implements SupportPort {
  private readonly logger = new Logger(NoOpSupportService.name);

  /**
   * The real ticket system, registered at boot by module 11 if it is present.
   *
   * The same indirection `NoOpCommissionService` and `NoOpLedgerService` use,
   * for the same reason: Nest resolves providers per module, so re-binding
   * `SUPPORT_PORT` inside `SupportModule` would never reach
   * `CashCollectionService` here in Payments.
   */
  private real: SupportPort | null = null;

  register(implementation: SupportPort): void {
    this.real = implementation;
    this.logger.log(
      'Support ticketing registered — an unpaid cash job now raises a real ' +
        'billing ticket instead of a log line.',
    );
  }

  raiseBillingTicket(ticket: BillingTicket): Promise<void> {
    if (this.real) return this.real.raiseBillingTicket(ticket);

    this.logger.warn(
      `Billing ticket not raised — module 11 is not built: booking ${ticket.bookingId} ` +
        `completed with ${ticket.amount} uncollected from customer ${ticket.customerId} ` +
        `(Pro ${ticket.proId}): ${ticket.reason}`,
    );
    return Promise.resolve();
  }
}
