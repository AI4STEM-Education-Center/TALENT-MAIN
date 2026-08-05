#!/usr/bin/env bash
set -euo pipefail

PROFILE="${PROFILE:-load}"
RATE="${RATE:-5}"
DURATION="${DURATION:-30m}"
PERF_ROOT="${PERF_ROOT:-$HOME/talent-performance}"
PERF_SOURCE_DIR="${PERF_SOURCE_DIR:-$PERF_ROOT/source}"
PERF_ARTIFACT_DIR="${PERF_ARTIFACT_DIR:-$PERF_ROOT/artifacts}"
PERF_RUN_ID="${PERF_RUN_ID:-direct-$(date -u +%Y%m%dT%H%M%SZ)}"
PERF_PORT="${PERF_PORT:-3002}"
K6_IMAGE="${K6_IMAGE:-grafana/k6:2.0.0}"
REQUEST_HOST="${REQUEST_HOST:-localhost}"
RESULT_DIR="$PERF_ROOT/results/$PERF_RUN_ID"
COMPOSE_FILE="$PERF_SOURCE_DIR/benchmark/ec2/docker-compose.perf.yml"
FIXTURE_FILE="$PERF_ARTIFACT_DIR/fixture.json"

case "$PROFILE" in
  smoke|load|burst|stress|soak|message) ;;
  *) echo "Unsupported PROFILE: $PROFILE" >&2; exit 2 ;;
esac
if [[ ! "$RATE" =~ ^[1-9][0-9]*$ ]]; then
  echo "RATE must be a positive integer" >&2
  exit 2
fi
if [[ -n "$DURATION" && ! "$DURATION" =~ ^[1-9][0-9]*(ms|s|m|h)$ ]]; then
  echo "DURATION must be a positive k6 duration such as 30s, 15m, or 4h" >&2
  exit 2
fi
case "$PERF_ROOT" in
  ""|/|"$HOME") echo "Refusing unsafe PERF_ROOT: ${PERF_ROOT:-<empty>}" >&2; exit 2 ;;
esac
if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Performance checkout not found: $COMPOSE_FILE" >&2
  echo "Run benchmark/ec2/prepare-target.sh first." >&2
  exit 2
fi
if [[ ! -f "$FIXTURE_FILE" ]]; then
  echo "Fixture not found: $FIXTURE_FILE" >&2
  echo "Run benchmark/ec2/prepare-target.sh first." >&2
  exit 2
fi

if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
elif sudo docker info >/dev/null 2>&1; then
  DOCKER=(sudo docker)
else
  echo "Docker is installed but is not available to this user." >&2
  exit 2
fi

mkdir -p "$RESULT_DIR"
export PERF_ROOT PERF_SOURCE_DIR PERF_ARTIFACT_DIR PERF_RUN_ID PERF_PORT
cd "$PERF_SOURCE_DIR"

collect_diagnostics() {
  local exit_code="$?"
  set +e
  {
    date -u
    uname -a
    uptime
    free -m 2>/dev/null || vm_stat 2>/dev/null || true
    df -h
    "${DOCKER[@]}" stats --no-stream
  } >"$RESULT_DIR/target-snapshot.log" 2>&1
  "${DOCKER[@]}" compose --project-name talent-perf -f "$COMPOSE_FILE" ps \
    >"$RESULT_DIR/compose-ps.log" 2>&1
  "${DOCKER[@]}" compose --project-name talent-perf -f "$COMPOSE_FILE" logs --tail 500 web-perf worker-perf \
    >"$RESULT_DIR/compose.log" 2>&1
  echo "Artifacts: $RESULT_DIR"
  exit "$exit_code"
}
trap collect_diagnostics EXIT

k6_args=(
  run
  -e "PROFILE=$PROFILE"
  -e "BASE_URL=http://127.0.0.1:$PERF_PORT"
  -e "REQUEST_HOST=$REQUEST_HOST"
  -e FIXTURE=./benchmark/fixture.json
  -e "RATE=$RATE"
)
if [[ -n "$DURATION" ]]; then
  k6_args+=(-e "DURATION=$DURATION")
fi
k6_args+=(--summary-export /work/results/summary.json /work/benchmark/k6/workflows.js)

set +e
"${DOCKER[@]}" run --rm --network host \
  -v "$PERF_SOURCE_DIR/benchmark/k6:/work/benchmark/k6:ro" \
  -v "$FIXTURE_FILE:/work/benchmark/fixture.json:ro" \
  -v "$RESULT_DIR:/work/results" \
  -w /work \
  "$K6_IMAGE" "${k6_args[@]}" 2>&1 | tee "$RESULT_DIR/k6.log"
k6_status="${PIPESTATUS[0]}"
set -e

set +e
"${DOCKER[@]}" compose --project-name talent-perf -f "$COMPOSE_FILE" \
  run --rm seed npx tsx benchmark/verify.ts /artifacts/fixture.json \
  2>&1 | tee "$RESULT_DIR/verify.log"
verify_status="${PIPESTATUS[0]}"
set -e

if [[ "$k6_status" -ne 0 ]]; then
  echo "k6 thresholds failed with exit code $k6_status" >&2
  exit "$k6_status"
fi
if [[ "$verify_status" -ne 0 ]]; then
  echo "Post-run integrity verification failed with exit code $verify_status" >&2
  exit "$verify_status"
fi
