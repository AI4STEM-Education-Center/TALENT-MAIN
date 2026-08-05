#!/usr/bin/env bash
#
# Host- and container-level sampling for the duration of a run.
#
# k6 measures the system from the outside; the probe measures the Node process
# from the inside. This covers the third layer — the box — which is where the
# EC2-specific failure modes live:
#
#   - EBS IOPS and queue depth: a SQLite fsync storm shows up here first
#   - CPU credit balance on burstable (t-class) instances: the reason a soak can
#     look perfect for 30 minutes and then fall off a cliff
#   - container CPU/memory limits being hit rather than the host's
#   - Honker queue depth: whether the worker is draining or falling behind
#
# Usage:
#   metrics.sh start --out DIR [--interval 5] [--web-probe URL] [--worker-probe URL]
#   metrics.sh stop  --out DIR
#
# Output (all newline-delimited JSON / CSV, one row per sample):
#   docker-stats.csv, iostat.txt, probe-web.jsonl, probe-worker.jsonl,
#   queue-depth.jsonl, cpu-credits.jsonl, host.json

set -euo pipefail

COMMAND="${1:-}"
shift || true

OUT_DIR=""
INTERVAL=5
WEB_PROBE="http://127.0.0.1:9464"
WORKER_PROBE="http://127.0.0.1:9465"
QUEUE_DB=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    --web-probe) WEB_PROBE="$2"; shift 2 ;;
    --worker-probe) WORKER_PROBE="$2"; shift 2 ;;
    --queue-db) QUEUE_DB="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$OUT_DIR" ]]; then
  echo "--out DIR is required" >&2
  exit 2
fi

PID_FILE="$OUT_DIR/.metrics.pids"

# ── One-shot host description ────────────────────────────────────────────────
# Captured once, because a benchmark number without the machine it ran on is not
# a result. On EC2 the instance metadata service supplies the instance type and
# AZ; IMDSv2 requires a token, so fall back quietly when it is absent.
write_host_info() {
  local instance_type="unknown" az="unknown" ami="unknown" instance_id="unknown"

  if token=$(curl -fsS -m 2 -X PUT "http://169.254.169.254/latest/api/token" \
      -H "X-aws-ec2-metadata-token-ttl-seconds: 60" 2>/dev/null); then
    local meta="http://169.254.169.254/latest/meta-data"
    local hdr="X-aws-ec2-metadata-token: $token"
    instance_type=$(curl -fsS -m 2 -H "$hdr" "$meta/instance-type" 2>/dev/null || echo unknown)
    az=$(curl -fsS -m 2 -H "$hdr" "$meta/placement/availability-zone" 2>/dev/null || echo unknown)
    ami=$(curl -fsS -m 2 -H "$hdr" "$meta/ami-id" 2>/dev/null || echo unknown)
    instance_id=$(curl -fsS -m 2 -H "$hdr" "$meta/instance-id" 2>/dev/null || echo unknown)
  fi

  local cores mem_kb kernel
  cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo unknown)
  mem_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || echo unknown)
  kernel=$(uname -srm)

  cat >"$OUT_DIR/host.json" <<EOF
{
  "atIso": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "instanceId": "$instance_id",
  "instanceType": "$instance_type",
  "availabilityZone": "$az",
  "amiId": "$ami",
  "cores": "$cores",
  "memTotalKb": "$mem_kb",
  "kernel": "$kernel",
  "dockerVersion": "$(docker --version 2>/dev/null || echo 'not installed')"
}
EOF
}

# ── Samplers ─────────────────────────────────────────────────────────────────

sample_docker_stats() {
  echo "atIso,name,cpuPercent,memUsage,memPercent,netIO,blockIO,pids" >"$OUT_DIR/docker-stats.csv"
  while true; do
    local now
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    # --no-stream so each invocation is one point in time; the streaming form
    # emits ANSI control sequences that are miserable to parse.
    docker stats --no-stream \
      --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}},{{.NetIO}},{{.BlockIO}},{{.PIDs}}' \
      2>/dev/null | while IFS= read -r line; do
        echo "$now,$line" >>"$OUT_DIR/docker-stats.csv"
      done
    sleep "$INTERVAL"
  done
}

sample_iostat() {
  # -x for the extended columns that matter: aqu-sz (queue depth) and %util.
  # Sustained aqu-sz > 1 with %util near 100 means the volume, not the CPU, is
  # the constraint — the usual verdict when SQLite fsync dominates.
  if command -v iostat >/dev/null 2>&1; then
    iostat -x "$INTERVAL" >"$OUT_DIR/iostat.txt" 2>&1
  else
    echo "iostat not installed (apt-get install sysstat) — no disk series captured" \
      >"$OUT_DIR/iostat.txt"
  fi
}

sample_probe() {
  local url="$1" out="$2"
  while true; do
    if body=$(curl -fsS -m 3 "$url" 2>/dev/null); then
      echo "$body" >>"$out"
    fi
    sleep "$INTERVAL"
  done
}

sample_queue_depth() {
  # Honker keeps its queue in a SQLite file beside the app database (see
  # src/lib/queue.ts resolveQueueDbPath). Depth over time is the only honest
  # answer to "is the worker keeping up?"
  if [[ -z "$QUEUE_DB" ]] || ! command -v sqlite3 >/dev/null 2>&1; then
    echo '{"note":"queue depth unavailable — pass --queue-db and install sqlite3"}' \
      >"$OUT_DIR/queue-depth.jsonl"
    return
  fi
  while true; do
    local now depth
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    # Read-only URI so sampling can never take a write lock on the queue and
    # perturb the very thing being measured.
    depth=$(sqlite3 "file:${QUEUE_DB}?mode=ro" \
      "SELECT COALESCE(SUM(CASE WHEN acked_at IS NULL THEN 1 ELSE 0 END), 0) FROM jobs;" \
      2>/dev/null || echo "null")
    echo "{\"atIso\":\"$now\",\"pendingJobs\":$depth}" >>"$OUT_DIR/queue-depth.jsonl"
    sleep "$INTERVAL"
  done
}

sample_cpu_credits() {
  # Burstable instances only. A draining credit balance is the leading indicator
  # of the soak cliff described in k6/scenarios/soak.js, and it is invisible from
  # inside the instance except through CloudWatch.
  if ! command -v aws >/dev/null 2>&1; then
    echo '{"note":"aws cli not installed — no CPU credit series"}' >"$OUT_DIR/cpu-credits.jsonl"
    return
  fi
  local instance_id
  instance_id=$(python3 -c "import json;print(json.load(open('$OUT_DIR/host.json'))['instanceId'])" \
    2>/dev/null || echo unknown)
  if [[ "$instance_id" == "unknown" ]]; then
    echo '{"note":"not on EC2 — no CPU credit series"}' >"$OUT_DIR/cpu-credits.jsonl"
    return
  fi

  while true; do
    local now end start value
    now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    end=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    start=$(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
      || date -u -v-10M +%Y-%m-%dT%H:%M:%SZ)
    value=$(aws cloudwatch get-metric-statistics \
      --namespace AWS/EC2 --metric-name CPUCreditBalance \
      --dimensions "Name=InstanceId,Value=$instance_id" \
      --start-time "$start" --end-time "$end" --period 300 --statistics Average \
      --query 'Datapoints[-1].Average' --output text 2>/dev/null || echo None)
    echo "{\"atIso\":\"$now\",\"cpuCreditBalance\":\"$value\"}" >>"$OUT_DIR/cpu-credits.jsonl"
    # CloudWatch publishes these every 5 minutes; polling faster only costs money.
    sleep 300
  done
}

# ── Commands ────────────────────────────────────────────────────────────────

start_all() {
  mkdir -p "$OUT_DIR"
  : >"$PID_FILE"
  write_host_info

  sample_docker_stats & echo $! >>"$PID_FILE"
  sample_iostat &        echo $! >>"$PID_FILE"
  sample_queue_depth &   echo $! >>"$PID_FILE"
  sample_cpu_credits &   echo $! >>"$PID_FILE"
  sample_probe "$WEB_PROBE" "$OUT_DIR/probe-web.jsonl" &     echo $! >>"$PID_FILE"
  sample_probe "$WORKER_PROBE" "$OUT_DIR/probe-worker.jsonl" & echo $! >>"$PID_FILE"

  echo "metrics collection started (interval ${INTERVAL}s) → $OUT_DIR"
  echo "  $(wc -l <"$PID_FILE" | tr -d ' ') samplers running"
}

stop_all() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "no sampler pid file at $PID_FILE — nothing to stop"
    return 0
  fi
  while read -r pid; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done <"$PID_FILE"
  rm -f "$PID_FILE"
  echo "metrics collection stopped"
}

case "$COMMAND" in
  start) start_all ;;
  stop) stop_all ;;
  *)
    echo "usage: metrics.sh {start|stop} --out DIR [--interval N] [--queue-db PATH]" >&2
    exit 2
    ;;
esac
