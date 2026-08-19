/**
 * Seed data module 11 needs to be exercisable over cURL against the cloud DB.
 *
 * Idempotent throughout — safe to re-run. Everything it creates is namespaced
 * so it can be identified and removed later.
 */
const path = require('path');
const { Client } = require('pg');
const repo = 'c:/Users/lnc/New folder (3)/Homingo';
require('dotenv').config({ path: path.join(repo, '.env.local') });
require('dotenv').config({ path: path.join(repo, '.env') });

const CITY = '00000000-0000-4000-9000-000000000001'; // Indore
const NEW_CODES = [
  'safety.sos.read',
  'safety.sos.respond',
  'support.ticket.read',
  'support.ticket.manage',
];

const TEMPLATES = [
  {
    key: 'safety.sos_created',
    description: 'SOS raised — to every on-duty responder.',
    eventType: 'safety.sos_created',
    isCritical: true,
    channels: ['push', 'sms'],
    pushTitle: 'SOS — immediate response needed',
    pushBody:
      'A {{raisedBy}} raised an SOS on booking {{bookingNumber}} at {{addressLine}}.',
    smsBody:
      'HOMINGO SOS: {{raisedBy}} on booking {{bookingNumber}}, {{addressLine}}. Open the ops console now.',
    allowedVariables: ['alertId', 'raisedBy', 'bookingNumber', 'addressLine', 'lat', 'lng'],
  },
  {
    key: 'safety.sos_acknowledged',
    description: 'Tells the raiser somebody is on it.',
    eventType: 'safety.sos_acknowledged',
    isCritical: true,
    channels: ['push', 'sms'],
    pushTitle: 'We have your alert',
    pushBody: 'Our safety team has your alert and is responding now.',
    smsBody: 'Homingo: our safety team has your alert and is responding now.',
    allowedVariables: ['alertId'],
  },
  {
    key: 'support.ticket_raised',
    description: 'New ticket — to the support queue.',
    eventType: 'support.ticket_raised',
    isCritical: false,
    channels: ['push'],
    pushTitle: 'New support ticket',
    pushBody: '{{category}}: {{subject}}',
    smsBody: null,
    allowedVariables: ['ticketId', 'category', 'subject'],
  },
  {
    key: 'support.ticket_replied',
    description: 'Support replied — to the raiser.',
    eventType: 'support.ticket_replied',
    isCritical: false,
    channels: ['push'],
    pushTitle: 'Support replied',
    pushBody: 'There is a new reply on "{{subject}}".',
    smsBody: null,
    allowedVariables: ['ticketId', 'subject'],
  },
  {
    key: 'support.ticket_resolved',
    description: 'Ticket resolved — to the raiser.',
    eventType: 'support.ticket_resolved',
    isCritical: false,
    channels: ['push'],
    pushTitle: 'Your ticket is resolved',
    pushBody: '"{{subject}}" has been resolved. Reply if it is not settled.',
    allowedVariables: ['ticketId', 'subject'],
    smsBody: null,
  },
];

(async () => {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query('BEGIN');

  try {
    // ----------------------------------------------------------------
    // 1 · Permission codes on the roles that need them
    // ----------------------------------------------------------------
    const grants = {
      ops: ['safety.sos.read', 'safety.sos.respond', 'support.ticket.read'],
      support: NEW_CODES,
      finance: ['support.ticket.read'],
      super_admin: NEW_CODES,
    };

    for (const [role, codes] of Object.entries(grants)) {
      const { rows } = await c.query(
        'SELECT id, "permissionCodes" FROM roles WHERE name = $1',
        [role],
      );
      if (!rows.length) {
        console.log(`  ! role ${role} not found, skipped`);
        continue;
      }
      const existing = Array.isArray(rows[0].permissionCodes)
        ? rows[0].permissionCodes
        : [];
      const merged = [...new Set([...existing, ...codes])];
      await c.query(
        'UPDATE roles SET "permissionCodes" = $1, "updatedAt" = now() WHERE id = $2',
        [JSON.stringify(merged), rows[0].id],
      );
      console.log(
        `  ✔ ${role}: +${merged.length - existing.length} code(s) (${merged.length} total)`,
      );
    }

    // ----------------------------------------------------------------
    // 2 · Notification templates
    // ----------------------------------------------------------------
    for (const t of TEMPLATES) {
      const { rowCount } = await c.query(
        'SELECT 1 FROM notification_templates WHERE key = $1',
        [t.key],
      );
      if (rowCount) {
        // Do not clobber wording ops may have edited; only widen the
        // variable list so the richer payload renders.
        await c.query(
          `UPDATE notification_templates
             SET "allowedVariables" = $2, "isActive" = true, "updatedAt" = now()
           WHERE key = $1`,
          [t.key, JSON.stringify(t.allowedVariables)],
        );
        console.log(`  = template ${t.key} already existed, variables widened`);
      } else {
        await c.query(
          `INSERT INTO notification_templates
             (key, description, "eventType", "isActive", "isCritical", channels,
              "pushTitle", "pushBody", "smsBody", "allowedVariables", "updatedAt")
           VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8,$9, now())`,
          [
            t.key,
            t.description,
            t.eventType,
            t.isCritical,
            JSON.stringify(t.channels),
            t.pushTitle,
            t.pushBody,
            t.smsBody,
            JSON.stringify(t.allowedVariables),
          ],
        );
        console.log(`  + template ${t.key} created`);
      }
    }

    // ----------------------------------------------------------------
    // 3 · The grace window, set small so the sweep is demonstrable
    // ----------------------------------------------------------------
    // The global value already exists at 15. Indore is given a deliberately
    // LARGER override — 120 — so the first sweep proves the city value is the
    // one being read: a 90-minute-old arrival fires under the global 15 and
    // must NOT fire under the city's 120. Dropping Indore to 15 afterwards
    // makes it fire, which is the other half of the same proof.
    const { rows: g } = await c.query(
      `SELECT value FROM platform_settings
       WHERE key='no_start.graceWindowMinutes' AND "cityId" IS NULL`,
    );
    console.log(`  = global no_start.graceWindowMinutes = ${g[0]?.value ?? '(unset)'}`);

    await c.query(
      `INSERT INTO platform_settings (id, key, value, description, "cityId", "createdAt", "updatedAt")
       VALUES (gen_random_uuid(),'no_start.graceWindowMinutes','120',
               'Indore override — proves the no-start sweep is city-scoped.', $1, now(), now())
       ON CONFLICT DO NOTHING`,
      [CITY],
    );
    await c.query(
      `UPDATE platform_settings SET value='120', "updatedAt"=now()
       WHERE key='no_start.graceWindowMinutes' AND "cityId"=$1`,
      [CITY],
    );
    console.log('  ✔ Indore no_start.graceWindowMinutes = 120 (larger than global on purpose)');

    // ----------------------------------------------------------------
    // 4 · A booking stuck at `arrived`, backdated past the window
    // ----------------------------------------------------------------
    const { rows: party } = await c.query(
      `SELECT c.id AS customer_id, a.id AS address_id
       FROM customers c JOIN customer_addresses a ON a."customerId"=c.id
       WHERE c.phone = '+919000000123' LIMIT 1`,
    );
    const { rows: pro } = await c.query(
      `SELECT id FROM pros WHERE "employeeCode"='HG-D003' LIMIT 1`,
    );
    const { rows: svc } = await c.query(
      `SELECT id, "flatPrice" FROM services WHERE "isActive"=true LIMIT 1`,
    );

    if (party.length && pro.length && svc.length) {
      const { rows: existing } = await c.query(
        `SELECT id, "bookingNumber" FROM bookings WHERE "bookingNumber"='HB-M11-NOSTART'`,
      );
      if (existing.length) {
        // Re-arm it: push arrival back so the sweep fires again on re-run.
        await c.query(
          `UPDATE bookings
             SET status='arrived', "startedAt"=NULL, "cancelledAt"=NULL,
                 "arrivedAt"=now() - interval '90 minutes', "updatedAt"=now()
           WHERE id=$1`,
          [existing[0].id],
        );
        // Clear any incident from a previous run so it can be raised again.
        await c.query(
          `DELETE FROM support_tickets WHERE "systemKey"=$1`,
          [`no_start:${existing[0].id}`],
        );
        console.log(
          `  = re-armed booking HB-M11-NOSTART (${existing[0].id}), arrived 90m ago`,
        );
        console.log(`BOOKING_NOSTART=${existing[0].id}`);
      } else {
        const { rows: created } = await c.query(
          // `id` has no database default here — Prisma generates uuids
          // client-side — so the seed supplies one.
          `INSERT INTO bookings
             (id,"bookingNumber","customerId","serviceId","addressId","bookingType",
              "flatPrice","paymentMode","paymentStatus","status","proId",
              "assignedAt","arrivedAt","startOtpAttempts","createdAt","updatedAt")
           VALUES (gen_random_uuid(),'HB-M11-NOSTART',$1,$2,$3,'instant',$4,'cash','unpaid','arrived',$5,
                   now() - interval '2 hours', now() - interval '90 minutes', 2, now(), now())
           RETURNING id`,
          [party[0].customer_id, svc[0].id, party[0].address_id, svc[0].flatPrice, pro[0].id],
        );
        console.log(
          `  + booking HB-M11-NOSTART (${created[0].id}) at 'arrived', arrived 90m ago`,
        );
        console.log(`BOOKING_NOSTART=${created[0].id}`);
      }
      console.log(`CUSTOMER_ID=${party[0].customer_id}`);
      console.log(`PRO_ID=${pro[0].id}`);
    } else {
      console.log('  ! could not resolve customer/pro/service for the no-start booking');
    }

    // ----------------------------------------------------------------
    // 5 · A completed booking the dispute-evidence bundle can reconstruct
    // ----------------------------------------------------------------
    const { rows: done } = await c.query(
      `SELECT id, "bookingNumber" FROM bookings
       WHERE status='completed' ORDER BY "completedAt" DESC NULLS LAST LIMIT 1`,
    );
    if (done.length) {
      console.log(`BOOKING_COMPLETED=${done[0].id}  (${done[0].bookingNumber})`);
    }

    await c.query('COMMIT');
    console.log('\nSeed committed.');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
})().catch((e) => {
  console.error('FAILED:', e.message, e.detail ?? '');
  process.exit(1);
});
