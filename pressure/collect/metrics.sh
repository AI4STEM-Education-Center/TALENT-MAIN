#!/usr/bin/env bash
#
# Sample three layers while a run is in progress, then emit them as JSON.
#
# WHY THREE LAYERS. Each answers a question the others cannot, and a latency
# number without all three is not attributable:
#
#   host      — is the box out of CPU, RAM or disk? On the real deployment prod
#               and dev share ONE instance and ONE 20 GB root volume with no
#               container memory limits, so "the app is slow" and "the box is
#               full" are genuinely different findings with different fixes.
#   container — which of the four processes is consuming it? The worker runs
#               fifteen concurrent loops against the same database file the web
#               tier writes to.
#   process   — is the event loop blocked? Only the in-process probe can say,
#               and for this architecture that is the leading indicator.
#
# Usage:
#   collect/metrics.sh --out run/metrics.ndjson --interval 5 &
#   SAMPLER=$!;  ... run k6 ...;  kill $SAMPLER
#   collect/metrics.sh --probe-once --out run/probes.json
set -euo pipefail

OUT=""
INTERVAL=5
PROBE_PORTS="${PRESSURE_PROBE_PORTS:-9099 9098}"
PROBE_HOST="${PRESSURE_PROBE_HOST_ADDR:-127.0.0.1}"
PROBE_ONCE="no"

while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --probe-host) PROBE_HOST="$2"; shift 2 ;;
    --probe-ports) PROBE_PORTS="$2"; shift 2 ;;
    --probe-once) PROBE_ONCE="yes"; shift ;;
    -h|--help) sed -n '3,20p' "$0" | sed 's|^# \{0,1\}||'; exit 0 ;;
    *) echo "metrics: unknown argument: $1" >&2; exit 1 ;;
  esac
done
[ -n "$OUT" ] || { echo "metrics: --out is required" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"

probe_snapshots() {
  local first="yes"
  printf '['
  for port in $PROBE_PORTS; do
    local body
    body="$(curl -fsS --max-time 3 "http://${PROBE_HOST}:${port}/probe" 2>/dev/null || true)"
    [ -n "$body" ] || continue
    [ "$first" = "yes" ] || printf ','
    printf '%s' "$body"
    first="no"
  done
  printf ']'
}

# One-shot mode: grab the final probe state at the end of a run.
if [ "$PROBE_ONCE" = "yes" ]; then
  probe_snapshots > "$OUT"
  echo "metrics: probe snapshots -> ${OUT}"
  exit 0
fi

echo "metrics: sampling every ${INTERVAL}s -> ${OUT}"
: > "$OUT"

# NDJSON, one line per tick: append-only, so a run killed mid-sample still leaves
# every earlier sample intact and parseable.
while :; do
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # `docker stats --no-stream` is a point-in-time read of every container.
  containers="[]"
  if command -v docker >/dev/null 2>&1; then
    containers="$(docker stats --no-stream --format '{{json .}}' 2>/dev/null \
      | awk 'BEGIN{printf "["} {if (NR>1) printf ","; printf "%s", $0} END{printf "]"}' || echo '[]')"
    [ -n "$containers" ] || containers="[]"
  fi

  # Load average and disk are read the portable way; /proc is Linux-only and the
  # local tier runs on macOS too.
  load="$(uptime | sed -n 's/.*load average[s]*: \([0-9.]*\).*/\1/p')"
  disk_pct="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')"
  disk_avail_mb="$(df -Pm / | awk 'NR==2 {print $4}')"

  printf '{"t":"%s","load1":%s,"diskUsedPct":%s,"diskAvailMb":%s,"containers":%s,"probes":%s}\n' \
    "$ts" "${load:-0}" "${disk_pct:-0}" "${disk_avail_mb:-0}" "$containers" "$(probe_snapshots)" >> "$OUT"

  sleep "$INTERVAL"
done
