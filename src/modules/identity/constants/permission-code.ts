/**
 * Every permission code any admin-mutating endpoint in this pass checks.
 * `Role.permissionCodes` holds a subset of these as a json string array —
 * add here first whenever a new guarded admin endpoint is introduced.
 */
export const PermissionCode = {
  ROLE_MANAGE: 'identity.role.manage',
  ADMIN_USER_MANAGE: 'identity.adminUser.manage',
  CUSTOMER_MODERATE: 'customer.moderate',
  PRO_APPLICATION_REVIEW: 'pro.application.review',
  PRO_MODERATE: 'pro.moderate',
  PRO_AVAILABILITY_SET: 'pro.availability.set',
  /**
   * Reading and vouching for a Pro's payout destination. Separate from
   * PRO_MODERATE because it is finance's call, not ops': the account details
   * only matter when money leaves, and an ops admin editing a roster should
   * not see or bless them as a side effect.
   */
  PRO_BANK_VERIFY: 'pro.bankAccount.verify',
  CATALOG_MANAGE: 'catalog.manage',
  /**
   * Deliberately separate from CATALOG_MANAGE: repricing a service and
   * changing what a Pro earns from it are different decisions with different
   * owners (US-3.10, US-8.4). An ops admin editing a price should not be able
   * to move the commission rate as a side effect.
   */
  CATALOG_COMMISSION_SET: 'catalog.commission.set',
  CATALOG_CITY_MANAGE: 'catalog.city.manage',
  BOOKING_READ: 'booking.read',
  BOOKING_CANCEL: 'booking.cancel',
  /**
   * Starting a job without the customer's OTP. Its own code because the OTP is
   * the trust anchor: it is the only evidence a dispute has that work began
   * with consent, and bypassing it should be a deliberate grant, not something
   * that rides along with general booking access.
   */
  BOOKING_FORCE_START: 'booking.force_start',
  /** Manual assignment from the live dispatch screen. */
  DISPATCH_OVERRIDE: 'dispatch.override',
  /** Reading orders, the live attempt list and the reconciliation report. */
  PAYMENT_READ: 'payment.read',
  /**
   * Sending money back to a customer. Deliberately separate from
   * `BOOKING_CANCEL`, which decides *what is owed* — an ops admin cancelling a
   * job should not be able to move money out of the platform as a side effect
   * of that decision. Module 4 computes the amount; this grant executes it.
   */
  PAYMENT_REFUND: 'payment.refund',
  /**
   * Counting a Pro's cash and clearing their balance. The second half of the
   * only two-person control in the cash flow, so it is its own grant: whoever
   * confirms a handover must not be the person who declared it.
   */
  CASH_HANDOVER_CONFIRM: 'payment.cash.handover.confirm',

  // --- Module 8 · Commission & Payouts --------------------------------
  //
  // Four grants where one would have done, because this is the largest
  // outbound money movement in the system (US-8.10) and the failure modes are
  // different at each step.

  /** Reading commissions, payout batches and the finance dashboard. */
  PAYOUT_READ: 'payout.read',
  /**
   * Saying a batch is correct, and generating batches in the first place.
   * Approval **does not send money** — that is a separate grant below.
   */
  PAYOUT_APPROVE: 'payout.approve',
  /**
   * Actually moving the money to a Pro's bank. Deliberately separate from
   * `PAYOUT_APPROVE` and ideally held by a different person: this is the one
   * action in the API that sends funds out of the platform, and an approver
   * who can also disburse is a one-person control over the largest payment we
   * make.
   */
  PAYOUT_DISBURSE: 'payout.disburse',
  /**
   * Reversing a commission, raising a manual deduction, waiving one. The only
   * way anywhere in this API to reduce what a Pro is owed, so it does not ride
   * along with the ability to read a list.
   */
  PAYOUT_ADJUST: 'payout.adjust',
  /** Configuring bonus schemes. Changes future pay, never past pay. */
  INCENTIVE_MANAGE: 'incentive.manage',

  // --- Module 9 · Ledger & Reconciliation -----------------------------

  /**
   * Reading the books, account balances and the finance dashboard. Safe:
   * there is no route anywhere that appends, edits or deletes an entry.
   */
  LEDGER_READ: 'ledger.read',
  /**
   * Starting a reconciliation run and closing a discrepancy. Moves no money,
   * but deciding that a variance has been explained is a judgement that should
   * carry a name — which is why it is not folded into `ledger.read`.
   */
  LEDGER_AUDIT: 'ledger.audit',

  // --- Module 10 · Training & Reviews ---------------------------------
  //
  // Two grants, where module 8 needed four. Nothing here moves money, and the
  // worst outcome an over-granted admin can produce is a badly written
  // training module — recoverable by editing it.

  /**
   * Training content, offline sessions, enrolment, attendance, and clearing a
   * Pro's exhausted quiz attempts. Reading a Pro's progress rides on
   * `pro.moderate`, which ops already holds.
   */
  TRAINING_MANAGE: 'training.manage',
  /**
   * Hiding a review, restoring one, and reading the customer feedback screen.
   *
   * Its own grant rather than part of `pro.moderate` because hiding decides
   * what the public sees about a Pro whose income depends on it, and the
   * feedback screen is the one place a household's private history is
   * assembled in one view.
   */
  REVIEW_MODERATE: 'review.moderate',

  // --- Module 15 · Admin Console & Reporting --------------------------
  ADMIN_DASHBOARD_READ: 'admin.dashboard.read',
  CUSTOMER_READ: 'customer.read',
  PRO_READ: 'pro.read',
  DISPATCH_READ: 'dispatch.read',
  ADMIN_JOB_READ: 'admin.job.read',
  ADMIN_BULK_EXECUTE: 'admin.bulk.execute',
  REPORT_EXPORT: 'report.export',
  REPORT_ANALYTICS_READ: 'report.analytics.read',
  PLATFORM_SETTING_READ: 'platformSetting.read',
  PLATFORM_SETTING_MANAGE: 'platformSetting.manage',
  UI_CONFIG_READ: 'uiConfig.read',
  UI_CONFIG_MANAGE: 'uiConfig.manage',
  UI_CONFIG_PUBLISH: 'uiConfig.publish',

  // --- Module 12 · Notifications -------------------------------------
  NOTIFICATION_READ: 'notification.read',
  NOTIFICATION_TEMPLATE_MANAGE: 'notification.template.manage',
  NOTIFICATION_RETRY: 'notification.retry',
} as const;

export type PermissionCode =
  (typeof PermissionCode)[keyof typeof PermissionCode];

export const ALL_PERMISSION_CODES: PermissionCode[] =
  Object.values(PermissionCode);

export const SYSTEM_ROLE_NAMES = [
  'ops',
  'support',
  'finance',
  'super_admin',
] as const;
