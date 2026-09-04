#!/usr/bin/env bash
#
# Provision an isolated tier-3 environment with the AWS CLI, from your laptop.
#
# WHAT IT BUILDS
#
#   [ your machine ] --aws cli--> creates, in the source instance's own VPC/AZ:
#
#        (SG: pressure-loadgen)              (SG: pressure-sut)
#        ┌────────────────┐  private IP   ┌──────────────────────┐
#        │  load generator │ ────────────> │  clone of production │
#        │  k6 + AI stub   │  :3000 :9099  │  web + worker        │
#        └────────────────┘               └──────────────────────┘
#              plain Ubuntu                  AMI from prod's volume
#              no prod data                  sanitized before Docker starts
#
# The clone boots from an AMI created off the SOURCE INSTANCE'S RUNNING ROOT
# VOLUME, so it carries production's real data and real row counts. Everything
# about how that is made safe lives in ec2/sanitize-sut.sh — read that file
# before running this one.
#
# PRODUCTION IS NEVER MODIFIED:
#   * create-image is called with --no-reboot, so the source instance is not
#     restarted and its Docker containers are not touched.
#   * Nothing is added to production's security groups; the clone gets brand-new
#     ones.
#   * The clone boots onto a FRESH volume created from the snapshot. Production's
#     volume is never attached anywhere.
#
# THREE INDEPENDENT GUARDS AGAINST LEAKED INSTANCES, because that is the
# expensive failure and the one most likely to happen (a laptop closing mid-run):
#   1. An EXIT trap here tears down anything this script created if it fails.
#   2. `shutdown -h +300` armed in cloud-init `bootcmd` as each instance's very
#      first action, paired with --instance-initiated-shutdown-behavior terminate.
#   3. `teardown.sh --all`, which filters on the Purpose=talent-pressure tag.
#
# Usage:
#   pressure/ec2/provision.sh --source-instance i-0abc123 --ack-real-data \
#       [--region us-east-1] [--loadgen-type c7i.2xlarge] [--key-name my-key]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRESSURE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

TAG_KEY="Purpose"
TAG_VALUE="talent-pressure"
STATE_DIR="${PRESSURE_DIR}/.tmp/ec2"

SOURCE_INSTANCE=""
REGION="${AWS_REGION:-}"
LOADGEN_TYPE="c7i.2xlarge"
SUT_TYPE=""
KEY_NAME=""
ACK_REAL_DATA="no"
DEADMAN_MINUTES=240
AMI_WAIT_MINUTES="${PRESSURE_AMI_WAIT_MINUTES:-60}"
KEEP_ON_FAILURE="no"
ORCHESTRATED="no"

die() { echo "provision: FATAL: $*" >&2; exit 1; }
log() { echo "provision: $*"; }

usage() {
  sed -n '3,40p' "$0" | sed 's|^# \{0,1\}||'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --source-instance) SOURCE_INSTANCE="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --loadgen-type) LOADGEN_TYPE="$2"; shift 2 ;;
    --sut-type) SUT_TYPE="$2"; shift 2 ;;
    --key-name) KEY_NAME="$2"; shift 2 ;;
    --deadman-minutes) DEADMAN_MINUTES="$2"; shift 2 ;;
    --ami-wait-minutes) AMI_WAIT_MINUTES="$2"; shift 2 ;;
    --ack-real-data) ACK_REAL_DATA="yes"; shift ;;
    --keep-on-failure) KEEP_ON_FAILURE="yes"; shift ;;
    --orchestrated) ORCHESTRATED="yes"; shift ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1" ;;
  esac
done

# ─────────────────────────────────────────────────────────────────────────────
# Preflight
# ─────────────────────────────────────────────────────────────────────────────
command -v aws >/dev/null || die "the AWS CLI is not installed"
command -v jq  >/dev/null || die "jq is not installed"
[ -n "$SOURCE_INSTANCE" ] || die "--source-instance is required (the production instance to clone)"
[ -n "$REGION" ] || die "--region or AWS_REGION is required"
case "$AMI_WAIT_MINUTES" in
  ''|*[!0-9]*) die "--ami-wait-minutes must be a positive whole number" ;;
esac
[ "$AMI_WAIT_MINUTES" -gt 0 ] || die "--ami-wait-minutes must be greater than zero"

# The acknowledgement is a hard gate, not a warning. Cloning production's volume
# puts real student records and real IRB consent data on a temporary instance;
# that is a decision an operator has to make explicitly every single time.
if [ "$ACK_REAL_DATA" != "yes" ]; then
  cat >&2 <<'WARN'
provision: --ack-real-data is required.

  This clones the SOURCE INSTANCE'S ROOT VOLUME, which means the temporary
  instance will hold:
    * real student records and graded attempts
    * real IRB/FERPA research consent records
    * production's AWS keys, CloudFront private key and AUTH_SECRET

  ec2/sanitize-sut.sh removes the clone's ability to ACT on any of it (no S3
  writes, no email, no backups, no hosted AI, no public ingress) before the
  application is allowed to start, and the volume dies with the instance.
  It does NOT anonymize the data.

  Re-run with --ack-real-data to proceed.
WARN
  exit 2
fi

aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1 || \
  die "AWS credentials are not usable for region ${REGION}"

mkdir -p "$STATE_DIR"
RUN_ID="pressure-$(date -u +%Y%m%d-%H%M%S)"
STATE_FILE="${STATE_DIR}/${RUN_ID}.json"

# Everything created gets recorded here as it is created, so the trap and
# teardown.sh can clean up even a half-finished provision.
CREATED_AMI=""
CREATED_SNAPSHOTS=""
CREATED_SUT=""
CREATED_LOADGEN=""
CREATED_SG_SUT=""
CREATED_SG_LOADGEN=""

write_state() {
  cat > "$STATE_FILE" <<JSON
{
  "runId": "${RUN_ID}",
  "region": "${REGION}",
  "sourceInstance": "${SOURCE_INSTANCE}",
  "ami": "${CREATED_AMI}",
  "snapshots": "${CREATED_SNAPSHOTS}",
  "sut": "${CREATED_SUT}",
  "loadgen": "${CREATED_LOADGEN}",
  "sgSut": "${CREATED_SG_SUT}",
  "sgLoadgen": "${CREATED_SG_LOADGEN}"
}
JSON
}

cleanup_on_failure() {
  local code=$?
  [ $code -eq 0 ] && return 0
  if [ "$KEEP_ON_FAILURE" = "yes" ]; then
    log "FAILED (exit ${code}) — leaving resources up because --keep-on-failure was passed."
    log "Clean up with: pressure/ec2/teardown.sh --run-id ${RUN_ID} --region ${REGION}"
    return 0
  fi
  log "FAILED (exit ${code}) — tearing down everything this run created..."
  write_state
  "${SCRIPT_DIR}/teardown.sh" --run-id "$RUN_ID" --region "$REGION" || \
    log "WARNING: automatic teardown did not complete. RUN THIS: pressure/ec2/teardown.sh --all --region ${REGION}"
}
trap cleanup_on_failure EXIT

# ─────────────────────────────────────────────────────────────────────────────
# 1. Read the source instance's own configuration
# ─────────────────────────────────────────────────────────────────────────────
# Discovered rather than configured. Hard-coding an instance type or subnet is
# how a benchmark ends up measuring a machine that is not the one in production —
# and the answer would look authoritative while being wrong.
log "reading configuration from ${SOURCE_INSTANCE}..."
SRC="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$SOURCE_INSTANCE" \
        --query 'Reservations[0].Instances[0]' --output json)" \
  || die "could not describe ${SOURCE_INSTANCE}"

SRC_TYPE="$(echo "$SRC" | jq -r '.InstanceType')"
SRC_AZ="$(echo "$SRC" | jq -r '.Placement.AvailabilityZone')"
SRC_SUBNET="$(echo "$SRC" | jq -r '.SubnetId')"
SRC_VPC="$(echo "$SRC" | jq -r '.VpcId')"
SRC_KEY="$(echo "$SRC" | jq -r '.KeyName // empty')"
SRC_IAM="$(echo "$SRC" | jq -r '.IamInstanceProfile.Arn // empty')"
SRC_ROOT_DEVICE="$(echo "$SRC" | jq -r '.RootDeviceName')"

[ -n "$SUT_TYPE" ] || SUT_TYPE="$SRC_TYPE"
[ -n "$KEY_NAME" ] || KEY_NAME="$SRC_KEY"
[ -n "$KEY_NAME" ] || die "the source instance has no key pair; pass --key-name so the run can reach the instances over SSH"

log "source: type=${SRC_TYPE} az=${SRC_AZ} subnet=${SRC_SUBNET} vpc=${SRC_VPC}"
log "clone will be ${SUT_TYPE} in ${SRC_AZ}; load generator ${LOADGEN_TYPE} in the same subnet"

if [ "$SUT_TYPE" != "$SRC_TYPE" ]; then
  log "NOTE: the clone's instance type differs from production (${SUT_TYPE} vs ${SRC_TYPE}). Capacity numbers will NOT transfer to production."
fi

SUT_SPECS="$(aws ec2 describe-instance-types --region "$REGION" --instance-types "$SUT_TYPE" \
  --query 'InstanceTypes[0].{vcpus:VCpuInfo.DefaultVCpus,memoryMiB:MemoryInfo.SizeInMiB}' --output json)" \
  || die "could not describe instance type ${SUT_TYPE}"
SUT_VCPUS="$(echo "$SUT_SPECS" | jq -r '.vcpus')"
SUT_MEMORY_MIB="$(echo "$SUT_SPECS" | jq -r '.memoryMiB')"
log "clone capacity: ${SUT_VCPUS} vCPUs, ${SUT_MEMORY_MIB} MiB memory"

# The IAM instance profile is deliberately NOT copied onto the clone. The app
# does not use one (docs/SETUP.md: credentials come from ~/app/.env), so the only
# thing attaching it could do is hand the clone AWS permissions it has no need
# for — the exact permissions sanitize-sut.sh works to remove.
if [ -n "$SRC_IAM" ]; then
  log "NOTE: the source has IAM instance profile ${SRC_IAM}; it is intentionally NOT attached to the clone."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Snapshot production's root volume into an AMI
# ─────────────────────────────────────────────────────────────────────────────
# --no-reboot leaves production running and untouched. The tradeoff is a
# crash-consistent filesystem: the SQLite database may hold an unreplayed WAL,
# which sanitize-sut.sh checkpoints and integrity-checks before anything trusts
# a row in it. A rebooting snapshot would be cleaner and is not worth an outage.
log "creating an AMI from ${SOURCE_INSTANCE} (--no-reboot; production keeps running)..."
CREATED_AMI="$(aws ec2 create-image --region "$REGION" \
  --instance-id "$SOURCE_INSTANCE" \
  --name "${RUN_ID}-clone" \
  --description "Throwaway benchmark clone of ${SOURCE_INSTANCE}" \
  --no-reboot \
  --tag-specifications \
    "ResourceType=image,Tags=[{Key=${TAG_KEY},Value=${TAG_VALUE}},{Key=PressureRunId,Value=${RUN_ID}}]" \
    "ResourceType=snapshot,Tags=[{Key=${TAG_KEY},Value=${TAG_VALUE}},{Key=PressureRunId,Value=${RUN_ID}}]" \
  --query 'ImageId' --output text)"
write_state
log "AMI ${CREATED_AMI} registered; waiting up to ${AMI_WAIT_MINUTES} minutes for it to become available..."

# The stock AWS CLI waiter polls 40 times at 15-second intervals, so it gives up
# after only 10 minutes. Initial EBS snapshots can legitimately take longer.
# Poll explicitly so the limit is appropriate for a production-sized volume and
# so a terminal EC2 failure is reported with its actual reason.
AMI_WAIT_DEADLINE=$((SECONDS + AMI_WAIT_MINUTES * 60))
AMI_LAST_LOGGED_AT=0
while true; do
  AMI_STATUS="$(aws ec2 describe-images --region "$REGION" --image-ids "$CREATED_AMI" \
    --query 'Images[0].{state:State,reason:StateReason.Message}' --output json)" \
    || die "could not read the status of AMI ${CREATED_AMI}"
  AMI_STATE="$(echo "$AMI_STATUS" | jq -r '.state // "missing"')"
  AMI_REASON="$(echo "$AMI_STATUS" | jq -r '.reason // empty')"

  case "$AMI_STATE" in
    available) break ;;
    failed|error|deregistered|missing)
      die "AMI ${CREATED_AMI} entered state '${AMI_STATE}'${AMI_REASON:+: ${AMI_REASON}}"
      ;;
  esac

  if [ "$SECONDS" -ge "$AMI_WAIT_DEADLINE" ]; then
    die "AMI ${CREATED_AMI} is still '${AMI_STATE}' after ${AMI_WAIT_MINUTES} minutes${AMI_REASON:+: ${AMI_REASON}}"
  fi
  if [ $((SECONDS - AMI_LAST_LOGGED_AT)) -ge 60 ]; then
    log "AMI ${CREATED_AMI} is still ${AMI_STATE}; continuing to wait..."
    AMI_LAST_LOGGED_AT=$SECONDS
  fi
  sleep 15
done

# Record the backing snapshots so teardown can delete them; deleting only the
# AMI leaves the snapshots behind, silently billing forever.
CREATED_SNAPSHOTS="$(aws ec2 describe-images --region "$REGION" --image-ids "$CREATED_AMI" \
  --query 'Images[0].BlockDeviceMappings[].Ebs.SnapshotId' --output text | tr '\t' ' ')"
write_state
log "AMI available. Backing snapshots: ${CREATED_SNAPSHOTS}"

# ─────────────────────────────────────────────────────────────────────────────
# 3. Brand-new security groups
# ─────────────────────────────────────────────────────────────────────────────
# Never production's. The clone accepts traffic ONLY from the load generator's
# security group — not from a CIDR, so it stays correct regardless of how private
# addresses are allocated — and gets no public IP at all.
MY_IP="$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"

CREATED_SG_LOADGEN="$(aws ec2 create-security-group --region "$REGION" \
  --group-name "${RUN_ID}-loadgen" --description "Benchmark load generator ${RUN_ID}" \
  --vpc-id "$SRC_VPC" \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=${TAG_KEY},Value=${TAG_VALUE}},{Key=PressureRunId,Value=${RUN_ID}}]" \
  --query 'GroupId' --output text)"
write_state

CREATED_SG_SUT="$(aws ec2 create-security-group --region "$REGION" \
  --group-name "${RUN_ID}-sut" --description "Benchmark system under test ${RUN_ID}" \
  --vpc-id "$SRC_VPC" \
  --tag-specifications "ResourceType=security-group,Tags=[{Key=${TAG_KEY},Value=${TAG_VALUE}},{Key=PressureRunId,Value=${RUN_ID}}]" \
  --query 'GroupId' --output text)"
write_state
log "security groups: loadgen=${CREATED_SG_LOADGEN} sut=${CREATED_SG_SUT}"

# App port and both probe ports, from the load generator's SG only.
for port in 3000 9098 9099; do
  aws ec2 authorize-security-group-ingress --region "$REGION" \
    --group-id "$CREATED_SG_SUT" --protocol tcp --port "$port" \
    --source-group "$CREATED_SG_LOADGEN" >/dev/null
done
# SSH between the two, so the load generator can drive the run and pull the
# rotated AUTH_SECRET and the sanitize report off the clone.
aws ec2 authorize-security-group-ingress --region "$REGION" \
  --group-id "$CREATED_SG_SUT" --protocol tcp --port 22 --source-group "$CREATED_SG_LOADGEN" >/dev/null

# The operator's own address, for both boxes. Skipped rather than widened if it
# cannot be determined — an unresolved IP must never become 0.0.0.0/0.
if [ -n "$MY_IP" ]; then
  for sg in "$CREATED_SG_SUT" "$CREATED_SG_LOADGEN"; do
    aws ec2 authorize-security-group-ingress --region "$REGION" \
      --group-id "$sg" --protocol tcp --port 22 --cidr "${MY_IP}/32" >/dev/null
  done
  log "SSH from your address (${MY_IP}/32) permitted on both instances"
else
  log "WARNING: could not determine your public IP; no operator SSH rule was added (the run drives everything from the load generator)."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 4. Launch
# ─────────────────────────────────────────────────────────────────────────────
# The clone's cloud-init is deliberately MINIMAL: it masks Docker, shreds the AWS
# credentials and stops. It does not carry sanitize-sut.sh, probe.cjs or the
# compose file, because EC2 rejects user-data over 16 KB and embedding those came
# to ~47 KB (~19 KB even gzipped). run-ec2.sh delivers them over SSH and runs
# ec2/bootstrap-sut.sh, which is what unmasks Docker — only if sanitize succeeded.
SUT_USERDATA="${SCRIPT_DIR}/user-data-sut.yml"
USERDATA_BYTES="$(wc -c < "$SUT_USERDATA")"
[ "$USERDATA_BYTES" -lt 16384 ] || \
  die "the SUT cloud-config is ${USERDATA_BYTES} bytes; EC2 rejects user-data over 16384. Move content into ec2/bootstrap-sut.sh instead."
log "SUT cloud-config: ${USERDATA_BYTES} bytes (limit 16384)"


log "launching the clone..."
CREATED_SUT="$(aws ec2 run-instances --region "$REGION" \
  --image-id "$CREATED_AMI" \
  --instance-type "$SUT_TYPE" \
  --key-name "$KEY_NAME" \
  --subnet-id "$SRC_SUBNET" \
  --security-group-ids "$CREATED_SG_SUT" \
  --no-associate-public-ip-address \
  --instance-initiated-shutdown-behavior terminate \
  --metadata-options "HttpTokens=required,InstanceMetadataTags=enabled" \
  --block-device-mappings "[{\"DeviceName\":\"${SRC_ROOT_DEVICE}\",\"Ebs\":{\"DeleteOnTermination\":true,\"Encrypted\":true}}]" \
  --user-data "file://${SUT_USERDATA}" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=${TAG_KEY},Value=${TAG_VALUE}},{Key=PressureRunId,Value=${RUN_ID}},{Key=Name,Value=${RUN_ID}-sut},{Key=PressureRole,Value=sut}]" \
  --query 'Instances[0].InstanceId' --output text)"
write_state
log "clone launching as ${CREATED_SUT}"

# InstanceMetadataTags=enabled is what lets sanitize-sut.sh read its own
# Purpose tag from IMDS as one of its three identity checks.

INSTALL_K6_B64="$(base64 < "${PRESSURE_DIR}/tools/install-k6.sh" | tr -d '\n')"
BOOTSTRAP_LOADGEN_B64="$(base64 < "${SCRIPT_DIR}/bootstrap-loadgen.sh" | tr -d '\n')"
LOADGEN_USERDATA="${STATE_DIR}/${RUN_ID}-loadgen-userdata.yml"
{
  cat "${SCRIPT_DIR}/user-data-loadgen.yml"
  cat <<EOF

write_files:
  - path: /opt/pressure/install-k6.sh
    permissions: "0700"
    encoding: b64
    content: ${INSTALL_K6_B64}
  - path: /opt/pressure/bootstrap-loadgen.sh
    permissions: "0700"
    encoding: b64
    content: ${BOOTSTRAP_LOADGEN_B64}
EOF
} > "$LOADGEN_USERDATA"

LOADGEN_BYTES="$(wc -c < "$LOADGEN_USERDATA")"
[ "$LOADGEN_BYTES" -lt 16384 ] || \
  die "the load generator cloud-config is ${LOADGEN_BYTES} bytes; EC2 rejects user-data over 16384."

# A current Ubuntu LTS AMI from SSM, so the generator is plain Ubuntu with no
# production data on it — never the production AMI.
UBUNTU_AMI="$(aws ssm get-parameters --region "$REGION" \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text 2>/dev/null || true)"
[ -n "$UBUNTU_AMI" ] && [ "$UBUNTU_AMI" != "None" ] || \
  die "could not resolve an Ubuntu 24.04 AMI from SSM in ${REGION}"

log "launching the load generator (${LOADGEN_TYPE}, Ubuntu ${UBUNTU_AMI})..."
CREATED_LOADGEN="$(aws ec2 run-instances --region "$REGION" \
  --image-id "$UBUNTU_AMI" \
  --instance-type "$LOADGEN_TYPE" \
  --key-name "$KEY_NAME" \
  --subnet-id "$SRC_SUBNET" \
  --security-group-ids "$CREATED_SG_LOADGEN" \
  --associate-public-ip-address \
  --instance-initiated-shutdown-behavior terminate \
  --metadata-options "HttpTokens=required" \
  --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":30,"VolumeType":"gp3","DeleteOnTermination":true,"Encrypted":true}}]' \
  --user-data "file://${LOADGEN_USERDATA}" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=${TAG_KEY},Value=${TAG_VALUE}},{Key=PressureRunId,Value=${RUN_ID}},{Key=Name,Value=${RUN_ID}-loadgen},{Key=PressureRole,Value=loadgen}]" \
  --query 'Instances[0].InstanceId' --output text)"
write_state

log "waiting for both instances to be running..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$CREATED_SUT" "$CREATED_LOADGEN"

SUT_PRIVATE_IP="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$CREATED_SUT" \
  --query 'Reservations[0].Instances[0].PrivateIpAddress' --output text)"
LOADGEN_PUBLIC_IP="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$CREATED_LOADGEN" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"

cat > "$STATE_FILE" <<JSON
{
  "runId": "${RUN_ID}",
  "region": "${REGION}",
  "sourceInstance": "${SOURCE_INSTANCE}",
  "sourceInstanceType": "${SRC_TYPE}",
  "ami": "${CREATED_AMI}",
  "snapshots": "${CREATED_SNAPSHOTS}",
  "sut": "${CREATED_SUT}",
  "sutType": "${SUT_TYPE}",
  "sutVcpus": ${SUT_VCPUS},
  "sutMemoryMiB": ${SUT_MEMORY_MIB},
  "sutPrivateIp": "${SUT_PRIVATE_IP}",
  "loadgen": "${CREATED_LOADGEN}",
  "loadgenType": "${LOADGEN_TYPE}",
  "loadgenPublicIp": "${LOADGEN_PUBLIC_IP}",
  "sgSut": "${CREATED_SG_SUT}",
  "sgLoadgen": "${CREATED_SG_LOADGEN}",
  "az": "${SRC_AZ}",
  "keyName": "${KEY_NAME}",
  "deadmanMinutes": ${DEADMAN_MINUTES}
}
JSON

# Provisioning succeeded, so the failure trap must not fire on a clean exit.
trap - EXIT

if [ "$ORCHESTRATED" = "yes" ]; then
  cat <<SUMMARY

provision: DONE — run ${RUN_ID}
  clone (SUT)      ${CREATED_SUT}   private ${SUT_PRIVATE_IP}   (no public IP)
  load generator   ${CREATED_LOADGEN}   public  ${LOADGEN_PUBLIC_IP}
  state            ${STATE_FILE}

provision: handing the booting instances back to the end-to-end runner...
SUMMARY
else
  cat <<SUMMARY

provision: DONE — run ${RUN_ID}
  clone (SUT)      ${CREATED_SUT}   private ${SUT_PRIVATE_IP}   (no public IP)
  load generator   ${CREATED_LOADGEN}   public  ${LOADGEN_PUBLIC_IP}
  state            ${STATE_FILE}

Both instances are still BOOTING, and the clone's Docker is MASKED: it holds real
production data and the application is deliberately NOT running yet.

run-ec2.sh is what sanitizes it and starts it — it ships ec2/sanitize-sut.sh and
the probe over SSH, then runs ec2/bootstrap-sut.sh, which unmasks Docker ONLY if
sanitize wrote its success marker:

  pressure/run-ec2.sh --run-id ${RUN_ID} --scenario exam-day

If you never run it, the clone sits with the app stopped until the deadman timer
terminates it. Watch the sanitize log with:

  ssh -A ubuntu@${LOADGEN_PUBLIC_IP} "ssh ubuntu@${SUT_PRIVATE_IP} 'sudo cat /var/log/pressure/sanitize.log'"

WHEN YOU ARE DONE — this is not optional, these instances cost money:

  pressure/ec2/teardown.sh --run-id ${RUN_ID} --region ${REGION}

SUMMARY
fi
