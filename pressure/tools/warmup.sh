#!/usr/bin/env bash
#
# Prime the application before k6 measures it.
#
# WHY. The first request to a freshly started container pays costs no later
# request does: readSpool() parses every node's NDJSON with nothing cached,
# Prisma prepares its statements, and the JIT has seen nothing. Measured on a
# real clone, that first call to /api/admin/resources took 2.89s against a
# steady-state p50 of 16.2ms and p95 of 45.8ms — a 60x outlier.
#
# That single sample does not stay in its own lane. Every Prisma call is a
# synchronous better-sqlite3 call, so a 2.4s cold request BLOCKS THE EVENT LOOP
# and whatever is queued behind it inherits the delay. In an admin-observability
# run it surfaced as student_dashboard p99 = 2.44s, breaching a 1500ms SLO whose
# p50 and p95 were 16.2ms and 520.9ms. The tail was measuring warm-up, not
# capacity.
#
# The alternative — excluding the first N seconds of samples inside k6 — was
# rejected: smoke runs exactly ONE iteration, so a time-based exclusion would
# drop its only sample and its requireSteps assertion (which exists to catch a
# journey that silently did nothing) would fire on an empty dataset. Priming the
# app costs a few seconds and changes no measurement semantics.
#
# This deliberately measures STEADY STATE. Cold-start cost is real and worth
# knowing, but it is a separate question from capacity, and letting it sit in
# the tail of a capacity run answers neither.
#
# Best-effort by design: a failure here is logged and does not fail the run,
# because an unwarmed measurement is degraded, not invalid.
set -uo pipefail

SUT_IP="${1:?usage: warmup.sh <sut-ip> <forwarded-host> <sessions.json>}"
FORWARDED_HOST="${2:?forwarded host is required}"
SESSIONS="${3:?sessions bundle is required}"
ROUNDS="${WARMUP_ROUNDS:-3}"

BASE="http://${SUT_IP}:3000"
ORIGIN="http://${FORWARDED_HOST}"

log() { echo "[warmup] $*"; }

command -v jq >/dev/null 2>&1 || { log "jq is missing; skipping warm-up"; exit 0; }
[ -f "$SESSIONS" ] || { log "no session bundle at ${SESSIONS}; skipping warm-up"; exit 0; }

COOKIE_NAME="$(jq -r '.cookieName // empty' "$SESSIONS")"
ADMIN_TOKEN="$(jq -r '.admins[0].token // empty' "$SESSIONS")"
STUDENT_TOKEN="$(jq -r '.students[0].token // empty' "$SESSIONS")"

[ -n "$COOKIE_NAME" ] || { log "session bundle has no cookieName; skipping warm-up"; exit 0; }

# Same headers the journeys send. src/proxy.ts prefers X-Forwarded-Host over
# Host for its allowlist, so warm-up requests that omit it are 403'd and warm
# nothing at all — while still looking like they succeeded.
hdr=(-H "Origin: ${ORIGIN}" -H "X-Forwarded-Host: ${FORWARDED_HOST}")

hit() {
  local label="$1" url="$2" token="${3:-}"
  local start end code
  start=$(date +%s%3N)
  if [ -n "$token" ]; then
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 "${hdr[@]}" \
      -H "Cookie: ${COOKIE_NAME}=${token}" "$url" 2>/dev/null || echo 000)
  else
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 30 "${hdr[@]}" "$url" 2>/dev/null || echo 000)
  fi
  end=$(date +%s%3N)
  printf '  %-18s %s  %sms\n' "$label" "$code" "$((end - start))"
}

log "priming ${BASE} for ${ROUNDS} rounds (steady state is what the SLOs describe)"
for round in $(seq 1 "$ROUNDS"); do
  log "round ${round}:"
  hit static_page       "${BASE}/"
  [ -n "$STUDENT_TOKEN" ] && hit student_dashboard "${BASE}/api/classes" "$STUDENT_TOKEN"
  if [ -n "$ADMIN_TOKEN" ]; then
    hit admin_resources "${BASE}/api/admin/resources?range=24h" "$ADMIN_TOKEN"
    hit admin_logs      "${BASE}/api/admin/logs?limit=100" "$ADMIN_TOKEN"
  fi
done

log "warm. The last round's timings above should be near steady state;"
log "if the final admin_resources is still seconds, that is a real finding, not warm-up."
exit 0
