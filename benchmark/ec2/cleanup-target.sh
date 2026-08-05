#!/usr/bin/env bash
set -euo pipefail

PERF_ROOT="${PERF_ROOT:-$HOME/talent-performance}"
PERF_SOURCE_DIR="$PERF_ROOT/source"
if [[ ! -f "$PERF_SOURCE_DIR/benchmark/ec2/docker-compose.perf.yml" ]]; then
  echo "No performance stack found under $PERF_SOURCE_DIR"
  exit 0
fi

export PERF_ENV_FILE="${PERF_ENV_FILE:?Set PERF_ENV_FILE to the same absolute .env path used for setup}"
export PERF_DATA_DIR="${PERF_DATA_DIR:-$PERF_ROOT/data}"
export PERF_ARTIFACT_DIR="${PERF_ARTIFACT_DIR:-$PERF_ROOT/artifacts}"
cd "$PERF_SOURCE_DIR"
docker compose --project-name talent-perf -f benchmark/ec2/docker-compose.perf.yml down --remove-orphans
echo "Containers stopped. Data and artifacts remain under $PERF_ROOT for recovery."
