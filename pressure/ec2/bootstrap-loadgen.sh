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

# `timeout` KILLS apt mid-transfer, and a killed apt keeps almost nothing in
# /var/cache/apt/archives/partial, so a too-short timeout does not degrade into
# a slower success — it loops forever re-downloading the same bytes. An observed
# run spent 3x300s on base-packages and never got past 8 MB of the 76 MB it
# needed. Let apt do its own per-file retries (which is what the `Ign:` lines in
# that run were asking for) and give the heavy install a realistic ceiling.
APT_OPTS=(-o Acquire::Retries=5 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30)

mark_stage apt-update
retry 3 timeout 300 apt-get "${APT_OPTS[@]}" update -y

mark_stage base-packages
# build-essential alone pulls ~76 MB / 269 MB unpacked, because better-sqlite3
# has to compile its native binding on this box. This is the slowest stage by a
# wide margin; budget for it rather than thrashing.
retry 2 timeout 900 apt-get "${APT_OPTS[@]}" install -y ca-certificates curl gnupg jq unzip sqlite3 build-essential python3

mark_stage nodesource-download
retry 3 timeout 90 curl --retry 3 --retry-all-errors --connect-timeout 15 -fsSL \
  https://deb.nodesource.com/setup_24.x -o /tmp/nodesource-setup.sh

mark_stage nodesource-setup
retry 2 timeout 300 bash /tmp/nodesource-setup.sh

mark_stage node-install
retry 3 timeout 300 apt-get "${APT_OPTS[@]}" install -y nodejs

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
