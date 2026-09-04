#!/usr/bin/env bash
# Deterministic, diagnosable bootstrap for the temporary load generator.
set -Eeuo pipefail

ROOT=/opt/pressure
LOG=/var/log/pressure/boot.log
STAGE_FILE="${ROOT}/BOOT_STAGE"
FAILED_FILE="${ROOT}/BOOT_FAILED"
READY_FILE="${ROOT}/READY"
CURRENT_STAGE=starting

mkdir -p "$ROOT" /var/log/pressure
rm -f "$FAILED_FILE" "$READY_FILE"
exec >>"$LOG" 2>&1

mark_stage() {
  CURRENT_STAGE="$1"
  printf '%s\n' "$CURRENT_STAGE" > "$STAGE_FILE"
  printf 'bootstrap-loadgen: stage=%s at %s\n' "$CURRENT_STAGE" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

on_error() {
  local code=$?
  trap - ERR
  printf 'stage=%s exit=%s\n' "$CURRENT_STAGE" "$code" > "$FAILED_FILE"
  printf 'bootstrap-loadgen: FAILED stage=%s exit=%s\n' "$CURRENT_STAGE" "$code"
  exit "$code"
}
trap on_error ERR

retry() {
  local maximum="$1"
  shift
  local attempt=1
  while ! "$@"; do
    if [ "$attempt" -ge "$maximum" ]; then
      return 1
    fi
    printf 'bootstrap-loadgen: attempt %s/%s failed; retrying in %ss\n' "$attempt" "$maximum" $((attempt * 10))
    sleep $((attempt * 10))
    attempt=$((attempt + 1))
  done
}

export DEBIAN_FRONTEND=noninteractive

mark_stage apt-update
retry 3 timeout 300 apt-get update -y

mark_stage base-packages
retry 3 timeout 300 apt-get install -y ca-certificates curl gnupg jq unzip sqlite3 build-essential python3

mark_stage nodesource-download
retry 3 timeout 90 curl --retry 3 --retry-all-errors --connect-timeout 15 -fsSL \
  https://deb.nodesource.com/setup_24.x -o /tmp/nodesource-setup.sh

mark_stage nodesource-setup
retry 2 timeout 300 bash /tmp/nodesource-setup.sh

mark_stage node-install
retry 3 timeout 300 apt-get install -y nodejs

mark_stage k6-install
timeout 300 "$ROOT/install-k6.sh" --prefix /usr/local/bin

mark_stage verify
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 24 ]
node --version
npm --version
k6 version
jq --version
sqlite3 --version

chown -R ubuntu:ubuntu "$ROOT"
mark_stage ready
touch "$READY_FILE"
printf 'bootstrap-loadgen: READY\n'
