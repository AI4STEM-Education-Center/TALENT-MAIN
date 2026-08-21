#!/usr/bin/env bash
# ============================================================================
# 08 — Nightly off-box SQLite snapshots.
#
# WHERE: your laptop.
# TIME:  ~1 minute (plus an interactive `rclone config` on the box the first
#        time, which this script cannot do for you).
#
#   ./scripts/08-backups.sh
#
# This is the second line of defence, not the first: the admin dashboard's
# Database Backup already pushes to WebDAV on a schedule you control there.
# This one exists because that path stores its credentials in the database it
# is backing up, so it cannot help you if the database is what you lost.
#
# Skipped entirely when BACKUP_RCLONE_REMOTE is empty.
# ============================================================================

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config
require_box
refresh_public_ip
require_vars APP_DIR EC2_USER

if [[ -z "${BACKUP_RCLONE_REMOTE:-}" ]]; then
  warn "BACKUP_RCLONE_REMOTE is empty in config.env — nothing to install."
  info "Set it to something like 'onedrive:/TalentBackups' and re-run."
  exit 0
fi
[[ "${BACKUP_KEEP_DAYS:-}" =~ ^[1-9][0-9]*$ ]] \
  || die "BACKUP_KEEP_DAYS must be a positive integer"

step "Installing rclone on the box"
box_ssh "command -v rclone >/dev/null || (curl -fsS https://rclone.org/install.sh | sudo bash)"
ok "present"

if ! box_ssh "rclone listremotes 2>/dev/null | grep -Fxq '${BACKUP_RCLONE_REMOTE%%:*}:'"; then
  cat <<EOF

${c_yellow}The rclone remote '${BACKUP_RCLONE_REMOTE%%:*}' is not configured on the box.${c_reset}

It needs an interactive OAuth flow, so finish it yourself and re-run this:

  ssh -i ${EC2_KEY_FILE} $(box_at)
  rclone config          # choose the provider, name the remote '${BACKUP_RCLONE_REMOTE%%:*}'

A headless box cannot open a browser — use 'rclone authorize' on your laptop
and paste the token back, which rclone config walks you through.
EOF
  exit 1
fi
ok "remote '${BACKUP_RCLONE_REMOTE%%:*}' configured"

SCRIPT=$(mktemp); UNIT=$(mktemp); TIMER=$(mktemp)
trap 'rm -f "$SCRIPT" "$UNIT" "$TIMER"' EXIT

cat > "$SCRIPT" <<EOF
#!/usr/bin/env bash
# Installed by scripts/08-backups.sh. Nightly snapshot of the production
# database to ${BACKUP_RCLONE_REMOTE}.
set -euo pipefail

DB="${APP_DIR}/data/db/prod/prod.db"
STAGE="\$(mktemp -d)"
trap 'rm -rf "\$STAGE"' EXIT
STAMP="\$(date -u +%Y%m%dT%H%M%SZ)"

[[ -f "\$DB" ]] || { echo "no database at \$DB" >&2; exit 1; }

# sqlite3 .backup, not cp: the app is live and WAL-mode pages are still being
# written. Copying the file by hand yields a snapshot that may be mid-
# transaction and will not open. .backup takes a consistent one online.
sqlite3 -readonly "\$DB" ".backup '\$STAGE/prod-\$STAMP.db'"

# Validate SQLite itself before compression. The gzip check below proves only that
# the archive is readable; it says nothing about whether the database pages are
# internally consistent.
CHECK="\$(sqlite3 -readonly "\$STAGE/prod-\$STAMP.db" 'PRAGMA quick_check;')"
[[ "\$CHECK" == ok ]] || { echo "SQLite quick_check failed: \$CHECK" >&2; exit 1; }
gzip -9 "\$STAGE/prod-\$STAMP.db"

# Verify before shipping — a backup that cannot be opened is worse than none,
# because it stops you looking for a real one.
if ! gzip -t "\$STAGE/prod-\$STAMP.db.gz"; then
  echo "archive failed its integrity check, not uploading" >&2
  exit 1
fi

rclone copy "\$STAGE/prod-\$STAMP.db.gz" "${BACKUP_RCLONE_REMOTE}" --no-traverse
rclone delete "${BACKUP_RCLONE_REMOTE}" --min-age ${BACKUP_KEEP_DAYS:-7}d --include 'prod-*.db.gz'

logger -t talent-backup "uploaded prod-\$STAMP.db.gz"
EOF

cat > "$UNIT" <<EOF
[Unit]
Description=Snapshot the production SQLite database off-box
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${EC2_USER}
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
# Lowest possible priority: the snapshot reads the whole database, and it must
# never be the reason a student's quiz submission is slow.
Nice=19
IOSchedulingClass=idle
ExecStart=/usr/local/bin/talent-backup.sh
EOF

cat > "$TIMER" <<'EOF'
[Unit]
Description=Nightly production database backup

[Timer]
OnCalendar=*-*-* 07:15:00 UTC
# Spread the load if several boxes ever share a destination.
RandomizedDelaySec=15min
Persistent=true

[Install]
WantedBy=timers.target
EOF

step "Installing the timer"
box_scp "$SCRIPT" "$(box_at):/tmp/talent-backup.sh"
box_scp "$UNIT"   "$(box_at):/tmp/talent-backup.service"
box_scp "$TIMER"  "$(box_at):/tmp/talent-backup.timer"
box_ssh bash -s <<'REMOTE'
set -euo pipefail
sudo install -m 755 /tmp/talent-backup.sh /usr/local/bin/talent-backup.sh
sudo install -m 644 /tmp/talent-backup.service /etc/systemd/system/talent-backup.service
sudo install -m 644 /tmp/talent-backup.timer   /etc/systemd/system/talent-backup.timer
rm -f /tmp/talent-backup.*
sudo systemctl daemon-reload
sudo systemctl enable --now talent-backup.timer
REMOTE
ok "scheduled for 07:15 UTC daily"

step "Running one now to prove it works end to end"
if ! box_ssh "sudo systemctl start talent-backup.service"; then
  box_ssh "journalctl -u talent-backup.service -n 20 --no-pager"
  die "the first backup failed — see the log above"
fi
RESULT=$(box_ssh "systemctl show talent-backup.service --property=Result --value")
[[ "$RESULT" == success ]] || {
  box_ssh "journalctl -u talent-backup.service -n 20 --no-pager"
  die "the first backup completed with result: ${RESULT}"
}
ok "uploaded"
box_ssh "rclone ls '${BACKUP_RCLONE_REMOTE}' | tail -3" || true

cat <<EOF

${c_green}Backups scheduled.${c_reset}

Restoring: download a .gz, gunzip it, stop the stack, and put the file at
${APP_DIR}/data/db/prod/prod.db, then restore uid 1001 ownership before starting
the stack. These rclone files are named prod-*.db.gz and do not appear in the
admin dashboard, whose Restore button handles its separate backup-*.db.gz
WebDAV files. For a dashboard restore, run 10-apply-webdav-restore.sh after
staging (replacing a live SQLite file under open connections corrupts it).
EOF
