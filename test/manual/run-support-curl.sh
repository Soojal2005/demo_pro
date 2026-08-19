#!/usr/bin/env bash
# Module 11 (Safety & Support) + module 12 (Notifications) over live HTTP,
# against the AWS RDS cloud database.
#
# Every assertion is on the real response body. Nothing is mocked.

BASE="http://127.0.0.1:3000/api/v1"
PASS=0; FAIL=0
CUSTOMER_PHONE="+919000000123"
PRO_PHONE="+919800000003"
ADMIN_PHONE="+916266941709"
BOOKING_NOSTART="15818abb-ed28-4745-baea-aff76657dbc4"
BOOKING_COMPLETED="df546083-1dbe-43f8-af47-116f91a73aec"

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()   { PASS=$((PASS+1)); printf '  \033[32m✔\033[0m %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  \033[31m✘\033[0m %s\n     got: %s\n' "$1" "$2"; }

# assert <label> <expected-substring> <actual>
assert() { case "$3" in *"$2"*) ok "$1";; *) bad "$1" "$(echo "$3" | head -c 400)";; esac; }
# refute <label> <forbidden-substring> <actual>
refute() { case "$3" in *"$2"*) bad "$1 (found '$2')" "$(echo "$3" | head -c 400)";; *) ok "$1";; esac; }

jqv() { echo "$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const p='$2'.split('.');let v=j;for(const k of p)v=v?.[k];console.log(typeof v==='object'?JSON.stringify(v):(v??''))}catch(e){console.log('')}})"; }

login() { # login <phone> <actorType> -> access token on stdout
  local ref tok
  ref=$(curl -s -X POST "$BASE/auth/otp/request" -H 'Content-Type: application/json' \
        -d "{\"phone\":\"$1\",\"actorType\":\"$2\"}")
  ref=$(jqv "$ref" "data.providerRef")
  [ -z "$ref" ] && { echo ""; return; }
  tok=$(curl -s -X POST "$BASE/auth/otp/verify" -H 'Content-Type: application/json' \
        -d "{\"phone\":\"$1\",\"code\":\"123456\",\"actorType\":\"$2\",\"providerRef\":\"$ref\"}")
  jqv "$tok" "data.accessToken"
}

say "0 · Authenticating three actors against the cloud DB"
# OTP is rate-limited to 5 requests/hour/phone, so tokens are cached between
# runs of this script rather than re-minted on every pass.
CACHE="$(dirname "$0")/tokens.env"
if [ -f "$CACHE" ] && \
   curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/sos" \
        -H "Authorization: Bearer $(grep '^ADMIN=' "$CACHE" | cut -d= -f2-)" | grep -q 200; then
  . "$CACHE"
  echo "  (reusing cached tokens)"
else
  CUST=$(login "$CUSTOMER_PHONE" customer)
  PRO=$(login "$PRO_PHONE" pro)
  ADMIN=$(login "$ADMIN_PHONE" admin)
  { echo "CUST=$CUST"; echo "PRO=$PRO"; echo "ADMIN=$ADMIN"; } > "$CACHE"
fi
[ -n "$CUST" ]  && ok "customer token" || bad "customer token" "empty"
[ -n "$PRO" ]   && ok "pro token"      || bad "pro token" "empty"
[ -n "$ADMIN" ] && ok "admin token"    || bad "admin token" "empty"
[ -z "$ADMIN" ] && { echo "Cannot continue without an admin token."; exit 1; }

CH="-H Content-Type:application/json -H Authorization:Bearer\ $CUST"
AUTH_C=(-H "Content-Type: application/json" -H "Authorization: Bearer $CUST")
AUTH_P=(-H "Content-Type: application/json" -H "Authorization: Bearer $PRO")
AUTH_A=(-H "Content-Type: application/json" -H "Authorization: Bearer $ADMIN")

# =====================================================================
say "1 · SOS — customer, one tap, no coordinates at all"
# =====================================================================
R=$(curl -s -X POST "$BASE/customers/me/sos" "${AUTH_C[@]}" -d '{}')
assert "an empty body is accepted (a phone with no GPS fix must still work)" '"success":true' "$R"
SOS1=$(jqv "$R" "data.id")
assert "alert is open" '"status":"open"' "$R"

say "2 · SOS — customer, with a booking and a live pin"
R=$(curl -s -X POST "$BASE/customers/me/sos" "${AUTH_C[@]}" \
    -d "{\"bookingId\":\"$BOOKING_NOSTART\",\"lat\":22.7196,\"lng\":75.8577,\"note\":\"cURL cloud test\"}")
assert "accepted with booking + pin" '"success":true' "$R"
SOS2=$(jqv "$R" "data.id")
SNAP=$(jqv "$R" "data.contextSnapshot")
assert "snapshot froze the booking number"  'HB-M11-NOSTART' "$SNAP"
assert "snapshot froze the address"         'addressText' "$SNAP"
assert "snapshot carries the customer phone" "$CUSTOMER_PHONE" "$SNAP"
assert "snapshot carries the Pro phone"      "$PRO_PHONE" "$SNAP"

say "3 · SOS — ownership is checked"
R=$(curl -s -X POST "$BASE/customers/me/sos" "${AUTH_C[@]}" \
    -d "{\"bookingId\":\"$BOOKING_COMPLETED\"}")
assert "a booking the customer does not own returns 404, not 403" '"statusCode":404' "$R"

say "4 · SOS — the Pro side is symmetric"
R=$(curl -s -X POST "$BASE/pros/me/sos" "${AUTH_P[@]}" -d '{"lat":22.72,"lng":75.86}')
assert "Pro can raise an SOS" '"success":true' "$R"
assert "recorded as raised by the Pro" '"raisedByType":"pro"' "$R"
SOS3=$(jqv "$R" "data.id")

say "5 · SOS — what the raiser is allowed to see back"
R=$(curl -s "$BASE/customers/me/sos" "${AUTH_C[@]}")
assert "customer can list their own alerts" '"success":true' "$R"
refute "the frozen snapshot is NOT returned to the raiser" 'contextSnapshot' "$R"
refute "ops resolution notes are NOT returned to the raiser" 'resolutionNotes' "$R"

# =====================================================================
say "6 · SOS — the ops queue"
# =====================================================================
R=$(curl -s "$BASE/admin/sos" "${AUTH_A[@]}")
assert "admin can read the queue" '"success":true' "$R"
assert "queue exposes responseSeconds" 'responseSeconds' "$R"

R=$(curl -s -X POST "$BASE/admin/sos/$SOS2/resolve" "${AUTH_A[@]}" \
    -d '{"outcome":"resolved","resolutionNotes":"premature"}')
assert "closing before acknowledging is refused with 409" '"statusCode":409' "$R"

R=$(curl -s -X POST "$BASE/admin/sos/$SOS2/acknowledge" "${AUTH_A[@]}" -d '{}')
assert "acknowledge succeeds" '"status":"acknowledged"' "$R"
FIRST_ACK=$(jqv "$R" "data.acknowledgedAt")

R=$(curl -s -X POST "$BASE/admin/sos/$SOS2/acknowledge" "${AUTH_A[@]}" -d '{}')
SECOND_ACK=$(jqv "$R" "data.acknowledgedAt")
[ "$FIRST_ACK" = "$SECOND_ACK" ] \
  && ok "acknowledge is idempotent — the first timestamp survives" \
  || bad "acknowledge rewrote the timestamp" "$FIRST_ACK vs $SECOND_ACK"

R=$(curl -s -X POST "$BASE/admin/sos/$SOS2/resolve" "${AUTH_A[@]}" \
    -d '{"outcome":"false_alarm","resolutionNotes":"Pocket tap; customer confirmed fine."}')
assert "false_alarm is a real outcome" '"status":"false_alarm"' "$R"

R=$(curl -s -X POST "$BASE/admin/sos/$SOS2/resolve" "${AUTH_A[@]}" \
    -d '{"outcome":"resolved","resolutionNotes":"again"}')
assert "closing twice is refused" '"statusCode":409' "$R"

# =====================================================================
say "7 · Notifications — module 12, driven by module 11's events"
# =====================================================================
R=$(curl -s "$BASE/admin/notifications/templates" "${AUTH_A[@]}")
assert "template registry readable"          '"success":true' "$R"
assert "safety.sos_created is registered"    'safety.sos_created' "$R"
assert "safety.sos_acknowledged registered"  'safety.sos_acknowledged' "$R"
assert "support.ticket_raised registered"    'support.ticket_raised' "$R"
assert "support.ticket_replied registered"   'support.ticket_replied' "$R"
assert "support.ticket_resolved registered"  'support.ticket_resolved' "$R"
refute "no duplicate safety.sos_raised key was introduced" 'safety.sos_raised' "$R"

R=$(curl -s "$BASE/admin/notifications/bookings/$BOOKING_NOSTART" "${AUTH_A[@]}")
assert "per-booking notification history responds" '"success":true' "$R"
assert "the SOS produced a delivery record for this booking" 'safety.sos_created' "$R"

R=$(curl -s "$BASE/admin/notifications" "${AUTH_A[@]}")
assert "notification log readable" '"success":true' "$R"
assert "the log rendered the template body, not the raw {{ }}" 'SOS raised for booking' "$R"
refute "no unrendered placeholder leaked into a payload" '{{bookingNumber}}' "$R"

# The SOS template is push+sms and no admin has a push token, so the push leg
# must be recorded as skipped rather than silently dropped.
assert "a channel with no target is recorded, not dropped" 'skipped' "$R"

# A partial PATCH that changes ONE field and omits the rest. This is the
# regression: ES2023 class fields made every omitted DTO property an own key
# valued undefined, which blanked pushTitle/pushBody in the validation merge
# and produced a bogus "Push templates require title and body".
R=$(curl -s -X PATCH "$BASE/admin/notifications/templates/support.ticket_replied" "${AUTH_A[@]}" \
    -d '{"isActive":true}')
assert "a partial PATCH keeps the fields the caller omitted" '"success":true' "$R"
refute "and does NOT blank pushTitle"  '"pushTitle":null' "$R"
refute "and does NOT blank pushBody"   '"pushBody":null' "$R"

R=$(curl -s -X PATCH "$BASE/admin/notifications/templates/support.ticket_replied" "${AUTH_A[@]}" \
    -d '{"channels":["push"]}')
assert "channels alone can be retuned without resending the body" '"success":true' "$R"

# Content rules still bite: this template has no smsBody, so adding the SMS
# channel must be refused — and refused for the RIGHT reason.
R=$(curl -s -X PATCH "$BASE/admin/notifications/templates/support.ticket_replied" "${AUTH_A[@]}" \
    -d '{"channels":["push","sms"]}')
assert "adding SMS with no body is refused, naming SMS" 'SMS routing requires a body' "$R"

R=$(curl -s -X PATCH "$BASE/admin/notifications/templates/support.ticket_replied" "${AUTH_A[@]}" \
    -d '{"channels":["carrier-pigeon"]}')
assert "an unknown channel is rejected" '"statusCode":400' "$R"

R=$(curl -s "$BASE/admin/notifications" -H "Authorization: Bearer $CUST")
assert "a customer token cannot read the notification log" '"statusCode":403' "$R"

# =====================================================================
say "8 · Tickets — raising"
# =====================================================================
R=$(curl -s -X POST "$BASE/customers/me/support/tickets" "${AUTH_C[@]}" \
    -d '{"category":"no_start","subject":"Pro never started","body":"nothing happened"}')
assert "no_start is refused from a customer (400)" '"statusCode":400' "$R"

R=$(curl -s -X POST "$BASE/customers/me/support/tickets" "${AUTH_C[@]}" \
    -d '{"category":"dispute","subject":"Work not done","body":"Nothing was cleaned"}')
assert "a dispute with no booking is refused" '"statusCode":400' "$R"

R=$(curl -s -X POST "$BASE/customers/me/support/tickets" "${AUTH_C[@]}" \
    -d '{"category":"billing","subject":"Charged twice","body":"Two debits for one job","priority":"urgent"}')
assert "a raiser-set priority is rejected outright" '"statusCode":400' "$R"

R=$(curl -s -X POST "$BASE/customers/me/support/tickets" "${AUTH_C[@]}" \
    -d '{"category":"billing","subject":"Charged twice","body":"Two debits for one job"}')
assert "a valid billing ticket is created" '"success":true' "$R"
TKT=$(jqv "$R" "data.id")
assert "priority defaults to normal" '"priority":"normal"' "$R"
assert "not internal" '"isInternal":false' "$R"

# =====================================================================
say "9 · Tickets — internal notes are invisible to the raiser"
# =====================================================================
SENTINEL="OPS-ONLY-SENTINEL-4417"
R=$(curl -s -X POST "$BASE/admin/support/tickets/$TKT/messages" "${AUTH_A[@]}" \
    -d "{\"body\":\"$SENTINEL customer has a history of chargebacks\",\"isInternalNote\":true}")
assert "admin can leave an internal note" '"isInternalNote":true' "$R"

R=$(curl -s -X POST "$BASE/admin/support/tickets/$TKT/messages" "${AUTH_A[@]}" \
    -d '{"body":"We are checking with the gateway now."}')
assert "admin can leave an ordinary reply" '"success":true' "$R"

R=$(curl -s "$BASE/customers/me/support/tickets/$TKT" "${AUTH_C[@]}")
assert "customer sees the thread" '"success":true' "$R"
assert "customer sees the ordinary reply" 'checking with the gateway' "$R"
refute "customer CANNOT see the internal note" "$SENTINEL" "$R"

R=$(curl -s "$BASE/admin/support/tickets/$TKT" "${AUTH_A[@]}")
assert "ops CAN see the internal note" "$SENTINEL" "$R"

R=$(curl -s -X POST "$BASE/customers/me/support/tickets/$TKT/messages" "${AUTH_C[@]}" \
    -d '{"body":"sneaky","isInternalNote":true}')
assert "a customer cannot author an internal note (400, not downgraded)" '"statusCode":400' "$R"

# =====================================================================
say "10 · Tickets — the Pro cannot read the customer's ticket"
# =====================================================================
R=$(curl -s "$BASE/pros/me/support/tickets/$TKT" "${AUTH_P[@]}")
assert "another actor's ticket returns 404, not 403" '"statusCode":404' "$R"

# =====================================================================
say "11 · Tickets — assignment, escalation, resolution"
# =====================================================================
R=$(curl -s -X POST "$BASE/admin/support/tickets/$TKT/escalate" "${AUTH_A[@]}" \
    -d '{"reason":"No gateway response in 48h","priority":"high"}')
assert "escalation succeeds" '"status":"escalated"' "$R"
assert "priority moved to high" '"priority":"high"' "$R"

R=$(curl -s "$BASE/admin/support/tickets/$TKT" "${AUTH_A[@]}")
assert "the escalation reason is written into the thread" 'Escalated: No gateway response' "$R"

R=$(curl -s -X POST "$BASE/admin/support/tickets/$TKT/resolve" "${AUTH_A[@]}" \
    -d '{"resolutionNotes":"Duplicate debit reversed by the gateway.","actionTaken":"none"}')
assert "resolve succeeds" '"status":"resolved"' "$R"

R=$(curl -s -X POST "$BASE/customers/me/support/tickets/$TKT/messages" "${AUTH_C[@]}" \
    -d '{"body":"Still not showing on my statement."}')
assert "the raiser can reply after resolution" '"success":true' "$R"
R=$(curl -s "$BASE/customers/me/support/tickets/$TKT" "${AUTH_C[@]}")
assert "a raiser reply REOPENS the ticket" '"status":"in_progress"' "$R"

# =====================================================================
say "12 · No-start detection — the city window is the one that is read"
# =====================================================================
# This section sets up its own precondition rather than inheriting one from a
# previous seed run: a suite that only passes in a particular order is not a
# suite. Indore gets a 120-minute window and the test booking is re-armed to
# have arrived 90 minutes ago, so a sweep reading the GLOBAL 15 would raise
# and a sweep reading the CITY 120 must not.
setgrace() { # setgrace <minutes>
  node -e "
const {Client}=require('pg');
require('dotenv').config({path:'c:/Users/lnc/New folder (3)/Homingo/.env.local'});
require('dotenv').config({path:'c:/Users/lnc/New folder (3)/Homingo/.env'});
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
const u=await c.query(\"UPDATE platform_settings SET value='$1', \\\"updatedAt\\\"=now() WHERE key='no_start.graceWindowMinutes' AND \\\"cityId\\\"='$CITY'\");
if(!u.rowCount) await c.query(\"INSERT INTO platform_settings (id,key,value,description,\\\"cityId\\\",\\\"createdAt\\\",\\\"updatedAt\\\") VALUES (gen_random_uuid(),'no_start.graceWindowMinutes','$1','Indore override - cURL fixture','$CITY',now(),now())\");
await c.end();})();" > /dev/null 2>&1
}
rearm() {
  node -e "
const {Client}=require('pg');
require('dotenv').config({path:'c:/Users/lnc/New folder (3)/Homingo/.env.local'});
require('dotenv').config({path:'c:/Users/lnc/New folder (3)/Homingo/.env'});
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
await c.query(\"UPDATE bookings SET status='arrived', \\\"startedAt\\\"=NULL, \\\"cancelledAt\\\"=NULL, \\\"arrivedAt\\\"=now() - interval '90 minutes' WHERE id='$BOOKING_NOSTART'\");
await c.query(\"DELETE FROM support_tickets WHERE \\\"systemKey\\\"='no_start:$BOOKING_NOSTART'\");
await c.end();})();" > /dev/null 2>&1
}

rearm
setgrace 120
R=$(curl -s -X POST "$BASE/admin/support/sweep" "${AUTH_A[@]}" -d '{}')
assert "sweep runs" '"success":true' "$R"
RAISED=$(jqv "$R" "data.raised")
[ "$RAISED" = "0" ] \
  && ok "nothing raised — the sweep honoured Indore's 120m override, not the global 15m" \
  || bad "the sweep used the wrong window" "raised=$RAISED"

say "13 · No-start — drop the city window and it fires"
setgrace 15
R=$(curl -s -X POST "$BASE/admin/support/sweep" "${AUTH_A[@]}" -d '{}')
RAISED=$(jqv "$R" "data.raised")
[ "$RAISED" = "1" ] \
  && ok "the incident is raised once the window is exceeded (raised=1)" \
  || bad "expected exactly one incident" "raised=$RAISED  full=$R"

R=$(curl -s "$BASE/admin/support/tickets?category=no_start" "${AUTH_A[@]}")
assert "the incident is on the ops queue"        '"category":"no_start"' "$R"
assert "it is internal"                          '"isInternal":true' "$R"
assert "it is system-raised"                     '"raisedByType":"system"' "$R"
assert "it is high priority"                     '"priority":"high"' "$R"
NOSTART_TKT=$(jqv "$R" "data.0.id")

R=$(curl -s "$BASE/admin/support/tickets/$NOSTART_TKT" "${AUTH_A[@]}")
assert "it carries the grace window that was applied" '"graceWindowMinutes":15' "$R"
assert "and where that number came from"              '"graceSource":"city"' "$R"

say "14 · Feature 13 — the Pro is never told"
R=$(curl -s "$BASE/pros/me/support/tickets" "${AUTH_P[@]}")
refute "the no-start ticket is NOT in the Pro's list" 'no_start' "$R"
R=$(curl -s "$BASE/pros/me/support/tickets/$NOSTART_TKT" "${AUTH_P[@]}")
assert "fetching it by id returns 404, not 403"  '"statusCode":404' "$R"
R=$(curl -s "$BASE/admin/notifications/bookings/$BOOKING_NOSTART" "${AUTH_A[@]}")
refute "no no_start notification was ever addressed to anyone" 'no_start' "$R"

say "15 · Idempotence — a second sweep must not raise a duplicate"
R=$(curl -s -X POST "$BASE/admin/support/sweep" "${AUTH_A[@]}" -d '{}')
RAISED=$(jqv "$R" "data.raised")
[ "$RAISED" = "0" ] \
  && ok "the second sweep raises nothing (systemKey holds)" \
  || bad "a duplicate incident was raised" "raised=$RAISED"

say "16 · Auto-close — an incident that fixed itself"
node -e "
const {Client}=require('pg');
require('dotenv').config({path:'c:/Users/lnc/New folder (3)/Homingo/.env.local'});
require('dotenv').config({path:'c:/Users/lnc/New folder (3)/Homingo/.env'});
(async()=>{const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();
await c.query(\"UPDATE bookings SET status='started', \\\"startedAt\\\"=now() WHERE id='$BOOKING_NOSTART'\");
await c.end();})();" > /dev/null 2>&1
R=$(curl -s -X POST "$BASE/admin/support/sweep" "${AUTH_A[@]}" -d '{}')
CLOSED=$(jqv "$R" "data.autoResolved")
[ "$CLOSED" = "1" ] \
  && ok "the job started late, so the sweep closed its own incident" \
  || bad "the incident was not auto-closed" "autoResolved=$CLOSED  full=$R"
R=$(curl -s "$BASE/admin/support/tickets/$NOSTART_TKT" "${AUTH_A[@]}")
assert "closed as resolved"          '"status":"resolved"' "$R"
assert "with no action against the Pro" '"actionTaken":"none"' "$R"
assert "and a system note saying why" 'Resolved automatically' "$R"

say "17 · Dispute evidence"
R=$(curl -s -X POST "$BASE/admin/support/tickets" "${AUTH_A[@]}" \
    -d "{\"category\":\"dispute\",\"subject\":\"Job was not done\",\"body\":\"Customer disputes completion\",\"bookingId\":\"$BOOKING_COMPLETED\",\"customerId\":\"$CUSTOMER_ID\"}")
DTKT=$(jqv "$R" "data.id")
assert "ops can open a dispute on a completed job" '"category":"dispute"' "$R"
R=$(curl -s "$BASE/admin/support/tickets/$DTKT/evidence" "${AUTH_A[@]}")
assert "evidence bundle returns"              '"success":true' "$R"
assert "status timeline with coordinates"     'statusTimeline' "$R"
assert "photo proof"                          'photoProof' "$R"
assert "chat log"                             'chatLog' "$R"
assert "the customer's own review photos"     'customerReviews' "$R"
assert "trust anchors surfaced"               'startWasOtpVerified' "$R"
assert "routeTrail is reported unavailable, not as an empty trail" '"available":false' "$R"

R=$(curl -s "$BASE/admin/support/tickets/$TKT/evidence" "${AUTH_A[@]}")
assert "evidence on a ticket with no booking is a 409, not an empty bundle" '"statusCode":409' "$R"

echo
echo "----- results -----"
printf 'passed: %s   failed: %s\n' "$PASS" "$FAIL"
echo "SOS1=$SOS1 SOS2=$SOS2 SOS3=$SOS3 TKT=$TKT"
[ "$FAIL" -eq 0 ]
