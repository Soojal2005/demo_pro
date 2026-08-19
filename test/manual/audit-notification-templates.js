/**
 * Cross-checks every template key the code can enqueue against the rows that
 * actually exist on the cloud DB. An outbox row whose key has no template row
 * is failed by the worker, so a missing key is a silent delivery hole.
 *
 * Keys delivered through `recordOtpDelivery` are excluded: that path writes a
 * NotificationLog directly and never looks a template up.
 */
const path = require('path');
const { Client } = require('pg');
const repo = 'c:/Users/lnc/New folder (3)/Homingo';
require('dotenv').config({ path: path.join(repo, '.env.local') });
require('dotenv').config({ path: path.join(repo, '.env') });

// Everything reachable via NotificationsService.enqueue().
const ENQUEUED = [
  // booking-state.service.ts templateByStatus
  'booking.pro_assigned',
  'booking.pro_en_route',
  'booking.pro_arrived',
  'booking.started',
  'booking.completed',
  'booking.cancelled',
  'booking.pro_reassigned',
  // literal call sites
  'booking.assignment_confirmed',
  'dispatch.assignment_offered',
  'commission.payout_processed',
  'commission.payout_failed',
  // module 11
  'safety.sos_created',
  'safety.sos_acknowledged',
  'support.ticket_raised',
  'support.ticket_replied',
  'support.ticket_resolved',
];

// Delivered by the provider directly; logged, never enqueued.
const OTP_ONLY = ['auth.otp', 'booking.start_otp'];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  const { rows } = await c.query(
    'SELECT key, "isActive" FROM notification_templates',
  );
  const have = new Map(rows.map((r) => [r.key, r.isActive]));

  const missing = ENQUEUED.filter((k) => !have.has(k));
  const inactive = ENQUEUED.filter((k) => have.get(k) === false);
  const orphans = [...have.keys()].filter(
    (k) => !ENQUEUED.includes(k) && !OTP_ONLY.includes(k),
  );

  console.log(`templates on the cloud DB : ${have.size}`);
  console.log(`keys the code can enqueue : ${ENQUEUED.length}`);
  console.log(
    `\nmissing (would fail at the worker): ${missing.length ? missing.join(', ') : 'none'}`,
  );
  console.log(`inactive: ${inactive.length ? inactive.join(', ') : 'none'}`);
  console.log(
    `rows nothing enqueues: ${orphans.length ? orphans.join(', ') : 'none'}`,
  );
  console.log(
    `\nOTP keys, correctly template-less: ${OTP_ONLY.filter((k) => !have.has(k)).join(', ') || '(all have rows anyway)'}`,
  );

  await c.end();
  process.exit(missing.length || inactive.length ? 1 : 0);
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
