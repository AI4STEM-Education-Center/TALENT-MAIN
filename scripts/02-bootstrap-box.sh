#!/usr/bin/env bash
# ============================================================================
# 02 — Turn a bare Debian instance into the deployment host.
#
# WHERE: on the box, as $EC2_USER (not root).
# TIME:  ~4 minutes, mostly apt.
#
#   scp -i ~/.ssh/talent-admin.pem scripts/lib.sh \
#     scripts/02-bootstrap-box.sh scripts/config.box.env admin@<ip>:~/setup/
#   ssh -i ~/.ssh/talent-admin.pem admin@<ip>
#   cd ~/setup && CONFIG_FILE=~/setup/config.box.env ./02-bootstrap-box.sh
#
# Installs Docker, creates the directory layout, creates the shared `edge`
# network, logs in to GHCR, generates the deploy key GitHub Actions will use,
# and adds swap. Safe to re-run.
# ============================================================================

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config
require_vars PROJECT EC2_USER APP_DIR CADDY_DIR GHCR_IMAGE

[[ $EUID -ne 0 ]] || die "run as ${EC2_USER}, not root — the docker group membership and \$HOME paths depend on it"

# The container runs as uid 1001 (nextjs in docker/Dockerfile). Keep that uid as
# owner, but use the EC2 user's primary group with setgid directories so the
# off-box backup service can read SQLite and its WAL without making either
# writable by other local accounts.
readonly APP_UID=1001

# ---------------------------------------------------------------------------
step "System packages"
# ---------------------------------------------------------------------------
sudo apt-get update -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get upgrade -y -qq
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  ca-certificates curl jq sqlite3 unzip cron unattended-upgrades
ok "base packages installed"

# ---------------------------------------------------------------------------
step "Key-only SSH"
# ---------------------------------------------------------------------------
# GitHub-hosted runners do not have a stable, compact source range, so the
# security group admits port 22 publicly. Make that safe at the protocol layer:
# no passwords, no keyboard-interactive fallback, no root login, and only the
# cloud account used by both administrators and the deploy workflow.
SSH_POLICY=$(mktemp)
trap 'rm -f "$SSH_POLICY"' EXIT
cat > "$SSH_POLICY" <<EOF
PasswordAuthentication no
KbdInteractiveAuthentication no
ChallengeResponseAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AuthenticationMethods publickey
MaxAuthTries 3
LoginGraceTime 30
AllowUsers ${EC2_USER}
EOF
sudo install -m 644 "$SSH_POLICY" /etc/ssh/sshd_config.d/99-talent-hardening.conf
sudo sshd -t || die "the generated sshd policy is invalid; refusing to reload"
sudo systemctl reload ssh
ok "password/root login disabled; public keys required"

# ---------------------------------------------------------------------------
step "Unattended security upgrades"
# ---------------------------------------------------------------------------
# The box is exposed to Cloudflare's whole range on 443; unpatched OpenSSL is
# the likeliest way in. Security-pocket updates only, so a feature upgrade
# never restarts the app unannounced.
sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
sudo systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
ok "enabled"

# ---------------------------------------------------------------------------
step "Docker"
# ---------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  ok "already installed ($(docker --version))"
else
  curl -fsSL https://get.docker.com | sudo sh
  ok "installed"
fi
if ! id -nG "$USER" | grep -qw docker; then
  sudo usermod -aG docker "$USER"
  warn "added $USER to the docker group — log out and back in, then re-run this script"
  warn "(every docker command below needs the new group membership)"
  exit 1
fi
sudo systemctl enable --now docker >/dev/null
ok "docker usable as $USER"

# ---------------------------------------------------------------------------
step "Swap"
# ---------------------------------------------------------------------------
# t3.small is 2 GiB. Rasterizing a large PDF, with prod web + worker + dev web
# + worker + Caddy resident, will touch the ceiling; without swap the kernel
# kills whichever container asked for memory last, which in practice is the
# one doing the upload.
if ! sudo swapon --show | grep -q .; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile >/dev/null
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  ok "2 GiB swapfile active"
else
  ok "swap already configured"
fi

# ---------------------------------------------------------------------------
step "Directory layout"
# ---------------------------------------------------------------------------
mkdir -p "$APP_DIR"/data/db/prod "$APP_DIR"/data/db/dev "$APP_DIR"/logs "$APP_DIR"/backups
mkdir -p "$CADDY_DIR"/logs
ok "$APP_DIR and $CADDY_DIR"

# SQLite needs the file to exist and be writable by the container user before
# the first connection; `db push` at container start will not create the
# directory for it.
for env_name in prod dev; do
  db="$APP_DIR/data/db/${env_name}/${env_name}.db"
  [[ -f "$db" ]] || sqlite3 "$db" "VACUUM;"
done
BACKUP_GID=$(id -g)
sudo chown -R "${APP_UID}:${BACKUP_GID}" "$APP_DIR/data/db"
sudo find "$APP_DIR/data/db" -type d -exec chmod 2750 {} +
sudo find "$APP_DIR/data/db" -type f -exec chmod 0640 {} +
ok "databases owned by uid ${APP_UID}, readable by ${USER}'s group, not world-accessible"

# ---------------------------------------------------------------------------
step "Shared docker network"
# ---------------------------------------------------------------------------
# Caddy, prod and dev are three Compose projects. Compose will not create a
# network shared across projects, so it is declared `external: true` in all
# three files and created once here.
if docker network inspect edge >/dev/null 2>&1; then
  ok "network 'edge' exists"
else
  docker network create edge >/dev/null
  ok "created network 'edge'"
fi

# ---------------------------------------------------------------------------
step "GHCR login"
# ---------------------------------------------------------------------------
if [[ -n "${GHCR_TOKEN:-}" && -n "${GHCR_USER:-}" ]]; then
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
  ok "logged in as ${GHCR_USER}"
else
  warn "GHCR_USER/GHCR_TOKEN not set — skipping. Needed only if the package is private."
fi

# ---------------------------------------------------------------------------
step "Deploy key for GitHub Actions"
# ---------------------------------------------------------------------------
KEY=~/.ssh/github_actions
mkdir -p ~/.ssh
chmod 700 ~/.ssh
if [[ ! -f "$KEY" ]]; then
  ssh-keygen -t ed25519 -f "$KEY" -N "" -C "github-actions@${PROJECT}" >/dev/null
  ok "generated private key"
fi
[[ -f "${KEY}.pub" ]] || ssh-keygen -y -f "$KEY" > "${KEY}.pub"
touch ~/.ssh/authorized_keys
grep -qxF "$(cat "${KEY}.pub")" ~/.ssh/authorized_keys \
  || cat "${KEY}.pub" >> ~/.ssh/authorized_keys
chmod 600 "$KEY" ~/.ssh/authorized_keys
chmod 644 "${KEY}.pub"
ok "deploy public key authorized exactly once"

cat <<EOF

${c_green}Box ready.${c_reset}

Set these three GitHub repository secrets
(Settings > Secrets and variables > Actions):

  EC2_HOST     $(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || echo '<this box public IP>')
  EC2_USER     ${USER}
  EC2_SSH_KEY  ${KEY} (private; pipe it directly into gh secret set from the
               laptop instead of printing or copying it through a clipboard)

Next: return to your laptop and run ./scripts/03-provision-storage.sh,
then ./scripts/04-app-env.sh.
EOF
