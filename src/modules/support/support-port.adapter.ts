import { Injectable, Logger } from '@nestjs/common';
import type {
  BillingTicket,
  SupportPort,
} from '../payments/ports/support.port';
import { SupportTicketsService } from './support-tickets.service';
import { systemSubject } from './support.types';

/**
 * Module 7's `SUPPORT_PORT`, filled in.
 *
 * `NoOpSupportService` has been logging a warning and returning since Payments
 * shipped: feature 17 says an unpaid cash job still **completes** and the Pro
 * is still **paid their commission**, so blocking completion on a ticketing
 * system that did not exist would have inverted that and punished the Pro for
 * the customer's refusal. The booking columns — `cashDeclinedAt`,
 * `cashDeclinedReason` — have been the durable record in the meantime.
 *
 * Now there is somewhere for it to go. Note what does **not** change: nothing
 * here can fail the completion, because `CashCollectionService` calls the port
 * on a path that must not throw.
 */
@Injectable()
export class SupportPortAdapter implements SupportPort {
  private readonly logger = new Logger(SupportPortAdapter.name);

  constructor(private readonly tickets: SupportTicketsService) {}

  async raiseBillingTicket(ticket: BillingTicket): Promise<void> {
    try {
      const raised = await this.tickets.raiseSystemTicket({
        systemKey: `unpaid_cash:${ticket.bookingId}`,
        category: 'billing',
        // High rather than urgent: money is outstanding, but nobody is unsafe
        // and the Pro has already been made whole.
        priority: 'high',
        bookingId: ticket.bookingId,
        customerId: ticket.customerId,
        proId: ticket.proId,
        subject: systemSubject('Unpaid cash job', ticket.bookingId),
        body:
          `The job completed with ₹${ticket.amount} uncollected. ` +
          `Reason recorded on the booking: ${ticket.reason}\n\n` +
          'The Pro has already been paid their commission — feature 17. This ' +
          'is a collection question, not a pay question.',
        contextJson: {
          amount: ticket.amount,
          reason: ticket.reason,
          proId: ticket.proId,
          customerId: ticket.customerId,
        },
      });

      if (!raised)
        this.logger.log(
          `Billing ticket for booking ${ticket.bookingId} already exists.`,
        );
    } catch (error) {
      // Same shape as the stub it replaces. A cash job that could not raise a
      // ticket must still be a completed job.
      this.logger.error(
        `Could not raise the billing ticket for booking ${ticket.bookingId}: ` +
          (error instanceof Error ? error.message : 'unknown error'),
      );
    }
  }
}
