#!/bin/sh
set -e

if [ -z "${DATABASE_URL:-}" ] && [ -n "${PROD_DATABASE_URL:-}" ]; then
  export DATABASE_URL="${PROD_DATABASE_URL}"
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL or PROD_DATABASE_URL must be set" >&2
  exit 1
fi

# If launched as the background worker, skip migrations (web handles them)
# and run the bundled worker script directly.
if [ "${1:-}" = "worker" ]; then
  echo "Starting background worker..."
  exec node worker.js
fi

# Apply a staged database restore (armed by the admin "Restore" button, which
# downloads + verifies a backup into the DB's data dir). The swap happens here —
# at boot, before any connection is opened — because replacing a live SQLite
# file under open connections corrupts it. The web service owns this; the worker
# starts after it (depends_on). DATABASE_URL resolves to /app/prisma/data/<db>.
DB_DIR="/app/prisma/data"
if [ -f "$DB_DIR/.pending-restore" ] && [ -f "$DB_DIR/.restore-staged.db" ]; then
  DB_BASENAME="$(basename "${DATABASE_URL#file:}")"
  TARGET="$DB_DIR/$DB_BASENAME"
  echo "Applying staged database restore -> $TARGET"
  mv -f "$DB_DIR/.restore-staged.db" "$TARGET"
  rm -f "$TARGET-wal" "$TARGET-shm"
fi
rm -f "$DB_DIR/.pending-restore"

# One-time cutover: move any legacy `_honker_*` queue tables OUT of the app DB
# into their own sibling `<name>.queue.db` file (see docker/migrate-honker-db.cjs).
# Historically Honker shared the Prisma DB, so `db push` wants to drop those
# unknown tables — a destructive diff that makes the production push refuse. This
# migrates them losslessly first so the push diff is purely additive. No-ops once
# migrated. If it fails we SKIP the push rather than risk dropping queued jobs.
echo "Checking Honker queue tables (one-time cutover)..."
node ./migrate-honker-db.cjs || {
  echo "ERROR: Honker queue migration failed. Skipping schema push to avoid" >&2
  echo "       dropping queued jobs. The app will start, but schema changes are" >&2
  echo "       NOT applied until this is resolved." >&2
  exec node server.js
}

echo "Applying database schema..."
# In production we do NOT pass --accept-data-loss: additive changes (new
# tables/columns) still apply automatically, but a destructive change makes
# `db push` refuse rather than silently drop data — surfacing it for manual
# review. Non-production (dev/CI containers) keeps --accept-data-loss so the
# schema can be reset freely. The longer-term path is versioned
# `prisma migrate deploy`; that requires establishing a migration history first.
if [ "${NODE_ENV:-}" = "production" ]; then
  PUSH_FLAGS=""
else
  PUSH_FLAGS="--accept-data-loss"
fi
# shellcheck disable=SC2086
node ./node_modules/prisma/build/index.js db push $PUSH_FLAGS 2>&1 || {
  echo "WARNING: prisma db push failed — the app will start but may have schema issues." >&2
  echo "         In production this can mean a destructive schema change needs manual review." >&2
}

exec node server.js
