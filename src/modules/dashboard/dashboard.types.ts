/**
 * A count and what it was `days` ago, so the console can show growth without
 * inventing it. Both figures are real reads — there is no stored trend.
 */
export interface Trend {
  current: number;
  previous: number;
}

/**
 * Work waiting on a person right now.
 *
 * Every number here means somebody is blocked: a customer with no Pro, a Pro
 * standing at a desk with banknotes, an applicant who cannot start earning.
 * They are separated from the totals below because a total is something you
 * read and a queue is something you clear.
 */
export interface NeedsAttention {
  /** Dispatch tried and could not place these. */
  stuckBookings: number;
  /** Declared by a Pro, waiting for an admin to count. */
  cashHandoversPending: number;
  /** KYC queue — not yet decided. */
  applicationsWaiting: number;
  /** Money that did not reach a Pro's bank. */
  payoutsFailed: number;
  /** Low-rated reviews nobody has looked at. */
  reviewsToModerate: number;
}

export interface DashboardTotals {
  customers: Trend;
  pros: Trend;
  bookings: Trend;
  completedBookings: Trend;
}

export interface BookingBreakdown {
  upcoming: number;
  ongoing: number;
  completed: number;
  cancelled: number;
}

export interface ApplicationBreakdown {
  pending: number;
  docsReview: number;
  callPending: number;
  changesRequested: number;
  approved: number;
  rejected: number;
}

/** One column of the activity chart. */
export interface DailyBookings {
  /** `YYYY-MM-DD`, in the deployment's own timezone. */
  date: string;
  upcoming: number;
  ongoing: number;
  completed: number;
  cancelled: number;
}

export interface MoneySnapshot {
  collectedToday: string;
  refundedToday: string;
  netToday: string;
  grossRevenue: string;
  owedToPros: string;
  cashHeldByPros: string;
}

/**
 * Sections are optional because the caller's role decides which ones exist.
 *
 * Omission is the permission model here: an ops admin has no business reading
 * revenue, and the alternative — one grant guarding the whole endpoint — would
 * make the entire dashboard a 403 for everyone except a super admin.
 */
export interface DashboardSummary {
  days: number;
  needsAttention: Partial<NeedsAttention>;
  totals: Partial<DashboardTotals>;
  bookings?: BookingBreakdown;
  applications?: ApplicationBreakdown;
  chart?: DailyBookings[];
  money?: MoneySnapshot;
}

/**
 * Which booking statuses count as which bucket.
 *
 * `upcoming` deliberately includes `awaiting_payment`: to an operator that
 * booking is coming, it just has not been paid for yet.
 */
export const UPCOMING_STATUSES = [
  'created',
  'awaiting_payment',
  'assigning',
  'assigned',
] as const;

export const ONGOING_STATUSES = ['en_route', 'arrived', 'started'] as const;
