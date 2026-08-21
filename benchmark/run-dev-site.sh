#!/usr/bin/env bash
#
# Tier 2 — dev.ai4talent.org. CORRECTNESS ONLY, NEVER CAPACITY.
#
#   benchmark/run-dev-site.sh --session-file path/to/sessions.json
#
# dev shares an EC2 instance, a disk, a Caddy and a Cloudflare zone with
# PRODUCTION (docker/docker-compose.yml, docker/Caddyfile). Load here degrades
# the live site, and Cloudflare's WAF throttles load generators anyway — so a
# "capacity" number from this tier measures the WAF, not the app.
#
# What this tier verifies cannot be reproduced locally at any load: that
# Cloudflare -> Caddy -> container resolves, that the origin is not directly
# reachable, that the __Secure- cookie survives a navigation, that host
# validation and the Origin/CSRF check reject what they should, and that an
# UNSIGNED CloudFront URL returns 403 (i.e. the trusted key group really is
# attached and the bucket is not world-readable).
#
# One VU, one iteration. That is the design, not a default to raise.
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${BENCH_DIR}/.." && pwd)"
TARGET="https://dev.ai4talent.org"
SESSION_FILE=""
RUN_DIR="${BENCH_DIR}/.tmp/dev-site"

log() { echo "run-dev-site: $*"; }
die() { echo "run-dev-site: FATAL: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --session-file) SESSION_FILE="$2"; shift 2 ;;
    --target) TARGET="$2"; shift 2 ;;
    -h|--help) sed -n '3,20p' "$0" | sed 's|^# \{0,1\}||'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# Hard guard, independent of the one inside the scenario. Two layers because the
# consequence of getting this wrong is pointing a load generator at production.
case "$TARGET" in
  *dev.ai4talent.org*) ;;
  *) die "refusing to target '${TARGET}'. This tier is only ever dev.ai4talent.org — production is never a load-test target." ;;
esac

[ -n "$SESSION_FILE" ] || die "--session-file is required. Mint it against the DEV database with dev's AUTH_SECRET:
    AUTH_SECRET=<dev secret> npx tsx benchmark/tools/mint-sessions.ts \\
      --out dev-sessions.json --database-url file:/path/to/dev.db --students 3 --teachers 1 --admins 1 --secure"
[ -f "$SESSION_FILE" ] || die "session file not found: ${SESSION_FILE}"

command -v k6 >/dev/null 2>&1 || die "k6 is not installed — run benchmark/tools/install-k6.sh"

mkdir -p "$RUN_DIR"
# NOTE: no BENCH_FORWARDED_HOST for this tier, deliberately. The real
# Cloudflare -> Caddy chain sets X-Forwarded-Host itself, and exercising that
# chain is the entire point here; spoofing it would defeat the host-guard
# assertion edge-validation makes.
log "validating the real edge path at ${TARGET} (1 VU, 1 iteration)"

set +e
BENCH_TIER=dev-site \
BENCH_BASE_URL="$TARGET" \
BENCH_SESSION_FILE="$SESSION_FILE" \
BENCH_COOKIE_NAME="__Secure-authjs.session-token" \
BENCH_RUN_LABEL="dev-edge" \
BENCH_EXPECT_CLOUDFRONT=1 \
k6 run --summary-export "${RUN_DIR}/summary.json" \
  "${BENCH_DIR}/k6/scenarios/edge-validation.js" 2>&1 | tee "${RUN_DIR}/k6.log"
K6_EXIT=${PIPESTATUS[0]}
set -e

echo '{"tier":"dev-site","scenario":"edge-validation","label":"dev-edge"}' > "${RUN_DIR}/meta.json"
( cd "$REPO_DIR" && npx tsx benchmark/collect/summarize.ts \
    --summary "${RUN_DIR}/summary.json" --meta "${RUN_DIR}/meta.json" --out "${RUN_DIR}/report.md" ) || true

log "artifacts in ${RUN_DIR}"
exit "$K6_EXIT"
