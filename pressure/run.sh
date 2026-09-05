#!/usr/bin/env bash
# One-command isolated EC2 pressure run from a workstation with AWS CLI access.
set -euo pipefail

PRESSURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${PRESSURE_DIR}/.." && pwd)"
ENV_FILE="${PRESSURE_DIR}/.env"

die() { echo "pressure: FATAL: $*" >&2; exit 1; }
usage() {
  cat <<'USAGE'
Usage: pressure/run.sh [scenario|all] [scale] [--students <count>] [--sut-type <type>]

Scenarios: smoke, exam-day, login-storm, media-signing, ramp-capacity,
           soak, spike-recovery, admin-observability

Use "all" to provision once, run every scenario sequentially, publish each
result separately, and tear everything down. The full suite takes roughly
three hours because it includes the two-hour soak scenario.

Start with "smoke" for the shortest end-to-end shakedown. This command has no
--dry-run mode because provisioning creates the AMI needed by every test.

--students sets the exact concurrent/peak student count for student-load
scenarios. It overrides scale for the student load. It does not apply to the
fixed one-user smoke test or the separately throttled login-storm test.

Use "recommend-size --students N" to select the smallest measured EC2 type
that has passed an exam-day run at or above N students. It reads local results
and does not create AWS resources.

--sut-type deliberately tests a different SUT instance type without editing
pressure/.env, for example --sut-type m7i.xlarge.
USAGE
}

POSITIONAL=()
STUDENT_COUNT_ARG=""
SUT_TYPE_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --students)
      [ $# -ge 2 ] || die "--students requires a count"
      STUDENT_COUNT_ARG="$2"
      shift 2
      ;;
    --students=*) STUDENT_COUNT_ARG="${1#*=}"; shift ;;
    --sut-type)
      [ $# -ge 2 ] || die "--sut-type requires an EC2 instance type"
      SUT_TYPE_ARG="$2"
      shift 2
      ;;
    --sut-type=*) SUT_TYPE_ARG="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    --*) die "unknown option '$1'; run with --help for usage" ;;
    *) POSITIONAL+=("$1"); shift ;;
  esac
done
[ "${#POSITIONAL[@]}" -le 2 ] || die "expected at most a scenario and scale; run with --help for usage"

if [ "${POSITIONAL[0]-}" = "recommend-size" ]; then
  [ "${#POSITIONAL[@]}" -eq 1 ] || die "recommend-size accepts --students but no scale"
  [ -z "$SUT_TYPE_ARG" ] || die "recommend-size reads measured results; --sut-type applies when collecting an exam-day result"
  exec node "${PRESSURE_DIR}/recommend-size.mjs" --students "$STUDENT_COUNT_ARG"
fi

[ -f "$ENV_FILE" ] || die "copy pressure/.env.example to pressure/.env and fill the required values"
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${AWS_REGION:?AWS_REGION is required}"
: "${EC2_SOURCE_INSTANCE_ID:?EC2_SOURCE_INSTANCE_ID is required}"
: "${EC2_KEY_NAME:?EC2_KEY_NAME is required}"
: "${EC2_SSH_KEY_PATH:?EC2_SSH_KEY_PATH is required}"
[ -f "$EC2_SSH_KEY_PATH" ] || die "SSH key not found: ${EC2_SSH_KEY_PATH}"
[ "${ACK_REAL_DATA:-}" = "CLONE-PRODUCTION-DATA" ] || die "set ACK_REAL_DATA=CLONE-PRODUCTION-DATA after reading pressure/README.md"

SCENARIO="${POSITIONAL[0]-}"
[ -n "$SCENARIO" ] || SCENARIO="${PRESSURE_SCENARIO:-exam-day}"
SCALE="${POSITIONAL[1]-}"
[ -n "$SCALE" ] || SCALE="${PRESSURE_SCALE:-1}"
if [ "$SCENARIO" != "all" ] && [ ! -f "${PRESSURE_DIR}/k6/scenarios/${SCENARIO}.js" ]; then
  die "unknown scenario '${SCENARIO}'; run with --help to list valid scenarios"
fi

STUDENT_COUNT="${STUDENT_COUNT_ARG:-${PRESSURE_STUDENTS:-}}"
SUT_TYPE="${SUT_TYPE_ARG:-${EC2_SUT_TYPE:-}}"
# Backwards compatibility for existing workstation .env files. PRESSURE_COHORT
# was exam-day-only and must not silently change the other scenario defaults.
if [ -z "$STUDENT_COUNT" ] && [ "$SCENARIO" = "exam-day" ]; then
  STUDENT_COUNT="${PRESSURE_COHORT:-}"
fi
if [ -n "$STUDENT_COUNT" ]; then
  case "$STUDENT_COUNT" in
    *[!0-9]*|'') die "--students must be a positive whole number" ;;
  esac
  [ "$STUDENT_COUNT" -gt 0 ] || die "--students must be greater than zero"
  [ "$STUDENT_COUNT" -le 2000 ] || die "--students cannot exceed the ec2-clone safety ceiling of 2000"
  case "$SCENARIO" in
    smoke) die "--students does not apply to smoke (it is fixed at one student); use exam-day or ramp-capacity" ;;
    login-storm) die "--students does not apply to login-storm; use PRESSURE_LOGIN_VUS for concurrent login attempts" ;;
  esac
fi
PROVISION_LOG="$(mktemp -t talent-pressure-provision.XXXXXX)"
RUN_ID=""

cleanup() {
  local exit_code=$?
  if [ -n "$RUN_ID" ]; then
    echo "pressure: tearing down ${RUN_ID} (instances, AMI, snapshots, and security groups)..."
    "${PRESSURE_DIR}/ec2/teardown.sh" --run-id "$RUN_ID" --region "$AWS_REGION" || {
      echo "pressure: targeted teardown failed; attempting tag-scoped cleanup" >&2
      "${PRESSURE_DIR}/ec2/teardown.sh" --all --region "$AWS_REGION" || true
    }
  fi
  rm -f "$PROVISION_LOG"
  exit "$exit_code"
}
trap cleanup EXIT

export AWS_PROFILE
export GIT_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
export GIT_BRANCH="$(git -C "$REPO_DIR" branch --show-current)"

DEADMAN_MINUTES="${PRESSURE_DEADMAN_MINUTES:-180}"
if [ "$SCENARIO" = "all" ]; then
  case "$DEADMAN_MINUTES" in
    *[!0-9]*|'') die "PRESSURE_DEADMAN_MINUTES must be a positive whole number" ;;
  esac
  if [ "$DEADMAN_MINUTES" -lt 300 ]; then
    echo "pressure: extending the deadman timer to 300 minutes for the full suite"
    DEADMAN_MINUTES=300
  fi
fi

provision_args=(
  --source-instance "$EC2_SOURCE_INSTANCE_ID"
  --region "$AWS_REGION"
  --key-name "$EC2_KEY_NAME"
  --loadgen-type "${EC2_LOADGEN_TYPE:-c7i.2xlarge}"
  --deadman-minutes "$DEADMAN_MINUTES"
  --ami-wait-minutes "${PRESSURE_AMI_WAIT_MINUTES:-60}"
  --ack-real-data
  --orchestrated
)
[ -n "$SUT_TYPE" ] && provision_args+=(--sut-type "$SUT_TYPE")

"${PRESSURE_DIR}/ec2/provision.sh" "${provision_args[@]}" | tee "$PROVISION_LOG"
RUN_ID="$(grep -oE 'run pressure-[0-9]{8}-[0-9]{6}' "$PROVISION_LOG" | tail -1 | awk '{print $2}')"
[ -n "$RUN_ID" ] || die "provisioning completed without a run id"

SCENARIOS=("$SCENARIO")
if [ "$SCENARIO" = "all" ]; then
  # Run short diagnostic scenarios first so useful failures are published before
  # the long capacity and soak phases.
  SCENARIOS=(
    smoke
    login-storm
    media-signing
    admin-observability
    exam-day
    ramp-capacity
    spike-recovery
    soak
  )
fi

SUITE_EXIT=0
for CURRENT_SCENARIO in "${SCENARIOS[@]}"; do
  echo
  echo "pressure: ── scenario ${CURRENT_SCENARIO} ──"
  run_args=(
    --run-id "$RUN_ID"
    --scenario "$CURRENT_SCENARIO"
    --scale "$SCALE"
    --region "$AWS_REGION"
    --ssh-key "$EC2_SSH_KEY_PATH"
    --orchestrated
  )
  if [ "$SCENARIO" = "all" ]; then
    run_args+=(--suite-run)
    [ -n "$STUDENT_COUNT" ] && run_args+=(--suite-students "$STUDENT_COUNT")
  fi
  case "$CURRENT_SCENARIO" in
    smoke|login-storm) ;;
    *) [ -n "$STUDENT_COUNT" ] && run_args+=(--students "$STUDENT_COUNT") ;;
  esac

  if ! "${PRESSURE_DIR}/run-ec2.sh" "${run_args[@]}"; then
    SUITE_EXIT=1
    echo "pressure: scenario ${CURRENT_SCENARIO} FAILED; continuing so the remaining scenarios still produce results" >&2
  fi
done

if [ "$SCENARIO" = "all" ]; then
  echo
  if [ "$SUITE_EXIT" -eq 0 ]; then
    echo "pressure: all scenarios PASSED"
  else
    echo "pressure: full suite finished with one or more failed scenarios" >&2
  fi
fi
exit "$SUITE_EXIT"
