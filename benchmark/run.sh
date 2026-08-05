#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

PROFILE="smoke"
BASE_URL="http://localhost:3000"
FIXTURE="benchmark/fixture.json"
RATE="3"
DURATION=""
K6_IMAGE="grafana/k6:2.0.0"
ALLOW_REMOTE_LOAD="0"

usage() {
  cat <<'EOF'
Usage: benchmark/run.sh [options]

Options:
  --profile PROFILE       smoke, load, burst, stress, soak, or message
  --base-url URL          Local or dev endpoint (default: http://localhost:3000)
  --fixture PATH          Fixture path inside this repository
  --rate NUMBER           Workflow arrivals per second (default: 3)
  --duration DURATION     Optional k6 duration such as 15m or 4h
  --k6-image IMAGE        Docker fallback image (default: grafana/k6:2.0.0)
  --allow-remote-load     Permit a non-smoke profile against a remote endpoint
  -h, --help              Show this help

Remote endpoints are smoke-only unless --allow-remote-load is supplied.
EOF
}

require_value() {
  if [[ $# -lt 2 || -z "$2" ]]; then
    echo "$1 requires a value" >&2
    usage >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) require_value "$@"; PROFILE="$2"; shift 2 ;;
    --base-url) require_value "$@"; BASE_URL="$2"; shift 2 ;;
    --fixture) require_value "$@"; FIXTURE="$2"; shift 2 ;;
    --rate) require_value "$@"; RATE="$2"; shift 2 ;;
    --duration) require_value "$@"; DURATION="$2"; shift 2 ;;
    --k6-image) require_value "$@"; K6_IMAGE="$2"; shift 2 ;;
    --allow-remote-load) ALLOW_REMOTE_LOAD="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$PROFILE" in
  smoke|load|burst|stress|soak|message) ;;
  *) echo "Unsupported profile: $PROFILE" >&2; exit 2 ;;
esac
if [[ ! "$RATE" =~ ^[1-9][0-9]*$ ]]; then
  echo "--rate must be a positive integer" >&2
  exit 2
fi
if [[ -n "$DURATION" && ! "$DURATION" =~ ^[1-9][0-9]*(ms|s|m|h)$ ]]; then
  echo "--duration must be a positive k6 duration such as 30s, 15m, or 4h" >&2
  exit 2
fi
case "$BASE_URL" in
  http://*|https://*) ;;
  *) echo "--base-url must start with http:// or https://" >&2; exit 2 ;;
esac
BASE_URL="${BASE_URL%/}"

is_loopback="0"
case "$BASE_URL" in
  http://localhost|http://localhost:*|https://localhost|https://localhost:*|\
  http://127.0.0.1|http://127.0.0.1:*|https://127.0.0.1|https://127.0.0.1:*)
    is_loopback="1"
    ;;
esac
if [[ "$is_loopback" == "0" && "$PROFILE" != "smoke" && "$ALLOW_REMOTE_LOAD" != "1" ]]; then
  echo "Refusing a $PROFILE profile against remote endpoint $BASE_URL." >&2
  echo "Use --allow-remote-load only when that target is approved for load testing." >&2
  exit 2
fi

case "$FIXTURE" in
  /*) fixture_candidate="$FIXTURE" ;;
  *) fixture_candidate="$REPO_ROOT/$FIXTURE" ;;
esac
if [[ ! -f "$fixture_candidate" ]]; then
  echo "Fixture not found: $fixture_candidate" >&2
  echo "Run npm run benchmark:seed first." >&2
  exit 2
fi
fixture_dir="$(cd "$(dirname "$fixture_candidate")" && pwd -P)"
fixture_path="$fixture_dir/$(basename "$fixture_candidate")"
case "$fixture_path" in
  "$REPO_ROOT"/*) ;;
  *) echo "The fixture must be inside $REPO_ROOT so Docker can mount it safely." >&2; exit 2 ;;
esac
fixture_relative="${fixture_path#"$REPO_ROOT"/}"

mkdir -p "$SCRIPT_DIR/results"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
summary_relative="benchmark/results/$timestamp-$PROFILE-summary.json"

k6_args=(
  run
  -e "PROFILE=$PROFILE"
  -e "BASE_URL=$BASE_URL"
  -e "FIXTURE=./$fixture_relative"
  -e "RATE=$RATE"
)
if [[ -n "$DURATION" ]]; then
  k6_args+=(-e "DURATION=$DURATION")
fi
k6_args+=(--summary-export "./$summary_relative" ./benchmark/k6/workflows.js)

if command -v k6 >/dev/null 2>&1; then
  cd "$REPO_ROOT"
  exec k6 "${k6_args[@]}"
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Install k6 or Docker; neither executable was found." >&2
  exit 2
fi

docker_base_url="$BASE_URL"
docker_args=(run --rm -i -v "$REPO_ROOT:/work" -w /work)
if [[ "$is_loopback" == "1" ]]; then
  docker_base_url="${docker_base_url/localhost/host.docker.internal}"
  docker_base_url="${docker_base_url/127.0.0.1/host.docker.internal}"
  if [[ "$(uname -s)" == "Linux" ]]; then
    docker_args+=(--add-host host.docker.internal:host-gateway)
  fi
fi

for index in "${!k6_args[@]}"; do
  if [[ "${k6_args[$index]}" == "BASE_URL=$BASE_URL" ]]; then
    k6_args[$index]="BASE_URL=$docker_base_url"
  elif [[ "${k6_args[$index]}" == "./$summary_relative" ]]; then
    k6_args[$index]="/work/$summary_relative"
  fi
done

exec docker "${docker_args[@]}" "$K6_IMAGE" "${k6_args[@]}"
