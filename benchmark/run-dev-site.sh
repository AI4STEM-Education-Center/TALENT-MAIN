#!/usr/bin/env bash
#
# Tier 2 — validate the live dev deployment. Low volume, by design.
#
#   benchmark/run-dev-site.sh --email … --password …
#
# What this tier is for: proving the edge path works end to end — Cloudflare,
# TLS, session cookies through the tunnel, S3 presigned redirects, and the
# browser experience — and measuring how much latency that path adds on top of
# tier 3's origin-direct numbers.
#
# What it is NOT for, and the reasons are structural rather than cautious:
#
#   - dev and prod share one EC2 host (docker-compose.dev.yml maps dev to 3001,
#     prod to 3000). Load here degrades production and imports production's noise
#     into the measurement.
#   - Cloudflare's WAF classifies sustained synthetic traffic as an attack and
#     starts answering 403, which invalidates a run without announcing itself.
#   - the dev database holds real data. Thousands of synthetic attempts is not a
#     reasonable thing to leave in it.
#
# So this script refuses to exceed a handful of users, uses accounts you supply
# rather than seeding any, and mints sessions at a pace the login limiter allows.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BENCH_DIR="$REPO_ROOT/benchmark"

BASE_URL="https://dev.ai4talent.org"
EMAIL="${BENCH_EMAIL:-}"
PASSWORD="${BENCH_PASSWORD:-}"
SCENARIO="edge-validation"
WITH_BROWSER=true
RUN_ID="dev-$(date -u +%Y%m%d-%H%M%S)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) BASE_URL="${2%/}"; shift 2 ;;
    --email) EMAIL="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --scenario) SCENARIO="$2"; shift 2 ;;
    --no-browser) WITH_BROWSER=false; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

RESULTS_DIR="$BENCH_DIR/results/$RUN_ID"

log() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

log "Preflight"
command -v k6 >/dev/null 2>&1 || die "k6 is required — brew install k6"
[[ -n "$EMAIL" && -n "$PASSWORD" ]] ||
  die "pass --email and --password for an existing account on $BASE_URL (no seeding happens here)"

case "$BASE_URL" in
  *dev*|*staging*|*localhost*|*127.0.0.1*) ;;
  *)
    # The one guard worth being blunt about. Everything else in this harness is
    # recoverable; pointing it at production is not.
    die "refusing to target '$BASE_URL' — it does not look like a dev/staging host.
    Tier 2 exists to validate the dev deployment. Never run a load tool against production."
    ;;
esac

mkdir -p "$RESULTS_DIR"

# ─── Fixtures ────────────────────────────────────────────────────────────────
# No seeded dataset exists on the live site, so the manifest is synthesised from
# the account provided. The class and quiz ids are discovered by asking the API
# what this student is actually enrolled in — the alternative would be guessing
# ids that belong to someone else's class.

log "Discovering the account's classes"
COOKIE_FILE="$RESULTS_DIR/cookies.txt"
CSRF=$(curl -fsS -c "$COOKIE_FILE" "$BASE_URL/api/auth/csrf" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')
[[ -n "$CSRF" ]] || die "could not fetch a CSRF token from $BASE_URL"

curl -fsS -b "$COOKIE_FILE" -c "$COOKIE_FILE" -o /dev/null \
  -X POST "$BASE_URL/api/auth/callback/credentials" \
  --data-urlencode "identifier=$EMAIL" \
  --data-urlencode "password=$PASSWORD" \
  --data-urlencode "csrfToken=$CSRF" \
  --data-urlencode "callbackUrl=$BASE_URL/" \
  --data-urlencode "json=true" || die "login failed"

SESSION_JSON=$(curl -fsS -b "$COOKIE_FILE" "$BASE_URL/api/auth/session")
grep -q '"user"' <<<"$SESSION_JSON" || die "login did not produce a session — check the credentials"
ROLE=$(sed -n 's/.*"role":"\([^"]*\)".*/\1/p' <<<"$SESSION_JSON")
info "authenticated as $EMAIL ($ROLE)"

# Rebuild the cookie header in request form from the jar.
COOKIE_HEADER=$(awk 'BEGIN{ORS=""} /authjs/ {if (n++) print "; "; print $6"="$7}' "$COOKIE_FILE")
[[ -n "$COOKIE_HEADER" ]] || die "no session cookie in the jar"

CLASSES_JSON=$(curl -fsS -H "cookie: $COOKIE_HEADER" "$BASE_URL/api/classes" || echo '[]')

log "Building fixtures"
# node rather than jq: node is already required by this repo, and this keeps the
# tier-2 path dependency-free beyond k6.
node - "$RESULTS_DIR" "$EMAIL" "$PASSWORD" "$COOKIE_HEADER" "$ROLE" "$CLASSES_JSON" <<'NODE'
const fs = require("node:fs");
const [outDir, email, password, cookie, role, classesJson] = process.argv.slice(2);

let classes = [];
try {
  const parsed = JSON.parse(classesJson);
  classes = Array.isArray(parsed) ? parsed : (parsed.classes ?? []);
} catch { /* leave empty and fail loudly below */ }

// quizIds is left empty when the API does not expose them here; the scenario
// then exercises page rendering and auth only, and says so rather than
// fabricating ids that might belong to another teacher's class.
const targets = classes.map((klass) => ({
  classId: klass.id,
  className: klass.name ?? "",
  quizIds: (klass.classQuizzes ?? klass.quizzes ?? [])
    .filter((cq) => cq.published !== false)
    .map((cq) => cq.quizId ?? cq.quiz?.id ?? cq.id)
    .filter(Boolean),
}));

if (targets.length === 0) {
  console.error("WARNING: the account is enrolled in no classes — the quiz journey will be skipped.");
}

fs.writeFileSync(`${outDir}/dataset.json`, JSON.stringify({
  generatedAtIso: new Date().toISOString(),
  tier: "dev",
  password,
  admin: { email: "", username: "" },
  teachers: [],
  students: [{ email, username: email, studentId: "live", classId: targets[0]?.classId ?? null, quizIds: targets[0]?.quizIds ?? [] }],
  classes: targets,
}, null, 2));

fs.writeFileSync(`${outDir}/sessions.json`, JSON.stringify(
  [{ email, role, cookieName: "authjs.session-token", cookie }], null, 2));

console.log(`  ${targets.length} class(es), ${targets[0]?.quizIds.length ?? 0} quiz(zes) on the first`);
NODE

# ─── Run ─────────────────────────────────────────────────────────────────────

log "Running scenario: $SCENARIO"
set +e
k6 run \
  --env "BENCH_TIER=dev" \
  --env "BENCH_BASE_URL=$BASE_URL" \
  --env "BENCH_RESULTS_DIR=$RESULTS_DIR" \
  --summary-trend-stats="avg,min,med,max,p(90),p(95),p(99),count" \
  --summary-export="$RESULTS_DIR/k6-summary.json" \
  "$BENCH_DIR/k6/scenarios/$SCENARIO.js" 2>&1 | tee "$RESULTS_DIR/k6.log"
K6_EXIT=${PIPESTATUS[0]}
set -e

if [[ "$WITH_BROWSER" == true ]]; then
  log "Browser journey"
  # Real Chromium, for the half k6 cannot see: this app renders 41 dashboard
  # pages server-side and then hydrates React on top of them.
  if node -e "require.resolve('playwright')" >/dev/null 2>&1; then
    node "$BENCH_DIR/playwright/browser-journey.mjs" \
      --url "$BASE_URL" --email "$EMAIL" --password "$PASSWORD" \
      --out "$RESULTS_DIR/browser" || info "browser journey reported problems"
  else
    info "playwright not installed — skipping. To include it:"
    info "  npm i -D playwright && npx playwright install --with-deps chromium"
  fi
fi

log "Summarising"
(cd "$REPO_ROOT" && npx tsx benchmark/collect/summarize.ts \
  --run "$RESULTS_DIR" --tier dev --label "$SCENARIO@$(basename "$BASE_URL")") || true

rm -f "$COOKIE_FILE"

log "Done"
info "results : $RESULTS_DIR"
info "summary : $RESULTS_DIR/summary.md"
info ""
info "Reminder: these numbers include CDN, TLS and tunnel overhead, and dev shares"
info "its host with production. Use tier 3 for any capacity statement."
exit "$K6_EXIT"
