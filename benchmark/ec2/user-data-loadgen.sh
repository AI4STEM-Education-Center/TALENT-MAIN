#!/bin/bash
#
# cloud-init for the load generator.
#
# A separate instance from the system under test, on purpose. The application is
# bottlenecked on a single CPU executing synchronous SQLite queries; running k6
# beside it would have the measurement tool competing for exactly the resource
# under measurement, quietly inflating every latency it reports. Same AZ, so
# network latency stays sub-millisecond and the numbers describe the app rather
# than the internet.
#
# Installs only what the harness needs: the k6 binary and Node (for the session
# minter). Placeholders are substituted by provision.sh's render().

set -euxo pipefail
exec > >(tee /var/log/bench-loadgen-setup.log) 2>&1

RUN_ID="__RUN_ID__"
MAX_RUNTIME_MIN="__MAX_RUNTIME_MIN__"
K6_VERSION="__K6_VERSION__"

# Armed first, for the same reason as on the SUT: if the orchestrator dies, the
# instance still terminates instead of billing indefinitely.
shutdown -h "+${MAX_RUNTIME_MIN}" \
  "benchmark ${RUN_ID}: self-destruct after ${MAX_RUNTIME_MIN} minutes" || true

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl gnupg tar jq

# k6 itself is installed by provision.sh via benchmark/tools/install-k6.sh once
# the harness has been staged — one checksum-verifying implementation shared with
# CI, rather than a second unverified download path here. K6_VERSION is recorded
# so the run manifest can state which version produced the numbers.
echo "K6_VERSION=${K6_VERSION}" >/etc/bench-k6-version

# ─── Node ───────────────────────────────────────────────────────────────────
# Only for benchmark/tools/mint-sessions.ts. The app's own toolchain is not
# needed here: the dataset arrives pre-seeded from the orchestrator.
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node --version

# ─── Load-generator-side limits ─────────────────────────────────────────────
# Raised only on this box. A few hundred VUs each holding keep-alive connections
# will otherwise exhaust the generator's own file descriptors and ephemeral
# ports, and the resulting errors would be misread as the server failing.
# The SUT keeps production's defaults so that it, not the client, is the thing
# being measured.
cat >>/etc/security/limits.conf <<'EOF'
* soft nofile 262144
* hard nofile 262144
EOF
sysctl -w net.ipv4.ip_local_port_range="10000 65535"
sysctl -w net.ipv4.tcp_tw_reuse=1
sysctl -w net.core.somaxconn=8192
sysctl -w fs.file-max=262144

mkdir -p /opt/harness
for candidate in admin ubuntu ec2-user debian; do
  if id "$candidate" >/dev/null 2>&1; then
    chown -R "$candidate":"$candidate" /opt/harness
  fi
done

touch /opt/harness/.cloud-init-complete
echo "bench load generator ready: ${RUN_ID} (k6 ${K6_VERSION})"
