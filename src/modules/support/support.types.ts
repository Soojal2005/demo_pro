/**
 * Module 11 · Safety & Support — the vocabularies, and the two rules that
 * every read path in this module is built around.
 *
 * ## Rule 1 — an SOS is not a ticket
 *
 * Feature 5 says "SOS alerts bypass normal ticket queuing". That is not a
 * priority flag on a shared queue; it is a separate table, a separate route
 * and a separate permission. An alert cannot end up behind a billing question
 * because somebody mis-set a field, because there is no field to mis-set.
 *
 * ## Rule 2 — internal means invisible, in the `where` clause
 *
 * `SupportTicket.isInternal` hides a whole ticket; `TicketMessage.isInternalNote`
 * hides one message. Both are applied as query predicates, never as a filter
 * over loaded rows — so a later `include` cannot leak what the current code
 * happens to drop.
 */

export const SOS_RAISER_TYPES = ['customer', 'pro'] as const;
export type SosRaiserType = (typeof SOS_RAISER_TYPES)[number];

export const SOS_STATUSES = [
  'open',
  'acknowledged',
  'resolved',
  'false_alarm',
] as const;
export type SosStatus = (typeof SOS_STATUSES)[number];

/** How an alert may be closed. `acknowledged` is a step, not an outcome. */
export const SOS_OUTCOMES = ['resolved', 'false_alarm'] as const;
export type SosOutcome = (typeof SOS_OUTCOMES)[number];

export const TICKET_RAISER_TYPES = ['customer', 'pro', 'system'] as const;
export type TicketRaiserType = (typeof TICKET_RAISER_TYPES)[number];

export const TICKET_CATEGORIES = [
  'billing',
  'quality',
  'dispute',
  'app_issue',
  'no_start',
] as const;
export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/**
 * What a customer or a Pro may file for themselves.
 *
 * `no_start` is absent, and its absence is enforced at the DTO. It is a
 * system-detected exception by definition — a raiser able to file one would
 * produce a ticket that looks system-raised and is not, which is exactly the
 * confusion the `isInternal` rule exists to avoid.
 */
export const SELF_SERVICE_CATEGORIES = [
  'billing',
  'quality',
  'dispute',
  'app_issue',
] as const;
export type SelfServiceCategory = (typeof SELF_SERVICE_CATEGORIES)[number];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export const TICKET_STATUSES = [
  'open',
  'in_progress',
  'escalated',
  'resolved',
  'closed',
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Statuses that still accept a reply from either side. */
export const TICKET_OPEN_STATUSES = [
  'open',
  'in_progress',
  'escalated',
  'resolved',
] as const;

/**
 * The consequence recorded on a ticket at close.
 *
 * A **record of a decision, not an instruction.** Suspending a Pro is module
 * 6's endpoint, called separately by the same admin. Writing the string here
 * *and* moving `Pro.status` from here would give the codebase two writers for
 * one rule — the shape of CONFLICTS_AND_DECISIONS #33.
 */
export const TICKET_ACTIONS = [
  'none',
  'warning',
  'retraining',
  'service_suspended',
  'suspended',
] as const;
export type TicketAction = (typeof TICKET_ACTIONS)[number];

export const MESSAGE_SENDER_TYPES = [
  'customer',
  'pro',
  'admin',
  'system',
] as const;
export type MessageSenderType = (typeof MESSAGE_SENDER_TYPES)[number];

// ---------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------

export const SUPPORT_SETTINGS = {
  /**
   * Minutes after arrival before a job that has not started is an incident.
   *
   * **Already defined and already validated** in module 15's platform-setting
   * definitions (1–240), and read by nothing until now. The no-start sweep is
   * its first consumer — see MODULE_STATUS_REPORT §4, feature 14.
   */
  noStartGraceMinutes: { key: 'no_start.graceWindowMinutes', fallback: 30 },
} as const;

// ---------------------------------------------------------------------
// The SOS context snapshot
// ---------------------------------------------------------------------

/**
 * What ops sees when an alert opens, frozen at the moment the button was
 * pressed and never re-derived.
 *
 * By the time an admin opens the alert the booking may be cancelled,
 * reassigned or completed. A live join would answer a different question than
 * the one being asked — the same reasoning behind module 8's commission-rate
 * snapshotting.
 *
 * Phone numbers are here on purpose. An admin responding to a safety alert
 * needs to call someone, and making them open two more screens to find the
 * number is the failure this field exists to prevent. Access is gated on
 * `safety.sos.respond`.
 */
export interface SosContextSnapshot {
  bookingId: string | null;
  bookingNumber: string | null;
  bookingStatus: string | null;
  serviceName: string | null;
  cityId: string | null;
  scheduledFor: string | null;
  arrivedAt: string | null;
  startedAt: string | null;
  addressText: string | null;
  addressLat: number | null;
  addressLng: number | null;
  customer: { id: string; name: string | null; phone: string | null } | null;
  pro: {
    id: string;
    name: string | null;
    phone: string | null;
    employeeCode: string | null;
  } | null;
  /** Filled only when the alert carries no pin of its own. */
  capturedAt: string;
}

// ---------------------------------------------------------------------
// Notification event and template keys
// ---------------------------------------------------------------------

/**
 * Note what is absent: there is no `support.no_start.*` key addressed to a
 * Pro. That absence **is** feature 13, and `no-start-detector.service.spec.ts`
 * asserts it rather than trusting it.
 */
export const SUPPORT_EVENTS = {
  sosRaised: 'safety.sos.raised',
  sosAcknowledged: 'safety.sos.acknowledged',
  ticketRaised: 'support.ticket.raised',
  ticketReplied: 'support.ticket.replied',
  ticketResolved: 'support.ticket.resolved',
} as const;

export const SUPPORT_TEMPLATES = {
  /**
   * **Reuses the key that was already deployed**, rather than introducing a
   * near-duplicate.
   *
   * `safety.sos_created` already existed in the notification_templates table —
   * critical, push + SMS, addressed to scoped admins — seeded ahead of this
   * module by whoever anticipated it. Adding `safety.sos_raised` beside it
   * would have left two rows meaning the same event, with ops editing one and
   * the code sending the other.
   */
  sosRaisedAdmin: 'safety.sos_created',
  sosAcknowledgedRaiser: 'safety.sos_acknowledged',
  ticketRaisedAdmin: 'support.ticket_raised',
  ticketRepliedRaiser: 'support.ticket_replied',
  ticketResolvedRaiser: 'support.ticket_resolved',
} as const;

/**
 * Builds the system's half of a ticket subject.
 *
 * Ops scans a list; a subject that reads "no_start" and nothing else forces a
 * click per row to find out which job it is about.
 */
export function systemSubject(prefix: string, reference: string): string {
  return `${prefix} — ${reference}`;
}
