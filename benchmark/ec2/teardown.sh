#!/usr/bin/env bash
#
# Reap benchmark resources by tag.
#
# provision.sh cleans up after itself via an EXIT trap, and both instances arm a
# `shutdown -h` self-destruct as their first act. This is the third line of
# defence, for the case where both fail — a SIGKILLed orchestrator leaves the
# trap unexecuted, and a self-destruct that somehow does not fire leaves an
# instance billing quietly. Leaked EC2 capacity is the expensive kind of bug, so
# it is worth a script that can be run blind.
#
# Everything provision.sh creates carries Purpose=alw-benchmark, so nothing here
# can touch production even if the wrong flags are passed.
#
# Usage:
#   teardown.sh --run-id bench-20260805-…   # one run
#   teardown.sh --all                       # every benchmark resource
#   teardown.sh --all --dry-run             # show what would go

set -euo pipefail

RUN_ID=""
ALL=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id) RUN_ID="$2"; shift 2 ;;
    --all) ALL=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$RUN_ID" && "$ALL" != true ]]; then
  echo "pass --run-id ID or --all" >&2
  exit 2
fi

command -v aws >/dev/null 2>&1 || { echo "aws cli is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

log() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }

# The Purpose filter is non-negotiable: it is what makes this safe to run with
# --all. A resource without that tag was not created by this harness.
FILTERS=(--filters "Name=tag:Purpose,Values=alw-benchmark")
if [[ -n "$RUN_ID" ]]; then
  FILTERS+=("Name=tag:RunId,Values=$RUN_ID")
fi

log "Finding benchmark instances${RUN_ID:+ for run $RUN_ID}"
INSTANCES=$(aws ec2 describe-instances "${FILTERS[@]}" \
  --query 'Reservations[].Instances[?State.Name!=`terminated`].[InstanceId,InstanceType,State.Name,Tags[?Key==`RunId`]|[0].Value,LaunchTime]' \
  --output json | jq -c '.[][]?')

if [[ -z "$INSTANCES" ]]; then
  info "none found"
else
  while IFS= read -r row; do
    info "$(jq -r '"\(.[0])  \(.[1])  \(.[2])  run=\(.[3] // "?")  launched=\(.[4])"' <<<"$row")"
  done <<<"$INSTANCES"
fi

IDS=()
while IFS= read -r row; do
  [[ -n "$row" ]] && IDS+=("$(jq -r '.[0]' <<<"$row")")
done <<<"$INSTANCES"

log "Finding benchmark security groups"
SG_FILTERS=(--filters "Name=tag:Purpose,Values=alw-benchmark")
[[ -n "$RUN_ID" ]] && SG_FILTERS+=("Name=tag:RunId,Values=$RUN_ID")
SGS=$(aws ec2 describe-security-groups "${SG_FILTERS[@]}" \
  --query 'SecurityGroups[].GroupId' --output text 2>/dev/null || true)
info "${SGS:-none found}"

log "Finding benchmark keypairs"
KEY_FILTERS=()
if [[ -n "$RUN_ID" ]]; then
  KEY_FILTERS=(--key-names "$RUN_ID")
else
  # Keypairs are not tagged at creation time by run-instances, so they are
  # matched by the harness's naming convention instead.
  KEY_FILTERS=(--filters "Name=key-name,Values=bench-*")
fi
KEYS=$(aws ec2 describe-key-pairs "${KEY_FILTERS[@]}" \
  --query 'KeyPairs[].KeyName' --output text 2>/dev/null || true)
info "${KEYS:-none found}"

if [[ "$DRY_RUN" == true ]]; then
  log "Dry run — nothing deleted"
  exit 0
fi

if [[ ${#IDS[@]} -gt 0 ]]; then
  log "Terminating ${#IDS[@]} instance(s)"
  aws ec2 terminate-instances --instance-ids "${IDS[@]}" >/dev/null
  info "waiting for termination (security groups cannot be deleted until the ENIs are released)"
  aws ec2 wait instance-terminated --instance-ids "${IDS[@]}"
  info "terminated"
fi

for sg in $SGS; do
  log "Deleting security group $sg"
  # Retry: ENI detachment can lag a little behind the terminated state.
  for attempt in 1 2 3 4 5 6; do
    if aws ec2 delete-security-group --group-id "$sg" 2>/dev/null; then
      info "deleted"
      break
    fi
    [[ "$attempt" == 6 ]] && info "could not delete $sg — retry in a minute or remove it manually"
    sleep 10
  done
done

for key in $KEYS; do
  log "Deleting keypair $key"
  aws ec2 delete-key-pair --key-name "$key" >/dev/null && info "deleted"
done

log "Done"
info "Local results under benchmark/results/ are left untouched."
