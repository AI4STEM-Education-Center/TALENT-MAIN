#!/usr/bin/env bash
# One-command isolated EC2 pressure run from a workstation with AWS CLI access.
set -euo pipefail

PRESSURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${PRESSURE_DIR}/.." && pwd)"
ENV_FILE="${PRESSURE_DIR}/.env"

die() { echo "pressure: FATAL: $*" >&2; exit 1; }
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

SCENARIO="${1:-${PRESSURE_SCENARIO:-exam-day}}"
SCALE="${2:-${PRESSURE_SCALE:-1}}"
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

provision_args=(
  --source-instance "$EC2_SOURCE_INSTANCE_ID"
  --region "$AWS_REGION"
  --key-name "$EC2_KEY_NAME"
  --loadgen-type "${EC2_LOADGEN_TYPE:-c7i.2xlarge}"
  --deadman-minutes "${PRESSURE_DEADMAN_MINUTES:-180}"
  --ack-real-data
)
[ -n "${EC2_SUT_TYPE:-}" ] && provision_args+=(--sut-type "$EC2_SUT_TYPE")

"${PRESSURE_DIR}/ec2/provision.sh" "${provision_args[@]}" | tee "$PROVISION_LOG"
RUN_ID="$(grep -oE 'run pressure-[0-9]{8}-[0-9]{6}' "$PROVISION_LOG" | tail -1 | awk '{print $2}')"
[ -n "$RUN_ID" ] || die "provisioning completed without a run id"

run_args=(
  --run-id "$RUN_ID"
  --scenario "$SCENARIO"
  --scale "$SCALE"
  --region "$AWS_REGION"
  --ssh-key "$EC2_SSH_KEY_PATH"
)
[ -n "${PRESSURE_COHORT:-}" ] && run_args+=(--cohort "$PRESSURE_COHORT")

"${PRESSURE_DIR}/run-ec2.sh" "${run_args[@]}"
