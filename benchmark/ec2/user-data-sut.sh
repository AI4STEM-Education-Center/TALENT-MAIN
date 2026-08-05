#!/bin/bash
#
# cloud-init for the system under test (the production clone).
#
# Deliberately minimal: install Docker, create the directories, write the .env,
# authenticate to the registry, and arm a self-destruct. Everything else — the
# compose file, the probe, the mock AI provider, the golden database — is shipped
# over SSH by provision.sh, because EC2 caps user-data at 16 KiB and because the
# instance should run exactly the files in the working tree, not a snapshot
# embedded in a launch parameter.
#
# Placeholders are substituted by provision.sh's render(); the rendered copy is
# saved into the run's results directory so the run is reproducible.

set -euxo pipefail
exec > >(tee /var/log/bench-setup.log) 2>&1

RUN_ID="__RUN_ID__"
IMAGE="__IMAGE__"
MAX_RUNTIME_MIN="__MAX_RUNTIME_MIN__"
GHCR_USER="__GHCR_USER__"
GHCR_TOKEN="__GHCR_TOKEN__"

# ─── Self-destruct, armed first ──────────────────────────────────────────────
# Before anything that could fail or hang. The instance is launched with
# instance-initiated-shutdown-behavior=terminate, so this actually terminates
# rather than leaving a stopped instance and its volume behind. provision.sh's
# EXIT trap is the normal teardown path; this is the backstop for the case where
# the orchestrator itself dies (lost SSH, killed CI job, closed laptop).
shutdown -h "+${MAX_RUNTIME_MIN}" \
  "benchmark ${RUN_ID}: self-destruct after ${MAX_RUNTIME_MIN} minutes" || true

export DEBIAN_FRONTEND=noninteractive
apt-get update -y

# sysstat gives metrics.sh its iostat series — the EBS queue-depth and %util
# numbers that distinguish "CPU bound" from "the volume is the bottleneck".
# sqlite3 lets it read the Honker queue depth read-only.
apt-get install -y ca-certificates curl gnupg sysstat sqlite3 jq

# ─── Docker ─────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  . /etc/os-release
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" \
    -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
systemctl enable --now docker

for candidate in admin ubuntu ec2-user debian; do
  if id "$candidate" >/dev/null 2>&1; then
    usermod -aG docker "$candidate" || true
  fi
done

# ─── Layout ─────────────────────────────────────────────────────────────────
mkdir -p /opt/bench/data /opt/bench/instrument /opt/bench/mock-ai /opt/bench/metrics
# 777 on the data directory and 666 on the database mirror what
# scripts/ec2-setup.sh does in production: the container runs as uid 1001 and has
# to create the -wal and -shm siblings next to the database file.
chmod 777 /opt/bench/data

# ─── Environment ────────────────────────────────────────────────────────────
# Freshly generated secrets, never production's. Nothing here can decrypt a
# production AI provider key even if the instance were somehow reachable.
cat >/opt/bench/.env <<EOF
NODE_ENV=production
APP_ENV=dev
DATABASE_URL=file:/app/prisma/data/bench.db
AUTH_SECRET=__AUTH_SECRET__
API_KEY_ENCRYPTION_SECRET=__ENCRYPTION_SECRET__
TEACHER_SIGNUP_TOKEN=bench-teacher-token
ADMIN_SIGNUP_TOKEN=bench-admin-token
S3_KEY_PREFIX=bench/
BENCH_IMAGE=${IMAGE}
EOF
chmod 600 /opt/bench/.env

# ─── Registry ───────────────────────────────────────────────────────────────
if [[ -n "$GHCR_TOKEN" ]]; then
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "${GHCR_USER:-x-access-token}" --password-stdin
fi
# Pulled here so the (slow) image fetch overlaps with the orchestrator's local
# seeding rather than serialising after it.
docker pull "$IMAGE" || echo "WARNING: pre-pull failed; compose up will retry"

# ─── Kernel knobs ───────────────────────────────────────────────────────────
# Only the two that would otherwise cap a load test below the application's real
# limit and make the benchmark measure the OS instead. Everything else is left
# at the production default on purpose — a tuned clone is not a clone.
sysctl -w net.core.somaxconn=4096
sysctl -w net.ipv4.tcp_max_syn_backlog=4096

touch /opt/bench/.cloud-init-complete
echo "bench SUT ready: ${RUN_ID}"
