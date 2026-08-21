#!/usr/bin/env bash
#
# Destroy tier-3 resources. The third of the three leak guards.
#
# Two modes:
#   --run-id <id>   tear down exactly one run (reads .tmp/ec2/<id>.json, and
#                   falls back to tag lookup if the state file is gone)
#   --all           tear down EVERY resource tagged Purpose=alw-benchmark in the
#                   region — the "I closed my laptop mid-run last week" button
#
# Deletion ORDER matters and the AMI/snapshot half is the part people forget:
# deregistering an AMI does NOT delete its backing EBS snapshots, and a
# production root volume snapshot is tens of gigabytes billed monthly, forever.
# So instances go first, then the AMI, then its snapshots, then the security
# groups (which cannot be deleted while an ENI still references them).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)/.tmp/ec2"
TAG_KEY="Purpose"
TAG_VALUE="alw-benchmark"

REGION="${AWS_REGION:-}"
RUN_ID=""
ALL="no"
DRY_RUN="no"

log() { echo "teardown: $*"; }
die() { echo "teardown: FATAL: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --run-id) RUN_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --all) ALL="yes"; shift ;;
    --dry-run) DRY_RUN="yes"; shift ;;
    -h|--help) sed -n '3,20p' "$0" | sed 's|^# \{0,1\}||'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v aws >/dev/null || die "the AWS CLI is not installed"
[ -n "$REGION" ] || die "--region or AWS_REGION is required"
[ "$ALL" = "yes" ] || [ -n "$RUN_ID" ] || die "pass --run-id <id> or --all"

run() {
  if [ "$DRY_RUN" = "yes" ]; then
    echo "  would run: aws $*"
    return 0
  fi
  # Teardown is best-effort per resource on purpose: a security group that is
  # still in use must not stop the AMI and its snapshots from being deleted.
  aws "$@" 2>&1 | sed 's/^/    /' || log "  (continuing after error)"
}

# Collect resources by tag. Always used — even with --run-id — because the tag is
# the ground truth and the local state file may be stale, edited, or absent.
tagged_instances() {
  local filters=("Name=tag:${TAG_KEY},Values=${TAG_VALUE}"
                 "Name=instance-state-name,Values=pending,running,stopping,stopped")
  [ "$ALL" = "yes" ] || filters+=("Name=tag:BenchRunId,Values=${RUN_ID}")
  aws ec2 describe-instances --region "$REGION" \
    --filters "${filters[@]}" \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}

tagged_images() {
  local filters=("Name=tag:${TAG_KEY},Values=${TAG_VALUE}")
  [ "$ALL" = "yes" ] || filters+=("Name=tag:BenchRunId,Values=${RUN_ID}")
  aws ec2 describe-images --region "$REGION" --owners self \
    --filters "${filters[@]}" --query 'Images[].ImageId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}

tagged_groups() {
  local filters=("Name=tag:${TAG_KEY},Values=${TAG_VALUE}")
  [ "$ALL" = "yes" ] || filters+=("Name=tag:BenchRunId,Values=${RUN_ID}")
  aws ec2 describe-security-groups --region "$REGION" \
    --filters "${filters[@]}" --query 'SecurityGroups[].GroupId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}

INSTANCES="$(tagged_instances)"
IMAGES="$(tagged_images)"
GROUPS="$(tagged_groups)"

# Snapshot ids are read from each AMI BEFORE it is deregistered — afterwards the
# association is gone and the snapshots become unattributable orphans.
SNAPSHOTS=""
for image in $IMAGES; do
  ids="$(aws ec2 describe-images --region "$REGION" --image-ids "$image" \
    --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text 2>/dev/null | tr '\t' ' ' || true)"
  SNAPSHOTS="${SNAPSHOTS} ${ids}"
done

log "region ${REGION}, scope $([ "$ALL" = "yes" ] && echo 'ALL benchmark resources' || echo "run ${RUN_ID}")"
log "  instances:       ${INSTANCES:-none}"
log "  images:          ${IMAGES:-none}"
log "  snapshots:       ${SNAPSHOTS:-none}"
log "  security groups: ${GROUPS:-none}"

if [ -z "${INSTANCES}${IMAGES}${SNAPSHOTS}${GROUPS}" ]; then
  log "nothing to do."
  exit 0
fi

# 1. Instances.
if [ -n "$INSTANCES" ]; then
  log "terminating instances..."
  # shellcheck disable=SC2086
  run ec2 terminate-instances --region "$REGION" --instance-ids $INSTANCES
  if [ "$DRY_RUN" != "yes" ]; then
    log "waiting for termination (security groups cannot be deleted until the ENIs are gone)..."
    # shellcheck disable=SC2086
    aws ec2 wait instance-terminated --region "$REGION" --instance-ids $INSTANCES || \
      log "WARNING: wait timed out; security-group deletion below may fail and need a retry"
  fi
fi

# 2. AMIs.
for image in $IMAGES; do
  log "deregistering ${image}..."
  run ec2 deregister-image --region "$REGION" --image-id "$image"
done

# 3. Snapshots — the expensive thing everyone forgets.
for snapshot in $SNAPSHOTS; do
  [ -n "$snapshot" ] || continue
  log "deleting snapshot ${snapshot}..."
  run ec2 delete-snapshot --region "$REGION" --snapshot-id "$snapshot"
done

# 4. Security groups. They reference each other (the SUT group admits the
#    loadgen group), so the rules are revoked first — otherwise deletion order
#    becomes a dependency puzzle that fails intermittently.
if [ -n "$GROUPS" ] && [ "$DRY_RUN" != "yes" ]; then
  for group in $GROUPS; do
    permissions="$(aws ec2 describe-security-groups --region "$REGION" --group-ids "$group" \
      --query 'SecurityGroups[0].IpPermissions' --output json 2>/dev/null || echo '[]')"
    if [ "$permissions" != "[]" ] && [ "$permissions" != "null" ]; then
      aws ec2 revoke-security-group-ingress --region "$REGION" --group-id "$group" \
        --ip-permissions "$permissions" >/dev/null 2>&1 || true
    fi
  done
fi
for group in $GROUPS; do
  log "deleting security group ${group}..."
  run ec2 delete-security-group --region "$REGION" --group-id "$group"
done

if [ -n "$RUN_ID" ] && [ "$DRY_RUN" != "yes" ]; then
  rm -f "${STATE_DIR}/${RUN_ID}.json" "${STATE_DIR}/${RUN_ID}-sut-userdata.yml" "${STATE_DIR}/${RUN_ID}-loadgen-userdata.yml"
fi

log "done. Verify nothing is left behind with:"
log "  aws ec2 describe-instances --region ${REGION} --filters Name=tag:${TAG_KEY},Values=${TAG_VALUE} Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceId'"
