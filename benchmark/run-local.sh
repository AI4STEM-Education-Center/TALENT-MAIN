#!/usr/bin/env bash
#
# Tier 1 — the real production image, locally. Answers ONE question: did this
# commit make anything slower?
#
#   benchmark/run-local.sh --scenario regression
#   benchmark/run-local.sh --scenario regression --label before
#   benchmark/run-local.sh --scenario regression --label after --compare before
#   benchmark/run-local.sh --compare-signing        # measures the CloudFront RSA cost
#
# Absolute numbers here are NOT capacity numbers — the container's CPU share is
# usually the limit, not the app. Deltas between two local runs are the product.
set -euo pipefail

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${BENCH_DIR}/.." && pwd)"
COMPOSE_FILE="${BENCH_DIR}/docker/docker-compose.bench.yml"
ENV_FILE="${BENCH_DIR}/docker/bench.env"
WORK_DIR="${BENCH_DIR}/.tmp/local"
BASE_URL="http://127.0.0.1:3100"
# src/proxy.ts validates the host on EVERY request against a fixed allowlist and
# returns a bare 403 for anything else. Port 3100 is used so a benchmark never
# collides with `next dev`, but `127.0.0.1:3100` is NOT on that allowlist — so
# without this every single request is refused before reaching a route, and
# because 403 is a legitimately "designed" status here, the run reports a clean
# PASS having exercised nothing. This is what production's Caddy sends, and
# src/proxy.ts prefers X-Forwarded-Host over Host, so it is faithful rather than
# a workaround.
FORWARDED_HOST="localhost:3000"

SCENARIO="regression"
LABEL=""
SCALE="1"
SEED_SCALE="1"
COMPARE_WITH=""
COMPARE_SIGNING="no"
KEEP_UP="no"
SKIP_BUILD="no"

log() { echo "run-local: $*"; }
die() { echo "run-local: FATAL: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) SCENARIO="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --scale) SCALE="$2"; shift 2 ;;
    --seed-scale) SEED_SCALE="$2"; shift 2 ;;
    --compare) COMPARE_WITH="$2"; shift 2 ;;
    --compare-signing) COMPARE_SIGNING="yes"; shift ;;
    --keep-up) KEEP_UP="yes"; shift ;;
    --skip-build) SKIP_BUILD="yes"; shift ;;
    -h|--help) sed -n '3,14p' "$0" | sed 's|^# \{0,1\}||'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$LABEL" ] || LABEL="$(cd "$REPO_DIR" && git rev-parse --short HEAD 2>/dev/null || echo local)"

command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running"
command -v k6 >/dev/null 2>&1 || die "k6 is not installed — run benchmark/tools/install-k6.sh"

# Refuse to run without the env file rather than inventing defaults: a run with a
# different AUTH_SECRET than the minter used produces a wall of 302s that looks
# like an app failure.
[ -f "$ENV_FILE" ] || die "missing ${ENV_FILE} — copy docker/bench.env.example to docker/bench.env first"

RUN_DIR="${WORK_DIR}/${LABEL}"
rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"

# ── Signing comparison mode ───────────────────────────────────────────────────
# Runs media-signing twice against the SAME image and the SAME dataset, once
# with CloudFront configured and once without, and prints the delta. That delta
# IS the per-URL RSA signing cost, isolated from everything else.
if [ "$COMPARE_SIGNING" = "yes" ]; then
  grep -qE '^CLOUDFRONT_DOMAIN="?.+' "$ENV_FILE" || \
    die "--compare-signing needs CLOUDFRONT_* populated in ${ENV_FILE} (see bench.env.example for how to mint a throwaway key)"
  log "measuring WITH CloudFront signing..."
  "$0" --scenario media-signing --label "signing-cloudfront" --skip-build ${SCALE:+--scale $SCALE}
  log "measuring WITHOUT CloudFront (S3 presign path)..."
  BENCH_DISABLE_CLOUDFRONT=1 "$0" --scenario media-signing --label "signing-s3" --skip-build ${SCALE:+--scale $SCALE}
  echo
  log "delta (the RSA-per-URL cost):"
  ( cd "$REPO_DIR" && npx tsx benchmark/collect/compare.ts \
    --baseline "${WORK_DIR}/signing-s3/summary.json" \
    --candidate "${WORK_DIR}/signing-cloudfront/summary.json" \
    --tolerance 0.10 ) || true
  exit 0
fi

RUN_ENV_FILE="$ENV_FILE"

cleanup() {
  if [ "$KEEP_UP" = "yes" ]; then
    log "leaving the stack up (--keep-up). Tear it down with: docker compose -f ${COMPOSE_FILE} down -v"
    return
  fi
  log "tearing down the stack..."
  docker compose -f "$COMPOSE_FILE" --env-file "$RUN_ENV_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ── Bring up the stack ────────────────────────────────────────────────────────
cd "${BENCH_DIR}/docker"
if [ "$SKIP_BUILD" = "no" ]; then
  log "building the production image (this is the artifact that gets deployed)..."
  BENCH_IMAGE="talent-main:bench" docker compose -f "$COMPOSE_FILE" --env-file "$RUN_ENV_FILE" build web
fi

# The documented CloudFront rollback switch, exercised as real configuration.
# Compose reads those values through `env_file:`, so an `-e` override on the
# compose command would never reach the container — the env file itself has to
# change. Rewritten against a COPY so the operator's bench.env is never edited.
if [ "${BENCH_DISABLE_CLOUDFRONT:-}" = "1" ]; then
  log "CloudFront DISABLED for this run (reads will use S3 presigning)"
  RUN_ENV_FILE="${RUN_DIR}/bench.env"
  grep -vE '^CLOUDFRONT_(DOMAIN|KEY_PAIR_ID|PRIVATE_KEY)=' "$ENV_FILE" > "$RUN_ENV_FILE"
  {
    echo 'CLOUDFRONT_DOMAIN=""'
    echo 'CLOUDFRONT_KEY_PAIR_ID=""'
    echo 'CLOUDFRONT_PRIVATE_KEY=""'
  } >> "$RUN_ENV_FILE"
fi

log "starting web + worker + AI stub..."
# Services are named explicitly: `--wait` otherwise waits on db-init too, which
# is a one-shot that exits 0 by design. Compose still runs it first, because web
# declares depends_on: service_completed_successfully.
docker compose -f "$COMPOSE_FILE" --env-file "$RUN_ENV_FILE" up -d --wait --wait-timeout 240 web worker mock-ai \
  || { docker compose -f "$COMPOSE_FILE" --env-file "$RUN_ENV_FILE" logs --tail 80 db-init web; die "the stack did not become healthy"; }

# ── Seed + mint ───────────────────────────────────────────────────────────────
# The schema push runs in the container (it owns the Prisma CLI and the mounted
# data directory). The seed and the session minter run on the HOST, against a
# copied-out database file, because the runtime image deliberately ships no
# TypeScript runner. The file is copied back and both services restarted, since
# the adapter holds the old handle open.
log "seeding the synthetic dataset (scale ${SEED_SCALE})..."
docker compose -f "$COMPOSE_FILE" --env-file "$RUN_ENV_FILE" exec -T web \
  sh -c 'node ./node_modules/prisma/build/index.js db push --accept-data-loss' >/dev/null

AUTH_SECRET_VALUE="$(grep -E '^AUTH_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')"
[ -n "$AUTH_SECRET_VALUE" ] || die "AUTH_SECRET is not set in ${ENV_FILE}"

# npx tsx inside the container: the runtime image has no tsx, so the seed and
# minter are executed from the repo mount on the host instead.
log "seeding + minting from the host (the runtime image has no TypeScript runner)..."
DB_HOST_COPY="${RUN_DIR}/bench.db"
docker cp bench-web:/app/prisma/data/bench.db "$DB_HOST_COPY" >/dev/null 2>&1 || true

( cd "$REPO_DIR" && \
  PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION=1 \
  npx tsx benchmark/seed/seed-bench.ts --database-url "file:${DB_HOST_COPY}" --scale "$SEED_SCALE" ) \
  || die "seeding failed"

docker cp "$DB_HOST_COPY" bench-web:/app/prisma/data/bench.db >/dev/null
# The app opened the database at boot; restart both services so they pick up the
# seeded file rather than an empty one held open by the adapter.
docker compose -f "$COMPOSE_FILE" --env-file "$RUN_ENV_FILE" restart web worker >/dev/null
docker compose -f "$COMPOSE_FILE" --env-file "$RUN_ENV_FILE" up -d --wait --wait-timeout 180 web worker >/dev/null

SESSION_FILE="${RUN_DIR}/sessions.json"
( cd "$REPO_DIR" && \
  AUTH_SECRET="$AUTH_SECRET_VALUE" npx tsx benchmark/tools/mint-sessions.ts \
    --out "$SESSION_FILE" --database-url "file:${DB_HOST_COPY}" \
    --students 200 --teachers 10 --admins 1 --secure \
    --credentials-for bench_ --credentials-password 'BenchPassw0rd!' ) \
  || die "minting sessions failed"

MEDIA_TARGET="$(node -e '
  const m = require(process.argv[1]);
  const t = (m.mediaTargets || [])[0];
  process.stdout.write(t ? JSON.stringify({classId: t.classId, quizId: t.quizId}) : "{}");
' "${RUN_DIR}/seed-manifest.json" 2>/dev/null || echo '{}')"

EXPECT_CF=0
grep -qE '^CLOUDFRONT_DOMAIN="?.+' "$ENV_FILE" && [ "${BENCH_DISABLE_CLOUDFRONT:-}" != "1" ] && EXPECT_CF=1

# ── Run ───────────────────────────────────────────────────────────────────────
"${BENCH_DIR}/collect/metrics.sh" --out "${RUN_DIR}/metrics.ndjson" --interval 5 &
SAMPLER_PID=$!
# Stop the sampler even if k6 aborts, so a failed run does not leave a
# background loop writing forever.
trap 'kill '"$SAMPLER_PID"' 2>/dev/null || true; cleanup' EXIT

# Zero the probe histograms so the measurement window is the k6 run, not the
# seeding and restarts that preceded it.
curl -fsS -X POST http://127.0.0.1:9099/reset >/dev/null 2>&1 || true
curl -fsS -X POST http://127.0.0.1:9098/reset >/dev/null 2>&1 || true

log "running scenario '${SCENARIO}' (label ${LABEL})..."
set +e
BENCH_TIER=local \
BENCH_BASE_URL="$BASE_URL" \
BENCH_FORWARDED_HOST="$FORWARDED_HOST" \
BENCH_SESSION_FILE="$SESSION_FILE" \
BENCH_COOKIE_NAME="__Secure-authjs.session-token" \
BENCH_RUN_LABEL="$LABEL" \
BENCH_SCALE="$SCALE" \
BENCH_EXPECT_CLOUDFRONT="$EXPECT_CF" \
BENCH_MEDIA_TARGET="$MEDIA_TARGET" \
k6 run --summary-export "${RUN_DIR}/summary.json" \
  "${BENCH_DIR}/k6/scenarios/${SCENARIO}.js" 2>&1 | tee "${RUN_DIR}/k6.log"
K6_EXIT=${PIPESTATUS[0]}
set -e

kill "$SAMPLER_PID" 2>/dev/null || true
"${BENCH_DIR}/collect/metrics.sh" --probe-once --out "${RUN_DIR}/probes.json" || true
docker compose -f "$COMPOSE_FILE" --env-file "$RUN_ENV_FILE" logs --no-color > "${RUN_DIR}/containers.log" 2>&1 || true

cat > "${RUN_DIR}/meta.json" <<JSON
{
  "tier": "local",
  "scenario": "${SCENARIO}",
  "label": "${LABEL}",
  "commit": "$(cd "$REPO_DIR" && git rev-parse HEAD 2>/dev/null || echo unknown)",
  "scale": "${SCALE}",
  "seedScale": "${SEED_SCALE}",
  "cloudFrontEnabled": ${EXPECT_CF},
  "k6": "$(k6 version 2>/dev/null | head -1)"
}
JSON

( cd "$REPO_DIR" && npx tsx benchmark/collect/summarize.ts \
    --summary "${RUN_DIR}/summary.json" --probes "${RUN_DIR}/probes.json" \
    --meta "${RUN_DIR}/meta.json" --out "${RUN_DIR}/report.md" ) || true

if [ -n "$COMPARE_WITH" ]; then
  BASE_RUN="${WORK_DIR}/${COMPARE_WITH}"
  [ -f "${BASE_RUN}/summary.json" ] || die "no stored run labelled '${COMPARE_WITH}' to compare against"
  echo
  log "comparing '${COMPARE_WITH}' -> '${LABEL}'"
  ( cd "$REPO_DIR" && npx tsx benchmark/collect/compare.ts \
      --baseline "${BASE_RUN}/summary.json" --candidate "${RUN_DIR}/summary.json" \
      --baseline-meta "${BASE_RUN}/meta.json" --candidate-meta "${RUN_DIR}/meta.json" )
fi

log "artifacts in ${RUN_DIR}"
exit "$K6_EXIT"
