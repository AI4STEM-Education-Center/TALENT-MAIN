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

echo "Applying database schema..."
node ./node_modules/prisma/build/index.js db push --accept-data-loss 2>&1 || {
  echo "WARNING: prisma db push failed — the app will start but may have schema issues" >&2
}

exec node server.js
