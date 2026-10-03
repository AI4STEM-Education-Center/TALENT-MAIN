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

# The application path comes from the production image, which is Debian (cloud
# user `admin`), not Ubuntu. Detect it rather than hardcoding one distro's
# layout; an explicit APP_DIR from the runner still wins.
APP_DIR="${APP_DIR:-}"
if [ -z "$APP_DIR" ]; then
  APP_DIR="$(ls -d /home/*/app 2>/dev/null | head -1)"
fi
APP_DIR="${APP_DIR:-/home/admin/app}"
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
APP_DIR="${APP_DIR}" \
  sudo -E /opt/pressure/sanitize-sut.sh 2>&1 | sudo tee -a /var/log/pressure/sanitize.log

# THE GATE. Written as an explicit test rather than relying on the pipeline's
# exit status, because `... | tee` reports tee's status, not sanitize's — and
# getting that wrong here would unmask Docker after a FAILED sanitize.
[ -f /opt/pressure/SANITIZED ] || die "sanitize did NOT complete — /opt/pressure/SANITIZED is absent. Docker stays masked. Terminate this clone."

log "sanitize confirmed. Unmasking Docker..."
sudo rm -f /opt/pressure/AWAITING_SANITIZE
# Mirrors the neutralization in user-data-sut.yml exactly. That file masks
# containerd as well as docker, and additionally strips the exec bits off the
# daemons as a systemd-independent backstop — the mask is written as a plain
# symlink there because `systemctl mask` deadlocks the early boot, and a plain
# symlink is ignored if systemd had already loaded the unit. Undo BOTH halves,
# or docker unmasks cleanly and then fails to exec for a non-obvious reason.
#
# Safe to use systemctl here: this runs over SSH on a fully booted system, not
# in cloud-init's pre-sysinit stage.
sudo systemctl unmask docker docker.socket containerd
# Docker tried to start during boot and hit 203/EXEC against the stripped
# binary, so systemd has it in `failed` with the restart counter tripped
# ("Start request repeated too quickly"). Without a reset it refuses to start
# now that the binary is executable again.
sudo systemctl reset-failed docker.service docker.socket containerd.service 2>/dev/null || true
for b in /usr/bin/dockerd /usr/sbin/dockerd /usr/bin/containerd /usr/bin/docker; do
  [ -e "$b" ] && sudo chmod 755 "$b"
done
sudo systemctl start docker

log "starting the benchmark stack (web + worker)..."
cd "$APP_DIR"
sudo docker compose -f docker-compose.sut.yml up -d --wait --wait-timeout 300 \
  || { sudo docker compose -f docker-compose.sut.yml logs --tail 80; die "the stack did not become healthy"; }

sudo touch /opt/pressure/READY
log "READY — the application is up and the clone is sanitized."
