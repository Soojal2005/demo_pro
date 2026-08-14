#!/usr/bin/env bash
# Module 5 · Dispatch engine, end to end against a running API.
#
# Proves the thing module 4 could not do on its own: a booking assigns itself.
# Expects the AWS database from .env.local, at least one approved and available
# Pro holding Bathroom Deep Clean, the mock OTP provider, and APP_LOG pointing
# at the app's stdout. It deliberately never calls manual assign or queue drain.

BASE="${BASE:-http://127.0.0.1:53000/api/v1}"
APP_LOG="${APP_LOG:-.curl-test-runtime/app.out.log}"
PASS=0
FAIL=0
STATUS=""
BODY=""

ok() { PASS=$((PASS + 1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

expect() {
  if [ "$STATUS" = "$2" ]; then ok "$1 ($STATUS)"; else bad "$1 (want $2, got $STATUS)" "$BODY"; fi
}

req() {
  local out
  if [ -n "${4:-}" ] && [ -n "${3:-}" ]; then
    out=$(curl -sS -X "$1" "$BASE$2" -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $4" -d "$3" -w $'\n%{http_code}')
  elif [ -n "${4:-}" ]; then
    out=$(curl -sS -X "$1" "$BASE$2" -H "Authorization: Bearer $4" -w $'\n%{http_code}')
  elif [ -n "${3:-}" ]; then
    out=$(curl -sS -X "$1" "$BASE$2" -H 'Content-Type: application/json' \
      -d "$3" -w $'\n%{http_code}')
  else
    out=$(curl -sS -X "$1" "$BASE$2" -w $'\n%{http_code}')
  fi
  STATUS=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

jq_() {
  printf '%s' "$BODY" | node -e '
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      try {
        let v = JSON.parse(s);
        for (const k of process.argv[1].split(".")) v = v == null ? v : v[k];
        process.stdout.write(v == null ? "" : String(v));
      } catch { process.stdout.write(""); }
    });' "$1"
}

login() {
  req POST /auth/otp/request "{\"phone\":\"$1\",\"actorType\":\"$2\"}"
  local ref code
  ref=$(jq_ data.providerRef)
  code=$(grep -oE "> [0-9]{6} \(ref $ref\)" "$APP_LOG" | tail -1 | grep -oE '[0-9]{6}' | head -1)
  req POST /auth/otp/verify \
    "{\"phone\":\"$1\",\"actorType\":\"$2\",\"providerRef\":\"$ref\",\"code\":\"$code\"}"
  jq_ data.accessToken
}

echo "=== module 5 · dispatch engine ==="

CUST=$(login "${CUSTOMER_PHONE:-+919812340815}" customer)
if [ -n "$CUST" ]; then ok "customer login"; else bad "customer login" "$BODY"; fi

# Fixed seeded fixture: active, instant-capable, and held by several approved
# available Pros in Indore. Picking data.0 was unstable because catalogue sort
# order can put a scheduled-only service first.
SVC="${SERVICE_ID:-00000000-0000-4000-b000-000000000002}"

req POST /customers/me/addresses \
  '{"label":"other","addressLine":"Automatic assignment API test, Vijay Nagar, Indore","pinLat":22.7196,"pinLng":75.8577}' "$CUST"
ADDR=$(jq_ data.id)
if [ -n "$ADDR" ]; then ok "address created"; else bad "address" "$BODY"; fi

echo "--- intake ---"
req POST /bookings "{\"serviceId\":\"$SVC\",\"addressId\":\"$ADDR\",\"paymentMode\":\"cash\"}" "$CUST"
expect "create cash booking" 201
BK=$(jq_ data.id)

echo "--- unattended engine ---"
for _ in $(seq 1 15); do
  req GET "/bookings/$BK" '' "$CUST"
  [ "$(jq_ data.status)" = "assigned" ] && break
  sleep 1
done

WINNER=$(jq_ data.proId)
if [ "$(jq_ data.status)" = "assigned" ] && [ -n "$WINNER" ]; then
  ok "booking assigned automatically (pro $WINNER)"
else
  bad "automatic assignment did not complete" "$BODY"
fi
if [ "$(jq_ data.assignmentAttempt)" = "1" ]; then ok "first automatic attempt recorded"; else bad "attempt number" "$BODY"; fi
if [ "$(jq_ data.assignmentOutcome)" = "pending_ack" ]; then ok "acknowledgement is pending"; else bad "assignment outcome" "$BODY"; fi
if [ -n "$(jq_ data.ackDeadlineAt)" ]; then ok "acknowledgement window opened"; else bad "ack window" "$BODY"; fi

echo
printf 'passed: %s   failed: %s\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
