#!/usr/bin/env bash
# ============================================================================
# 10 — Safely apply a WebDAV restore staged in Admin > Database Backup.
#
# WHERE: your laptop, after the admin Restore button reports success.
#
#   ./scripts/10-apply-webdav-restore.sh prod
#   ./scripts/10-apply-webdav-restore.sh dev
#
# Stops both processes that hold the selected environment's SQLite database, preserves the
# current database with SQLite's online-safe backup command, recreates the
# stack so the web entrypoint applies the staged file, and verifies the result.
# ============================================================================

# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
load_config
need_cmd ssh
require_box
refresh_public_ip
require_vars APP_DIR

TARGET_ENV="${1:-}"
case "$TARGET_ENV" in
  prod|dev) ;;
  *) die "usage: $0 <prod|dev> [--yes]" ;;
esac
AUTO_CONFIRM="${2:-}"

MARKER="${APP_DIR}/data/db/${TARGET_ENV}/.pending-restore"
STAGED="${APP_DIR}/data/db/${TARGET_ENV}/.restore-staged.db"

step "Checking the staged restore"
box_ssh "test -s '${MARKER}' && test -s '${STAGED}'" \
  || die "no complete ${TARGET_ENV} restore is staged; queue it in that environment's Admin > Database Backup, wait for RESTORE_STAGED, then retry"
ok "marker and staged database are present"

if [[ "$AUTO_CONFIRM" != "--yes" ]]; then
  printf '%sThis replaces the %s database with the staged WebDAV backup.%s\n' "$c_yellow" "$TARGET_ENV" "$c_reset"
  read -r -p "Type RESTORE to stop ${TARGET_ENV} and continue: " answer
  [[ "$answer" == RESTORE ]] || die "restore cancelled"
fi

step "Stopping ${TARGET_ENV}, preserving the current DB, and applying the restore"
box_ssh bash -s -- "$APP_DIR" "$TARGET_ENV" <<'REMOTE'
set -euo pipefail

app_dir="$1"
target_env="$2"
db_dir="${app_dir}/data/db/${target_env}"
db="${db_dir}/${target_env}.db"
marker="${db_dir}/.pending-restore"
staged="${db_dir}/.restore-staged.db"

if [[ "$target_env" == prod ]]; then
  compose=(docker compose)
  services=(worker web)
  web_container=talent-web
  worker_container=talent-worker
else
  compose=(docker compose -f docker-compose.dev.yml)
  services=(worker-dev web-dev)
  web_container=talent-web-dev
  worker_container=talent-worker-dev
fi

[[ -s "$marker" && -s "$staged" ]] || {
  echo "staged restore disappeared before apply" >&2
  exit 1
}

check=$(sqlite3 -readonly "$staged" 'PRAGMA integrity_check;')
[[ "$check" == ok ]] || {
  echo "staged database failed integrity_check: $check" >&2
  exit 1
}
[[ $(sqlite3 -readonly "$staged" "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='User';") == 1 ]] \
  || { echo "staged file is not an application database" >&2; exit 1; }

cd "$app_dir"
"${compose[@]}" stop "${services[@]}"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
previous="${app_dir}/backups/pre-webdav-${target_env}-restore-${stamp}.db"
mkdir -p "${app_dir}/backups"
sqlite3 -readonly "$db" ".backup '$previous'"
chmod 600 "$previous"
echo "Preserved the pre-restore database at $previous"

if ! "${compose[@]}" up -d --wait --wait-timeout 150 --force-recreate --no-build; then
  echo "The restored stack did not become healthy." >&2
  echo "The pre-restore database remains at $previous; inspect docker logs ${web_container}." >&2
  exit 1
fi

[[ ! -e "$marker" && ! -e "$staged" ]] || {
  echo "the container became healthy without consuming the staged restore" >&2
  exit 1
}
[[ $(docker inspect -f '{{.State.Health.Status}}' "$web_container") == healthy ]] \
  || { echo "${web_container} is not healthy" >&2; exit 1; }
[[ $(docker inspect -f '{{.State.Running}}' "$worker_container") == true ]] \
  || { echo "${worker_container} is not running" >&2; exit 1; }

check=$(sqlite3 -readonly "$db" 'PRAGMA integrity_check;')
[[ "$check" == ok ]] || {
  echo "restored live database failed integrity_check: $check" >&2
  exit 1
}

echo "RESTORE_PREVIOUS=$previous"
REMOTE
ok "restore applied; web is healthy, worker is running, SQLite integrity_check is ok"

cat <<EOF

${c_green}${TARGET_ENV} restore completed.${c_reset}

The temporary bootstrap admin was part of the fresh database and is now gone.
Sign in with an administrator account from the restored backup, then:

  1. Open Admin > Database Backup and test the restored WebDAV configuration.
  2. Confirm API/SMTP provider credentials decrypt without errors.
  3. Run ./scripts/09-verify.sh.

Keep the printed pre-restore database until those checks pass.
EOF
