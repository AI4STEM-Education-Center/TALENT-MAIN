#!/usr/bin/env bash
set -euo pipefail

: "${PERF_ENV_FILE:?Set PERF_ENV_FILE to the absolute path of the target .env}"

PERF_REPO_URL="${PERF_REPO_URL:-https://github.com/AI4STEM-Education-Center/TALENT-MAIN.git}"
PERF_BRANCH="${PERF_BRANCH:-dev}"
PERF_ROOT="${PERF_ROOT:-$HOME/talent-performance}"
PERF_SOURCE_DIR="$PERF_ROOT/source"
export PERF_DATA_DIR="${PERF_DATA_DIR:-$PERF_ROOT/data}"
export PERF_ARTIFACT_DIR="${PERF_ARTIFACT_DIR:-$PERF_ROOT/artifacts}"
export PERF_RUN_ID="${PERF_RUN_ID:-gpt56-$(date -u +%Y%m%dT%H%M%SZ)}"
export PERF_PORT="${PERF_PORT:-3002}"
export PERF_IMAGE="${PERF_IMAGE:-ghcr.io/ai4stem-education-center/talent-main:dev-latest}"
export PERF_ENV_FILE

case "$PERF_ROOT" in
  ""|/|"$HOME") echo "Refusing unsafe PERF_ROOT: ${PERF_ROOT:-<empty>}" >&2; exit 2 ;;
esac
case "$PERF_SOURCE_DIR" in
  "$PERF_ROOT"/*) ;;
  *) echo "Source directory must stay under PERF_ROOT" >&2; exit 2 ;;
esac

if [[ "$PERF_ENV_FILE" != /* ]]; then
  echo "PERF_ENV_FILE must be an absolute path" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update
    sudo apt-get install -y docker.io docker-compose-v2 git curl
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y docker git curl
    sudo systemctl enable --now docker
  else
    echo "Unsupported host: install Docker, Compose, Git, and curl" >&2
    exit 2
  fi
  sudo usermod -aG docker "$USER"
fi

if docker info >/dev/null 2>&1; then
  DOCKER=(docker)
else
  DOCKER=(sudo docker)
fi

if [[ -n "${GHCR_TOKEN:-}" ]]; then
  printf '%s' "$GHCR_TOKEN" | "${DOCKER[@]}" login ghcr.io -u "${GHCR_USERNAME:?Set GHCR_USERNAME with GHCR_TOKEN}" --password-stdin
fi
if [[ ! -f "$PERF_ENV_FILE" ]]; then
  echo "Environment file not found: $PERF_ENV_FILE" >&2
  exit 2
fi

mkdir -p "$PERF_ROOT" "$PERF_DATA_DIR" "$PERF_ARTIFACT_DIR"
if [[ -d "$PERF_SOURCE_DIR/.git" ]]; then
  git -C "$PERF_SOURCE_DIR" fetch --depth 1 origin "$PERF_BRANCH"
  git -C "$PERF_SOURCE_DIR" checkout --detach FETCH_HEAD
else
  if [[ -e "$PERF_SOURCE_DIR" ]]; then
    mv "$PERF_SOURCE_DIR" "$PERF_SOURCE_DIR.stale.$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  git clone --depth 1 --branch "$PERF_BRANCH" "$PERF_REPO_URL" "$PERF_SOURCE_DIR"
fi

cd "$PERF_SOURCE_DIR"
"${DOCKER[@]}" compose --project-name talent-perf -f benchmark/ec2/docker-compose.perf.yml pull web-perf worker-perf
"${DOCKER[@]}" compose --project-name talent-perf -f benchmark/ec2/docker-compose.perf.yml build seed
"${DOCKER[@]}" compose --project-name talent-perf -f benchmark/ec2/docker-compose.perf.yml stop web-perf worker-perf >/dev/null 2>&1 || true
case "$PERF_DATA_DIR" in
  "$PERF_ROOT"/*) ;;
  *) echo "Refusing to reset data outside $PERF_ROOT: $PERF_DATA_DIR" >&2; exit 2 ;;
esac
rm -f \
  "$PERF_DATA_DIR/perf.db" \
  "$PERF_DATA_DIR/perf.db-journal" \
  "$PERF_DATA_DIR/perf.db-wal" \
  "$PERF_DATA_DIR/perf.db-shm" \
  "$PERF_DATA_DIR/perf.queue.db" \
  "$PERF_DATA_DIR/perf.queue.db-journal" \
  "$PERF_DATA_DIR/perf.queue.db-wal" \
  "$PERF_DATA_DIR/perf.queue.db-shm"
"${DOCKER[@]}" compose --project-name talent-perf -f benchmark/ec2/docker-compose.perf.yml run --rm seed
"${DOCKER[@]}" compose --project-name talent-perf -f benchmark/ec2/docker-compose.perf.yml up -d web-perf worker-perf

for attempt in $(seq 1 60); do
  status="$(curl -sS -o /dev/null -w '%{http_code}' -H "Host: localhost" "http://127.0.0.1:$PERF_PORT/login" || true)"
  if [[ "$status" == "200" ]]; then
    echo "Performance target ready on port $PERF_PORT"
    echo "Fixture: $PERF_ARTIFACT_DIR/fixture.json"
    "${DOCKER[@]}" compose --project-name talent-perf -f benchmark/ec2/docker-compose.perf.yml ps
    exit 0
  fi
  sleep 2
done

"${DOCKER[@]}" compose --project-name talent-perf -f benchmark/ec2/docker-compose.perf.yml logs --tail 200
echo "Performance target did not become healthy" >&2
exit 1
