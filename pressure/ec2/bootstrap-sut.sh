#!/usr/bin/env bash
#
# Sanitize the clone, then — and only then — start the application.
#
# Runs ON the clone, invoked by run-ec2.sh after the payload has been delivered
# over SSH. It exists as a separate script from sanitize-sut.sh so that the two
# responsibilities stay separate and individually auditable:
#
#   sanitize-sut.sh   removes the clone's ability to cause real-world side
#                     effects, and writes /opt/pressure/SANITIZED only if every
#                     control was applied AND read back.
#   bootstrap-sut.sh  (this file) enforces that marker as a GATE, unmasks Docker,
#                     and brings up the benchmark stack.
#
# THE GATE IS THE POINT. Docker was masked in cloud-init `bootcmd`, before
# multi-user.target, so the inherited `restart: unless-stopped` production
# containers never started. Nothing unmasks it except the line below, and that
# line is unreachable unless sanitize succeeded. `set -e` plus an explicit
# `test -f` means a partial sanitize leaves the application permanently stopped
# rather than running with production credentials.
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/app}"
log() { echo "[bootstrap] $*"; }
die() { echo "[bootstrap] FATAL: $*" >&2; exit 1; }

[ -f /opt/pressure/sanitize-sut.sh ] || die "sanitize-sut.sh was not delivered to /opt/pressure"
[ -f /opt/pressure/probe.cjs ] || die "probe.cjs was not delivered to /opt/pressure"
[ -f "${APP_DIR}/docker-compose.sut.yml" ] || die "docker-compose.sut.yml was not delivered to ${APP_DIR}"

log "running sanitize..."
chmod +x /opt/pressure/sanitize-sut.sh
# Environment, not flags: sanitize-sut.sh reads these and refuses to run without
# them (they are two of its three independent identity checks).
PRESSURE_SOURCE_INSTANCE_ID="${PRESSURE_SOURCE_INSTANCE_ID:-}" \
PRESSURE_ACK_REAL_DATA="${PRESSURE_ACK_REAL_DATA:-}" \
PRESSURE_DEADMAN_MINUTES="${PRESSURE_DEADMAN_MINUTES:-240}" \
PRESSURE_DB_PATH="${PRESSURE_DB_PATH:-}" \
  sudo -E /opt/pressure/sanitize-sut.sh 2>&1 | sudo tee -a /var/log/pressure/sanitize.log

# THE GATE. Written as an explicit test rather than relying on the pipeline's
# exit status, because `... | tee` reports tee's status, not sanitize's — and
# getting that wrong here would unmask Docker after a FAILED sanitize.
[ -f /opt/pressure/SANITIZED ] || die "sanitize did NOT complete — /opt/pressure/SANITIZED is absent. Docker stays masked. Terminate this clone."

log "sanitize confirmed. Unmasking Docker..."
sudo rm -f /opt/pressure/AWAITING_SANITIZE
sudo systemctl unmask docker docker.socket
sudo systemctl start docker

log "starting the benchmark stack (web + worker)..."
cd "$APP_DIR"
sudo docker compose -f docker-compose.sut.yml up -d --wait --wait-timeout 300 \
  || { sudo docker compose -f docker-compose.sut.yml logs --tail 80; die "the stack did not become healthy"; }

sudo touch /opt/pressure/READY
log "READY — the application is up and the clone is sanitized."
