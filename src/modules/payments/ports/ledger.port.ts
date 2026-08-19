import { Injectable, Logger } from '@nestjs/common';

export const LEDGER_PORT = Symbol('LEDGER_PORT');

export interface CaptureEntry {
  /**
   * Null when the capture bought a subscription rather than a booking. The
   * entry is keyed on `orderId` either way, so nothing downstream needs a
   * booking to record the money.
   */
  bookingId: string | null;
  /** Set instead of `bookingId` for a subscription purchase. */
  subscriptionId?: string | null;
  orderId: string;
  razorpayPaymentId: string;
  customerId: string;
  amount: string;
}

export interface CashCollectionEntry {
  bookingId: string;
  proId: string;
  customerId: string;
  amount: string;
}

export interface RefundEntry {
  /** Null when the refund reverses a subscription purchase, not a booking. */
  bookingId: string | null;
  orderId: string;
  razorpayPaymentId: string;
  razorpayRefundId: string;
  customerId: string;
  amount: string;
}

export interface HandoverEntry {
  handoverId: string;
  proId: string;
  amount: string;
}

/**
 * What Payments needs from the Ledger (module 9), expressed as an interface
 * Payments owns.
 *
 * `LedgerEntry` and its append-only hash chain do not exist yet. Every method
 * here is the point where a double-entry pair would be written — a cash
 * collection debits `cash_in_hand:<proId>` rather than a bank account, which
 * is the one detail about this module the ERD actually records.
 */
export interface LedgerPort {
  recordCapture(entry: CaptureEntry): Promise<void>;
  recordCashCollection(entry: CashCollectionEntry): Promise<void>;
  recordRefund(entry: RefundEntry): Promise<void>;
  recordHandover(entry: HandoverEntry): Promise<void>;
}

/**
 * Stand-in until module 9 lands.
 *
 * It fails **quietly**, and that is the opposite of what module 4's payments
 * stub does — deliberately. `createOrder` throwing a 501 was right because a
 * booking with a phantom order is unrecoverable. Here, the money has already
 * moved: the customer has been charged or the Pro is holding banknotes. A
 * missing ledger row does not make any of that wrong, and refusing to record a
 * cash collection because module 9 is absent would strand a Pro at a
 * customer's door with cash the platform will not acknowledge.
 *
 * What is lost is the audit trail, and it is recoverable — every entry below
 * can be rebuilt from `Order`, `Booking` and `CashHandover`, which is exactly
 * what module 9's reconciliation is for.
 */
@Injectable()
export class NoOpLedgerService implements LedgerPort {
  private readonly logger = new Logger(NoOpLedgerService.name);

  /**
   * The real ledger, registered at boot by module 9 if it is present.
   *
   * The same indirection `NoOpPaymentsService` uses, for the same reason: Nest
   * resolves providers per module, so re-binding `LEDGER_PORT` inside
   * `LedgerModule` would never reach the services in this one.
   */
  private real: LedgerPort | null = null;

  register(implementation: LedgerPort): void {
    this.real = implementation;
    this.logger.log('Ledger registered — money movements are now booked.');
  }

  recordCapture(entry: CaptureEntry): Promise<void> {
    if (this.real) return this.real.recordCapture(entry);
    return this.note(
      `charge ${entry.amount} for booking ${entry.bookingId} (payment ${entry.razorpayPaymentId})`,
    );
  }

  recordCashCollection(entry: CashCollectionEntry): Promise<void> {
    if (this.real) return this.real.recordCashCollection(entry);
    return this.note(
      `cash charge ${entry.amount} for booking ${entry.bookingId}, debiting cash_in_hand:${entry.proId}`,
    );
  }

  recordRefund(entry: RefundEntry): Promise<void> {
    if (this.real) return this.real.recordRefund(entry);
    return this.note(
      `refund ${entry.amount} for booking ${entry.bookingId} (refund ${entry.razorpayRefundId})`,
    );
  }

  recordHandover(entry: HandoverEntry): Promise<void> {
    if (this.real) return this.real.recordHandover(entry);
    return this.note(
      `handover ${entry.amount} clearing cash_in_hand:${entry.proId} (handover ${entry.handoverId})`,
    );
  }

  private note(what: string): Promise<void> {
    this.logger.warn(
      `Ledger entry not written — module 9 is not built: ${what}`,
    );
    return Promise.resolve();
  }
}
