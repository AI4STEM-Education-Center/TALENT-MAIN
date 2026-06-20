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

echo "Applying database schema..."
node ./node_modules/prisma/build/index.js db push --accept-data-loss 2>&1 || {
  echo "WARNING: prisma db push failed — the app will start but may have schema issues" >&2
}

exec node server.js
