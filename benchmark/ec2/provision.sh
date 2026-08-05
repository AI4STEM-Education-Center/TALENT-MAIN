#!/usr/bin/env bash
#
# Tier 3 — one command, whole run, nothing left behind.
#
#   benchmark/ec2/provision.sh --source-instance i-0abc… --scenario exam-day
#
# What it does, unattended:
#   1. reads the production instance's own configuration (type, AMI, subnet, IAM
#      profile, root-volume type/size/IOPS/throughput) so the clone matches the
#      thing you actually care about — a benchmark on a different instance type
#      is a benchmark of a different system
#   2. creates a throwaway keypair and security group scoped to the runner's IP
#   3. launches the clone (SUT) plus a separate load generator in the same AZ
#   4. ships the pre-seeded golden database and this benchmark directory
#   5. runs the scenario, sampling host + container + in-process metrics
#   6. copies everything back to benchmark/results/<runId>/ and summarises
#   7. terminates every resource it created, on success, failure, or Ctrl-C
#
# Production is never touched: nothing is created in prod's security group, and
# the clone is launched from prod's AMI into a fresh volume with a fresh database.
#
# The load generator is a separate instance on purpose. Running k6 on the SUT
# would have the measurement tool competing for the single CPU the application
# is bottlenecked on, which silently inflates every latency it reports.
#
# Requirements: aws cli v2 (configured), jq, ssh/scp, and a local `npm ci` so the
# dataset can be seeded here rather than installing a toolchain on the instances.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BENCH_DIR="$REPO_ROOT/benchmark"

# ─── Defaults ────────────────────────────────────────────────────────────────

SOURCE_INSTANCE=""
SOURCE_NAME_TAG=""
SCENARIO="exam-day"
IMAGE="ghcr.io/ai4stem-education-center/talent-main:dev-latest"
LOADGEN_TYPE="t3.medium"
SSH_USER="admin"
MAX_RUNTIME_MIN=180
K6_VERSION="2.1.0"
BENCH_SCALE="1"
KEEP=false
SKIP_SEED=false
DRY_RUN=false
EXTRA_K6_ENV=()

RUN_ID="bench-$(date -u +%Y%m%d-%H%M%S)-$$"

usage() {
  cat <<'USAGE'
usage: provision.sh [options]

  --source-instance ID   instance to clone the configuration of (or --source-name)
  --source-name NAME     look the source up by its Name tag instead
  --scenario NAME        exam-day | ramp-capacity | spike-recovery | soak |
                         login-storm | smoke            (default exam-day)
  --image REF            container image to run          (default dev-latest)
  --loadgen-type TYPE    load generator instance type    (default t3.medium)
  --ssh-user USER        login user for the AMI          (default admin)
  --scale N              dataset scale factor            (default 1)
  --max-runtime-min N    self-destruct deadline          (default 180)
  --ghcr-user USER       GHCR username (or env GHCR_USER)
  --ghcr-token TOKEN     GHCR read:packages token (or env GHCR_TOKEN/GITHUB_TOKEN)
  --env KEY=VALUE        extra env var passed to k6 (repeatable)
  --skip-seed            reuse benchmark/docker/data/bench.db as-is
  --keep                 leave the instances running (they still self-destruct)
  --dry-run              print the plan and exit

Costs a few cents: two instances for the length of the run, then terminated.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source-instance) SOURCE_INSTANCE="$2"; shift 2 ;;
    --source-name) SOURCE_NAME_TAG="$2"; shift 2 ;;
    --scenario) SCENARIO="$2"; shift 2 ;;
    --image) IMAGE="$2"; shift 2 ;;
    --loadgen-type) LOADGEN_TYPE="$2"; shift 2 ;;
    --ssh-user) SSH_USER="$2"; shift 2 ;;
    --scale) BENCH_SCALE="$2"; shift 2 ;;
    --max-runtime-min) MAX_RUNTIME_MIN="$2"; shift 2 ;;
    --ghcr-user) GHCR_USER="$2"; shift 2 ;;
    --ghcr-token) GHCR_TOKEN="$2"; shift 2 ;;
    --env) EXTRA_K6_ENV+=("$2"); shift 2 ;;
    --skip-seed) SKIP_SEED=true; shift ;;
    --keep) KEEP=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $1" >&2; usage; exit 2 ;;
  esac
done

GHCR_USER="${GHCR_USER:-}"
GHCR_TOKEN="${GHCR_TOKEN:-${GITHUB_TOKEN:-}}"
# Optional pinned digest for the k6 download. Unset falls back to the release's
# published checksums — see benchmark/tools/install-k6.sh.
K6_SHA256="${K6_SHA256:-}"
RESULTS_DIR="$BENCH_DIR/results/$RUN_ID"

log() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ─── Preflight ───────────────────────────────────────────────────────────────

log "Preflight"
for tool in aws jq ssh scp; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required but not installed"
done
aws sts get-caller-identity >/dev/null 2>&1 || die "aws cli is not authenticated"
[[ -n "$SOURCE_INSTANCE" || -n "$SOURCE_NAME_TAG" ]] ||
  die "pass --source-instance or --source-name so the clone can match production"
[[ -f "$BENCH_DIR/k6/scenarios/$SCENARIO.js" ]] ||
  die "no scenario at benchmark/k6/scenarios/$SCENARIO.js"

if [[ -z "$SOURCE_INSTANCE" ]]; then
  info "resolving instance by Name tag: $SOURCE_NAME_TAG"
  SOURCE_INSTANCE=$(aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=$SOURCE_NAME_TAG" "Name=instance-state-name,Values=running" \
    --query 'Reservations[0].Instances[0].InstanceId' --output text)
  [[ "$SOURCE_INSTANCE" != "None" && -n "$SOURCE_INSTANCE" ]] ||
    die "no running instance tagged Name=$SOURCE_NAME_TAG"
fi

# ─── Read the source configuration ───────────────────────────────────────────

log "Reading configuration from $SOURCE_INSTANCE"
SOURCE_JSON=$(aws ec2 describe-instances --instance-ids "$SOURCE_INSTANCE" \
  --query 'Reservations[0].Instances[0]')

INSTANCE_TYPE=$(jq -r '.InstanceType' <<<"$SOURCE_JSON")
AMI_ID=$(jq -r '.ImageId' <<<"$SOURCE_JSON")
SUBNET_ID=$(jq -r '.SubnetId' <<<"$SOURCE_JSON")
VPC_ID=$(jq -r '.VpcId' <<<"$SOURCE_JSON")
AZ=$(jq -r '.Placement.AvailabilityZone' <<<"$SOURCE_JSON")
ROOT_DEVICE=$(jq -r '.RootDeviceName' <<<"$SOURCE_JSON")
IAM_PROFILE=$(jq -r '.IamInstanceProfile.Arn // empty' <<<"$SOURCE_JSON")

# The volume matters as much as the instance type. gp2 and burstable gp3 have a
# burst credit bucket that a soak will drain — cloning the size but not the
# type/IOPS would hide exactly the cliff soak.js is designed to find.
ROOT_VOLUME_ID=$(jq -r --arg dev "$ROOT_DEVICE" \
  '.BlockDeviceMappings[] | select(.DeviceName==$dev) | .Ebs.VolumeId' <<<"$SOURCE_JSON")
VOLUME_JSON=$(aws ec2 describe-volumes --volume-ids "$ROOT_VOLUME_ID" \
  --query 'Volumes[0]' --output json)
VOLUME_TYPE=$(jq -r '.VolumeType' <<<"$VOLUME_JSON")
VOLUME_SIZE=$(jq -r '.Size' <<<"$VOLUME_JSON")
VOLUME_IOPS=$(jq -r '.Iops // empty' <<<"$VOLUME_JSON")
VOLUME_THROUGHPUT=$(jq -r '.Throughput // empty' <<<"$VOLUME_JSON")

info "instance type : $INSTANCE_TYPE   ($AZ)"
info "ami           : $AMI_ID"
info "root volume   : ${VOLUME_SIZE}GiB $VOLUME_TYPE iops=${VOLUME_IOPS:-default} tput=${VOLUME_THROUGHPUT:-default}"
info "subnet / vpc  : $SUBNET_ID / $VPC_ID"
info "iam profile   : ${IAM_PROFILE:-none}"

case "$INSTANCE_TYPE" in
  t2.*|t3.*|t3a.*|t4g.*)
    info ""
    info "NOTE: $INSTANCE_TYPE is burstable. CPU credits drain under sustained load, so a"
    info "      short run can look excellent and a 60-minute soak can fall off a cliff."
    info "      Run --scenario soak before trusting any capacity number from this host."
    ;;
esac

if [[ "$DRY_RUN" == true ]]; then
  log "Dry run — plan only"
  info "would launch 1× $INSTANCE_TYPE (SUT) + 1× $LOADGEN_TYPE (loadgen) in $AZ"
  info "would run scenario '$SCENARIO' against the clone, then terminate both"
  exit 0
fi

mkdir -p "$RESULTS_DIR"

# ─── Cleanup, wired before anything is created ───────────────────────────────
# Registered now so a failure between any two steps still tears down whatever
# already exists. Leaked EC2 instances are the expensive kind of bug.

SUT_ID=""
LOADGEN_ID=""
SG_ID=""
KEY_NAME=""
KEY_FILE="$RESULTS_DIR/bench-key.pem"

cleanup() {
  local exit_code=$?
  set +e
  if [[ "$KEEP" == true && -n "$SUT_ID" ]]; then
    log "--keep: leaving instances up"
    info "sut     : $SUT_ID ($(cat "$RESULTS_DIR/sut-ip" 2>/dev/null || echo '?'))"
    info "loadgen : $LOADGEN_ID"
    info "ssh     : ssh -i $KEY_FILE $SSH_USER@\$(cat $RESULTS_DIR/sut-public-ip)"
    info "they self-terminate after ${MAX_RUNTIME_MIN}m regardless"
    info "clean up now with: benchmark/ec2/teardown.sh --run-id $RUN_ID"
    exit $exit_code
  fi

  log "Teardown"
  local ids=()
  [[ -n "$SUT_ID" ]] && ids+=("$SUT_ID")
  [[ -n "$LOADGEN_ID" ]] && ids+=("$LOADGEN_ID")
  if [[ ${#ids[@]} -gt 0 ]]; then
    info "terminating ${ids[*]}"
    aws ec2 terminate-instances --instance-ids "${ids[@]}" >/dev/null 2>&1
    aws ec2 wait instance-terminated --instance-ids "${ids[@]}" 2>/dev/null
  fi
  # The security group cannot be deleted until its ENIs are gone, which is why
  # this waits for full termination first.
  if [[ -n "$SG_ID" ]]; then
    info "deleting security group $SG_ID"
    aws ec2 delete-security-group --group-id "$SG_ID" >/dev/null 2>&1
  fi
  if [[ -n "$KEY_NAME" ]]; then
    info "deleting keypair $KEY_NAME"
    aws ec2 delete-key-pair --key-name "$KEY_NAME" >/dev/null 2>&1
    rm -f "$KEY_FILE"
  fi
  info "results kept in $RESULTS_DIR"
  exit $exit_code
}
trap cleanup EXIT INT TERM

# ─── Seed the golden database locally ────────────────────────────────────────
# Seeded here rather than on the instance for three reasons: the instances need
# no Node toolchain, the dataset is byte-identical across every run and every
# tier, and a seed failure costs nothing because no instance exists yet.

DB_FILE="$BENCH_DIR/docker/data/bench.db"
if [[ "$SKIP_SEED" == true ]]; then
  [[ -f "$DB_FILE" ]] || die "--skip-seed given but $DB_FILE does not exist"
  info "reusing existing $DB_FILE"
else
  log "Seeding golden dataset (scale $BENCH_SCALE)"
  mkdir -p "$(dirname "$DB_FILE")"
  rm -f "$DB_FILE" "$DB_FILE-wal" "$DB_FILE-shm"
  (
    cd "$REPO_ROOT"
    DATABASE_URL="file:$DB_FILE" npx prisma db push --accept-data-loss --skip-generate >/dev/null
    # The AI provider's baseUrl is baked into the shipped database, so it must be
    # the address the *container* will resolve — the compose service name, not a
    # loopback the app could never reach.
    DATABASE_URL="file:$DB_FILE" BENCH_SCALE="$BENCH_SCALE" \
      BENCH_MOCK_AI_URL="http://bench-mock-ai:8088/v1" \
      BENCH_MANIFEST_DIR="$RESULTS_DIR" npx tsx benchmark/seed/seed-bench.ts
  ) || die "seeding failed"
fi

info "compressing for transfer"
gzip -9 -c "$DB_FILE" >"$RESULTS_DIR/bench.db.gz"
info "$(du -h "$RESULTS_DIR/bench.db.gz" | cut -f1) compressed"

# ─── Network + credentials ───────────────────────────────────────────────────

log "Creating throwaway keypair and security group"
KEY_NAME="$RUN_ID"
aws ec2 create-key-pair --key-name "$KEY_NAME" \
  --query 'KeyMaterial' --output text >"$KEY_FILE"
chmod 600 "$KEY_FILE"

MY_IP=$(curl -fsS -m 10 https://checkip.amazonaws.com | tr -d '[:space:]')
[[ -n "$MY_IP" ]] || die "could not determine this machine's public IP"

# A dedicated group, never production's: this run must not be able to widen
# prod's ingress even transiently.
SG_ID=$(aws ec2 create-security-group \
  --group-name "$RUN_ID" \
  --description "Ephemeral benchmark run $RUN_ID" \
  --vpc-id "$VPC_ID" --query 'GroupId' --output text)
aws ec2 create-tags --resources "$SG_ID" \
  --tags "Key=Purpose,Value=alw-benchmark" "Key=RunId,Value=$RUN_ID" >/dev/null

aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
  --protocol tcp --port 22 --cidr "$MY_IP/32" >/dev/null
# Intra-group only: the load generator reaches the app and the probes over the
# private network, and nothing outside the group can.
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
  --protocol tcp --port 3000-3000 --source-group "$SG_ID" >/dev/null
aws ec2 authorize-security-group-ingress --group-id "$SG_ID" \
  --protocol tcp --port 9464-9465 --source-group "$SG_ID" >/dev/null
info "sg $SG_ID — ssh from $MY_IP/32, app+probe intra-group only"

# ─── Launch ──────────────────────────────────────────────────────────────────

block_device_mapping() {
  local ebs
  ebs=$(jq -n --arg type "$VOLUME_TYPE" --argjson size "$VOLUME_SIZE" \
    '{VolumeType:$type, VolumeSize:$size, DeleteOnTermination:true}')
  [[ -n "$VOLUME_IOPS" ]] && ebs=$(jq --argjson iops "$VOLUME_IOPS" '.Iops=$iops' <<<"$ebs")
  [[ -n "$VOLUME_THROUGHPUT" ]] &&
    ebs=$(jq --argjson tp "$VOLUME_THROUGHPUT" '.Throughput=$tp' <<<"$ebs")
  jq -n --arg dev "$ROOT_DEVICE" --argjson ebs "$ebs" '[{DeviceName:$dev, Ebs:$ebs}]'
}

launch() {
  local role="$1" type="$2" user_data_file="$3" ami="$4"
  local args=(
    --image-id "$ami"
    --instance-type "$type"
    --key-name "$KEY_NAME"
    --subnet-id "$SUBNET_ID"
    --security-group-ids "$SG_ID"
    --associate-public-ip-address
    --user-data "file://$user_data_file"
    # So the self-destruct `shutdown -h` actually terminates rather than leaving
    # a stopped instance (and its volume) behind.
    --instance-initiated-shutdown-behavior terminate
    --tag-specifications
      "ResourceType=instance,Tags=[{Key=Name,Value=$RUN_ID-$role},{Key=Purpose,Value=alw-benchmark},{Key=RunId,Value=$RUN_ID},{Key=Role,Value=$role}]"
      "ResourceType=volume,Tags=[{Key=Purpose,Value=alw-benchmark},{Key=RunId,Value=$RUN_ID}]"
    --query 'Instances[0].InstanceId' --output text
  )
  if [[ "$role" == "sut" ]]; then
    args+=(--block-device-mappings "$(block_device_mapping)")
    # Match production's IAM role so S3 access behaves identically.
    [[ -n "$IAM_PROFILE" ]] && args+=(--iam-instance-profile "Arn=$IAM_PROFILE")
  fi
  aws ec2 run-instances "${args[@]}"
}

log "Rendering cloud-init"
SUT_USER_DATA="$RESULTS_DIR/user-data-sut.rendered.sh"
LOADGEN_USER_DATA="$RESULTS_DIR/user-data-loadgen.rendered.sh"

render() {
  # Values are substituted rather than templated at runtime so the rendered
  # scripts land in the results directory and the run is fully reproducible.
  sed \
    -e "s|__RUN_ID__|$RUN_ID|g" \
    -e "s|__IMAGE__|$IMAGE|g" \
    -e "s|__MAX_RUNTIME_MIN__|$MAX_RUNTIME_MIN|g" \
    -e "s|__K6_VERSION__|$K6_VERSION|g" \
    -e "s|__GHCR_USER__|$GHCR_USER|g" \
    -e "s|__GHCR_TOKEN__|$GHCR_TOKEN|g" \
    -e "s|__AUTH_SECRET__|$(openssl rand -hex 32)|g" \
    -e "s|__ENCRYPTION_SECRET__|$(openssl rand -hex 32)|g" \
    "$1" >"$2"
}
render "$BENCH_DIR/ec2/user-data-sut.sh" "$SUT_USER_DATA"
render "$BENCH_DIR/ec2/user-data-loadgen.sh" "$LOADGEN_USER_DATA"

log "Launching instances"
SUT_ID=$(launch sut "$INSTANCE_TYPE" "$SUT_USER_DATA" "$AMI_ID")
info "sut     $SUT_ID ($INSTANCE_TYPE, cloned from $SOURCE_INSTANCE)"
LOADGEN_ID=$(launch loadgen "$LOADGEN_TYPE" "$LOADGEN_USER_DATA" "$AMI_ID")
info "loadgen $LOADGEN_ID ($LOADGEN_TYPE)"

aws ec2 wait instance-running --instance-ids "$SUT_ID" "$LOADGEN_ID"

instance_ip() {
  aws ec2 describe-instances --instance-ids "$1" \
    --query "Reservations[0].Instances[0].$2" --output text
}
SUT_PRIVATE_IP=$(instance_ip "$SUT_ID" PrivateIpAddress)
SUT_PUBLIC_IP=$(instance_ip "$SUT_ID" PublicIpAddress)
LOADGEN_PUBLIC_IP=$(instance_ip "$LOADGEN_ID" PublicIpAddress)
echo "$SUT_PRIVATE_IP" >"$RESULTS_DIR/sut-ip"
echo "$SUT_PUBLIC_IP" >"$RESULTS_DIR/sut-public-ip"
info "sut private ip $SUT_PRIVATE_IP / public $SUT_PUBLIC_IP"

SSH_OPTS=(-i "$KEY_FILE" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null
          -o ConnectTimeout=10 -o LogLevel=ERROR)
sut_ssh() { ssh "${SSH_OPTS[@]}" "$SSH_USER@$SUT_PUBLIC_IP" "$@"; }
loadgen_ssh() { ssh "${SSH_OPTS[@]}" "$SSH_USER@$LOADGEN_PUBLIC_IP" "$@"; }

log "Waiting for cloud-init"
wait_for_cloud_init() {
  local host="$1" label="$2"
  for _ in $(seq 1 60); do
    if ssh "${SSH_OPTS[@]}" "$SSH_USER@$host" \
        'sudo cloud-init status --wait >/dev/null 2>&1 || cloud-init status --wait >/dev/null 2>&1' \
        2>/dev/null; then
      info "$label ready"
      return 0
    fi
    sleep 10
  done
  die "$label never finished cloud-init — check /var/log/cloud-init-output.log"
}
wait_for_cloud_init "$SUT_PUBLIC_IP" "sut"
wait_for_cloud_init "$LOADGEN_PUBLIC_IP" "loadgen"

# ─── Stage the dataset and the harness ──────────────────────────────────────

log "Staging the harness on the clone"
# Shipped over SSH rather than embedded in user-data: EC2 caps user-data at
# 16 KiB, and the probe, the compose file and the sampler together exceed that.
# It also means the instance runs exactly the files in this working tree.
scp "${SSH_OPTS[@]}" \
  "$RESULTS_DIR/bench.db.gz" \
  "$BENCH_DIR/instrument/probe.cjs" \
  "$BENCH_DIR/collect/metrics.sh" \
  "$BENCH_DIR/ec2/docker-compose.sut.yml" \
  "$SSH_USER@$SUT_PUBLIC_IP:/tmp/"

# The mock AI provider is bundled as plain JS: the runtime image has no tsx, and
# installing a toolchain on the clone would change the very CPU contention being
# measured.
(cd "$REPO_ROOT" && npx esbuild benchmark/mock-ai/server.ts \
  --bundle --platform=node --target=node20 \
  --outfile="$RESULTS_DIR/mock-ai.js" --log-level=warning) || die "mock-ai bundle failed"
scp "${SSH_OPTS[@]}" "$RESULTS_DIR/mock-ai.js" "$SSH_USER@$SUT_PUBLIC_IP:/tmp/"

sut_ssh 'bash -s' <<'REMOTE'
set -euo pipefail
sudo mkdir -p /opt/bench/data /opt/bench/instrument /opt/bench/mock-ai /opt/bench/metrics
sudo mv /tmp/probe.cjs /opt/bench/instrument/probe.cjs
sudo mv /tmp/mock-ai.js /opt/bench/mock-ai/server.js
sudo mv /tmp/docker-compose.sut.yml /opt/bench/docker-compose.yml
sudo mv /tmp/metrics.sh /opt/bench/metrics.sh
sudo chmod +x /opt/bench/metrics.sh

# Decompressed under the container's runtime uid (1001, per docker/Dockerfile) so
# the app can write both the database and the -wal/-shm siblings it creates.
sudo gunzip -c /tmp/bench.db.gz | sudo tee /opt/bench/data/bench.db >/dev/null
sudo rm -f /opt/bench/data/bench.db-wal /opt/bench/data/bench.db-shm /tmp/bench.db.gz
sudo chown -R 1001:1001 /opt/bench/data
sudo chmod 777 /opt/bench/data
sudo chmod 666 /opt/bench/data/bench.db
sudo chown -R "$USER":"$USER" /opt/bench/metrics
REMOTE

log "Starting the application stack"
sut_ssh "cd /opt/bench && sudo docker compose up -d && sleep 5 && sudo docker compose ps"

info "waiting for the app to answer"
for attempt in $(seq 1 60); do
  if sut_ssh 'curl -fsS -m 5 http://127.0.0.1:3000/login >/dev/null 2>&1'; then
    info "app is up after ${attempt}0s"
    break
  fi
  [[ "$attempt" == 60 ]] && die "app never became healthy — see 'docker compose logs' on $SUT_PUBLIC_IP"
  sleep 10
done

log "Staging the harness on the load generator"
tar -C "$REPO_ROOT" -czf "$RESULTS_DIR/harness.tgz" \
  --exclude 'benchmark/results' --exclude 'benchmark/docker/data' benchmark
scp "${SSH_OPTS[@]}" "$RESULTS_DIR/harness.tgz" "$SSH_USER@$LOADGEN_PUBLIC_IP:/tmp/"
scp "${SSH_OPTS[@]}" "$RESULTS_DIR/dataset.json" "$SSH_USER@$LOADGEN_PUBLIC_IP:/tmp/"
loadgen_ssh 'bash -s' <<'REMOTE'
set -euo pipefail
sudo mkdir -p /opt/harness
sudo tar -C /opt/harness -xzf /tmp/harness.tgz
sudo mkdir -p /opt/harness/benchmark/results
sudo cp /tmp/dataset.json /opt/harness/benchmark/results/dataset.json
sudo chown -R "$USER":"$USER" /opt/harness
REMOTE

# Installed from the staged harness rather than downloaded in user-data, so there
# is one checksum-verifying code path shared with CI.
loadgen_ssh "K6_VERSION=$K6_VERSION K6_SHA256='${K6_SHA256:-}' \
  bash /opt/harness/benchmark/tools/install-k6.sh" || die "k6 install failed"

# Sessions are minted from the load generator, against the clone's private IP,
# with spread source IPs — direct to origin, so the 10/min/IP limiter does not
# turn a 360-user mint into a 36-minute wait. See tools/mint-sessions.ts.
log "Minting sessions"
loadgen_ssh "cd /opt/harness && npx --yes tsx benchmark/tools/mint-sessions.ts \
  --url http://$SUT_PRIVATE_IP:3000 --spread-ip=true --concurrency 8" ||
  die "session minting failed"

# ─── Run ─────────────────────────────────────────────────────────────────────

log "Starting metrics collection on the clone"
sut_ssh "sudo mkdir -p /opt/bench/metrics && sudo chown -R \$USER:\$USER /opt/bench/metrics && \
  nohup /opt/bench/metrics.sh start --out /opt/bench/metrics --interval 5 \
    --queue-db /opt/bench/data/bench-queue.db >/dev/null 2>&1 || true"

log "Running scenario: $SCENARIO"
K6_ENV=(
  "BENCH_TIER=ec2"
  "BENCH_BASE_URL=http://$SUT_PRIVATE_IP:3000"
  "BENCH_PROBE_URL=http://$SUT_PRIVATE_IP:9464"
  "BENCH_RESULTS_DIR=/opt/harness/benchmark/results"
)
K6_ENV+=("${EXTRA_K6_ENV[@]}")
K6_ARGS=""
for pair in "${K6_ENV[@]}"; do K6_ARGS+=" --env $pair"; done

set +e
# --summary-trend-stats is required, not cosmetic: k6's default trend set omits
# p(99) and count, and the reporter needs both.
loadgen_ssh "cd /opt/harness/benchmark/k6/scenarios && k6 run$K6_ARGS \
  --summary-trend-stats='avg,min,med,max,p(90),p(95),p(99),count' \
  --summary-export=/opt/harness/benchmark/results/k6-summary.json \
  $SCENARIO.js 2>&1 | tee /opt/harness/benchmark/results/k6.log"
K6_EXIT=$?
set -e
info "k6 exited with $K6_EXIT (non-zero means a threshold was breached)"

log "Stopping metrics collection"
sut_ssh "/opt/bench/metrics.sh stop --out /opt/bench/metrics || true"

# ─── Collect ─────────────────────────────────────────────────────────────────

log "Collecting results"
scp "${SSH_OPTS[@]}" -r "$SSH_USER@$LOADGEN_PUBLIC_IP:/opt/harness/benchmark/results/*" \
  "$RESULTS_DIR/" 2>/dev/null || true
scp "${SSH_OPTS[@]}" -r "$SSH_USER@$SUT_PUBLIC_IP:/opt/bench/metrics/*" \
  "$RESULTS_DIR/" 2>/dev/null || true
# Container logs are where an OOM kill or a Prisma error hides; a summary alone
# would leave a failed run undiagnosable after teardown.
sut_ssh "cd /opt/bench && sudo docker compose logs --no-color --tail 5000" \
  >"$RESULTS_DIR/container-logs.txt" 2>&1 || true
sut_ssh "ls -la /opt/bench/data" >"$RESULTS_DIR/final-db-listing.txt" 2>&1 || true

cat >"$RESULTS_DIR/run.json" <<EOF
{
  "runId": "$RUN_ID",
  "scenario": "$SCENARIO",
  "tier": "ec2",
  "image": "$IMAGE",
  "sourceInstance": "$SOURCE_INSTANCE",
  "instanceType": "$INSTANCE_TYPE",
  "availabilityZone": "$AZ",
  "amiId": "$AMI_ID",
  "rootVolume": {
    "type": "$VOLUME_TYPE",
    "sizeGiB": $VOLUME_SIZE,
    "iops": "${VOLUME_IOPS:-default}",
    "throughput": "${VOLUME_THROUGHPUT:-default}"
  },
  "loadgenType": "$LOADGEN_TYPE",
  "datasetScale": "$BENCH_SCALE",
  "k6Version": "$K6_VERSION",
  "k6ExitCode": $K6_EXIT
}
EOF

log "Summarising"
(cd "$REPO_ROOT" && npx tsx benchmark/collect/summarize.ts \
  --run "$RESULTS_DIR" --tier ec2 --label "$SCENARIO@$INSTANCE_TYPE") || true

log "Done"
info "results  : $RESULTS_DIR"
info "summary  : $RESULTS_DIR/summary.md"
[[ -f "$RESULTS_DIR/summary.md" ]] && sed -n '1,12p' "$RESULTS_DIR/summary.md"

exit $K6_EXIT
