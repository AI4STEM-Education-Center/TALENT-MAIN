#!/usr/bin/env bash
#
# Sanitize a production clone BEFORE the application is allowed to start.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY THIS FILE IS THE MOST IMPORTANT ONE IN THE HARNESS
# ─────────────────────────────────────────────────────────────────────────────
#
# Tier 3 boots from an AMI captured off the RUNNING production instance, so the
# clone starts life holding a byte-for-byte copy of production's disk. That is
# what makes its capacity numbers trustworthy — real row counts, real index
# depths, real page cache behaviour — and it is also what makes it dangerous.
# The clone inherits, verbatim:
#
#   * ~/app/.env  — real AWS access keys, the real CloudFront private key, the
#     real AUTH_SECRET, and the real API_KEY_ENCRYPTION_SECRET.
#   * ~/app/data/db/prod/prod.db — real student records, real graded attempts,
#     and real IRB consent records.
#   * The database rows that configure OUTBOUND side effects: SmtpConfig
#     (email), BackupConfig (WebDAV), and AiProvider (hosted model API keys,
#     decryptable with the inherited encryption secret).
#   * Docker containers with `restart: unless-stopped`.
#
# Left alone, a booted clone would therefore do all of the following on its own,
# with no load test even running:
#
#   1. DELETE REAL PRODUCTION S3 OBJECTS. src/worker.ts runs runS3Gc() every six
#      hours. The collector deletes every object under S3_KEY_PREFIX that no
#      database row references. The clone's compose file pins that prefix to
#      "prod/" — the SAME namespace as production — and the moment the clone's
#      database diverges from production's (which a load test guarantees), the
#      GC concludes production's objects are orphans and removes them.
#      docs/SETUP.md says it outright: "do not point two environments with
#      different databases at the same prefix." This is the worst failure
#      available here, and it is silent.
#   2. EMAIL REAL STUDENTS AND TEACHERS. The message-email and consent-email
#      queues deliver through SmtpConfig, which is enabled and holds working
#      credentials.
#   3. WRITE TO THE REAL WEBDAV BACKUP TARGET, and rotate real backups out under
#      the grandfather-father-son retention policy.
#   4. SEND REAL STUDENT ANSWERS TO A HOSTED AI PROVIDER, billed to the real key.
#   5. SERVE ON PRODUCTION'S HOSTNAMES. The AMI carries the Caddy stack, whose
#      ACME configuration holds a real Cloudflare DNS API token.
#
# So this script is fail-closed by construction: it writes the marker file that
# user-data-sut.sh requires before it will unmask Docker, and any single failing
# step aborts (`set -euo pipefail`) leaving the marker absent and the application
# permanently stopped. A clone that cannot be sanitized never runs at all.
#
# It is idempotent, so a re-run after a fix is safe.
#
# RESIDUAL RISK, STATED PLAINLY: real student data still exists on this instance's
# volume for the lifetime of the run. This script removes the ability to ACT on
# it (no S3 writes, no email, no backup, no hosted AI, no public ingress), but it
# does not anonymize it. That was a deliberate, informed choice to get faithful
# capacity numbers. The compensating controls are provisioning-side: private
# subnet placement, no public IP, a security group reachable only from the load
# generator, encrypted volumes, terminate-on-shutdown, and a deadman timer.

set -euo pipefail

APP_DIR="${APP_DIR:-/home/ubuntu/app}"
MARKER_DIR="/opt/bench"
MARKER="${MARKER_DIR}/SANITIZED"
REPORT="${MARKER_DIR}/sanitize-report.json"
LOG_PREFIX="[sanitize]"

log() { echo "${LOG_PREFIX} $*"; }
die() { echo "${LOG_PREFIX} FATAL: $*" >&2; exit 1; }

mkdir -p "$MARKER_DIR"
# Remove any stale marker FIRST. If this run dies halfway through, the absence of
# the marker is what keeps the app stopped — a leftover marker from a previous
# boot would defeat the entire mechanism.
rm -f "$MARKER"

# ─────────────────────────────────────────────────────────────────────────────
# 0. Refuse to run anywhere except a clone
# ─────────────────────────────────────────────────────────────────────────────
# The nightmare is someone running this script on the production box while
# debugging a failed benchmark. Every step below is destructive to a live
# deployment: it strips AWS credentials, rotates AUTH_SECRET (signing out every
# user), and disables email and backups. So identity is checked three ways and
# any one of them failing is fatal.

TOKEN="$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null || true)"
INSTANCE_ID="$(curl -sS -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  "http://169.254.169.254/latest/meta-data/instance-id" 2>/dev/null || true)"
[ -n "$INSTANCE_ID" ] || die "could not read this instance's id from IMDS; refusing to guess where I am"

# (a) The provisioner passes the production instance id. Matching it means this
#     IS production.
if [ -n "${BENCH_SOURCE_INSTANCE_ID:-}" ] && [ "$INSTANCE_ID" = "$BENCH_SOURCE_INSTANCE_ID" ]; then
  die "this instance ($INSTANCE_ID) IS the source/production instance. Refusing to sanitize a live deployment."
fi

# (b) The clone is tagged at launch. An untagged instance is not one of ours.
PURPOSE="$(curl -sS -H "X-aws-ec2-metadata-token: ${TOKEN}" \
  "http://169.254.169.254/latest/meta-data/tags/instance/Purpose" 2>/dev/null || true)"
if [ "$PURPOSE" != "alw-benchmark" ]; then
  die "instance $INSTANCE_ID is not tagged Purpose=alw-benchmark (got '${PURPOSE:-<none>}'). Refusing to touch it."
fi

# (c) The provisioner requires an explicit acknowledgement that this clone
#     carries real data. No acknowledgement, no run.
[ "${BENCH_ACK_REAL_DATA:-}" = "yes" ] || \
  die "BENCH_ACK_REAL_DATA=yes was not passed. The operator must acknowledge that this clone holds production data."

log "identity confirmed: clone $INSTANCE_ID (source was ${BENCH_SOURCE_INSTANCE_ID:-unknown})"

# ─────────────────────────────────────────────────────────────────────────────
# 1. Docker must still be masked
# ─────────────────────────────────────────────────────────────────────────────
# user-data-sut.sh masks Docker in `bootcmd`, which cloud-init runs before
# multi-user.target and therefore before docker.service would have started the
# `restart: unless-stopped` production containers. If Docker is somehow already
# running, containers may have started with real credentials and the S3 GC may
# already have scheduled work — at which point sanitizing is closing the door
# after the fact, and the honest thing is to stop and say so.
if systemctl is-active --quiet docker 2>/dev/null; then
  die "docker is ALREADY RUNNING before sanitize. Production containers may have started with real credentials. Terminate this clone and investigate cloud-init ordering."
fi
log "docker is masked/stopped as expected"

# ─────────────────────────────────────────────────────────────────────────────
# 2. Neutralize the environment file
# ─────────────────────────────────────────────────────────────────────────────
ENV_FILE="${APP_DIR}/.env"
[ -f "$ENV_FILE" ] || die "no ${ENV_FILE} on this clone — the AMI is not what we expected"

# Keep an untouched copy for post-run forensics, readable only by root. It is
# deleted with the instance.
cp -a "$ENV_FILE" "${MARKER_DIR}/env.original"
chmod 600 "${MARKER_DIR}/env.original"

set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # `|` delimiter: values contain / and + (base64, URLs).
    sed -i "s|^${key}=.*|${key}=\"${value}\"|" "$ENV_FILE"
  else
    echo "${key}=\"${value}\"" >> "$ENV_FILE"
  fi
}

# ── 2a. AWS credentials: REMOVED, not repointed ─────────────────────────────
# This is the control that makes deleting production S3 objects impossible
# rather than merely unlikely. getAwsCredentials() in src/lib/storage.ts THROWS
# when the keys are absent (docs/SETUP.md documents this as deliberate), so
# every S3 call — including runS3Gc's ListObjectsV2 and DeleteObjects — fails
# fast and loudly instead of succeeding against the real bucket.
#
# Chosen over setting S3_KEY_PREFIX=bench/ because a prefix is a
# behavioural guard that one stale compose file or one environment override can
# defeat, whereas absent credentials cannot be worked around by configuration.
#
# The cost is that upload paths 500 during a run. Accepted: uploads are a
# teacher-initiated, low-concurrency flow, and no scenario exercises them. The
# error taxonomy records those as unexpected errors so they can never pass
# unnoticed as success.
set_env "AWS_ACCESS_KEY_ID" ""
set_env "AWS_SECRET_ACCESS_KEY" ""
set_env "AWS_SESSION_TOKEN" ""
log "AWS credentials stripped (S3 GC and every S3 write now fail closed)"

# ── 2b. CloudFront signing keys: KEPT, on purpose ───────────────────────────
# Signing a CloudFront URL is a purely local RSA operation — it never contacts
# AWS and grants no write access. Keeping these is what lets the run measure the
# real per-URL signing cost that commit af6fe35 introduced, which is one of the
# main things tier 3 exists to quantify. Removing them would silently change
# signObjectReadUrl's branch (src/lib/storage.ts) and understate quiz-start
# latency for every media-bearing question.
if grep -qE '^CLOUDFRONT_DOMAIN="?.+' "$ENV_FILE"; then
  log "CloudFront signing keys retained (local RSA only — needed to measure signing cost)"
else
  log "WARNING: no CloudFront config on this clone; media signing will use S3 presign, which is far cheaper"
fi

# ── 2c. Rotate AUTH_SECRET ──────────────────────────────────────────────────
# Bidirectional isolation. A fresh secret means (i) a session cookie stolen from
# production cannot be replayed against the clone, and (ii) the thousands of
# cookies this harness mints for the clone are worthless against production.
# Sessions are JWT-only (src/lib/auth.ts), so rotating this invalidates
# everything with no server-side state to clean up. The provisioner reads the
# new value back over SSH to mint sessions with it.
NEW_AUTH_SECRET="$(openssl rand -base64 48 | tr -d '\n=' )"
set_env "AUTH_SECRET" "$NEW_AUTH_SECRET"
log "AUTH_SECRET rotated (production cookies are invalid here, and vice versa)"

# ── 2d. Identity + storage namespace ────────────────────────────────────────
set_env "APP_ENV" "bench"
set_env "S3_KEY_PREFIX" "bench/"
# The app builds emailed links from these. Pointing them at the real hostnames
# would put production URLs into stub emails and, worse, make any accidental
# outbound mail look authentic.
set_env "APP_URL" "http://127.0.0.1:3000"
set_env "APP_BASE_URL" "http://127.0.0.1:3000"
set_env "PROD_APP_URL" "http://127.0.0.1:3000"
set_env "DEV_APP_URL" "http://127.0.0.1:3000"
# Cloudflare DNS token: only Caddy uses it, and Caddy never starts here, but an
# unused live token on a throwaway box is free risk.
set_env "CF_API_TOKEN" ""
set_env "ACME_EMAIL" ""
log "identity set to APP_ENV=bench, S3 prefix bench/, Cloudflare token cleared"

# ─────────────────────────────────────────────────────────────────────────────
# 3. Neutralize outbound side effects that live in the DATABASE
# ─────────────────────────────────────────────────────────────────────────────
# These cannot be turned off with an environment variable: SMTP, the backup
# schedule and AI providers are all configured through admin UI rows. The clone
# inherited them switched ON and working.

DB_PATH="${BENCH_DB_PATH:-${APP_DIR}/data/db/prod/prod.db}"
[ -f "$DB_PATH" ] || die "expected the cloned database at ${DB_PATH} but it is not there"

command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 is not installed; cannot neutralize database-held configuration"

# The AMI was captured with --no-reboot, so the filesystem is crash-consistent
# rather than cleanly unmounted: the database may hold an unreplayed WAL.
# Checkpoint and verify BEFORE trusting any row in it. A corrupt clone would
# otherwise produce a load profile full of phantom errors that look like app bugs.
log "recovering WAL and checking integrity of the cloned database..."
sqlite3 "$DB_PATH" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
INTEGRITY="$(sqlite3 "$DB_PATH" "PRAGMA integrity_check;" | head -1)"
[ "$INTEGRITY" = "ok" ] || die "cloned database failed integrity_check ('${INTEGRITY}'). Re-snapshot production; do not benchmark a corrupt database."
log "database integrity: ok"

# Row counts, recorded so the report can state what dataset the numbers describe.
USERS="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM User;")"
ATTEMPTS="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM QuizAttempt;")"
ANSWERS="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM QuizAnswer;")"

# Single transaction: a partial application here would leave, say, email off but
# backups on. Table names are the @@map values where they differ from the model.
sqlite3 "$DB_PATH" <<SQL
BEGIN IMMEDIATE;

-- Email: hard off. Blanking the credentials as well as the flag means flipping
-- isActive back on by hand still cannot deliver anything.
UPDATE SmtpConfig SET isActive = 0, host = 'localhost.invalid', port = 25, secure = 0,
                      username = NULL, passwordEnc = NULL, passwordIv = NULL, passwordTag = NULL,
                      fromEmail = 'bench@invalid';

-- Scheduled WebDAV backups: off, target blanked, next run cleared so
-- claimDueBackup() finds nothing to do.
UPDATE BackupConfig SET enabled = 0, webdavUrl = NULL, webdavUsername = NULL,
                        passwordEnc = NULL, passwordIv = NULL, passwordTag = NULL,
                        nextRunAt = NULL, lastStatus = 'DISABLED_FOR_BENCHMARK';

-- AI providers: repoint every one at the local stub instead of disabling them.
-- Disabling would make the worker skip generation entirely (providerUsable()
-- returns false), leaving the worker idle and understating the load the real
-- system carries. providerType='local' with a baseUrl needs no API key, so the
-- inherited encrypted keys are never decrypted or used.
UPDATE AiProvider SET providerType = 'local',
                      baseUrl = 'http://host.docker.internal:8099/v1',
                      apiKeyEnc = NULL, apiKeyIv = NULL, apiKeyTag = NULL,
                      cfAigByokAlias = NULL,
                      isActive = 1;

COMMIT;
SQL

SMTP_ACTIVE="$(sqlite3 "$DB_PATH" "SELECT COALESCE(MAX(isActive),0) FROM SmtpConfig;")"
BACKUP_ENABLED="$(sqlite3 "$DB_PATH" "SELECT COALESCE(MAX(enabled),0) FROM BackupConfig;")"
HOSTED_AI="$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM AiProvider WHERE providerType <> 'local';")"

# Verify, do not assume. An UPDATE against a table that happens to be empty
# reports success while changing nothing, so each control is read back.
[ "$SMTP_ACTIVE" = "0" ]   || die "SMTP is still active after sanitize (isActive=${SMTP_ACTIVE})"
[ "$BACKUP_ENABLED" = "0" ] || die "scheduled backups are still enabled after sanitize"
[ "$HOSTED_AI" = "0" ]      || die "${HOSTED_AI} AI provider row(s) still point at a hosted API"
log "outbound side effects disabled and verified: email off, backups off, AI pointed at the local stub"

# ─────────────────────────────────────────────────────────────────────────────
# 4. Make sure the edge stack can never start
# ─────────────────────────────────────────────────────────────────────────────
# Caddy would try to serve production hostnames and solve an ACME DNS-01
# challenge with a real Cloudflare token. The benchmark talks straight to the
# container port over the private network, so Caddy has no role here at all.
for compose in docker-compose.caddy.yml docker-compose.yml docker-compose.dev.yml; do
  if [ -f "${APP_DIR}/${compose}" ]; then
    mv "${APP_DIR}/${compose}" "${APP_DIR}/${compose}.disabled-for-benchmark"
    log "neutralized ${compose} (the run uses docker-compose.sut.yml only)"
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
# 5. Deadman timer
# ─────────────────────────────────────────────────────────────────────────────
# A leaked instance is the expensive failure, so there are three independent
# guards; this is the one that survives the operator's laptop dying mid-run.
# Combined with --instance-initiated-shutdown-behavior terminate at launch, this
# self-terminates the clone even if nothing else ever talks to it again.
DEADMAN_MIN="${BENCH_DEADMAN_MINUTES:-240}"
shutdown -h "+${DEADMAN_MIN}" "benchmark deadman: terminating in ${DEADMAN_MIN} minutes" || \
  log "WARNING: could not arm the deadman timer"
log "deadman armed: self-terminate in ${DEADMAN_MIN} minutes"

# ─────────────────────────────────────────────────────────────────────────────
# 6. Write the marker
# ─────────────────────────────────────────────────────────────────────────────
cat > "$REPORT" <<JSON
{
  "sanitizedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "instanceId": "${INSTANCE_ID}",
  "sourceInstanceId": "${BENCH_SOURCE_INSTANCE_ID:-unknown}",
  "controls": {
    "awsCredentialsStripped": true,
    "cloudFrontSigningRetained": true,
    "authSecretRotated": true,
    "smtpDisabled": true,
    "scheduledBackupsDisabled": true,
    "aiProvidersRepointedToStub": true,
    "edgeStackNeutralized": true,
    "deadmanMinutes": ${DEADMAN_MIN}
  },
  "dataset": {
    "note": "real production data, recovered from a --no-reboot AMI and integrity-checked",
    "integrityCheck": "${INTEGRITY}",
    "users": ${USERS},
    "quizAttempts": ${ATTEMPTS},
    "quizAnswers": ${ANSWERS}
  },
  "residualRisk": "Real student and consent data remain on this volume until the instance is terminated. This clone cannot email, cannot write to S3, cannot back up, and cannot reach a hosted AI provider."
}
JSON

# The provisioner reads the rotated secret back over SSH to mint sessions.
printf '%s' "$NEW_AUTH_SECRET" > "${MARKER_DIR}/auth-secret"
chmod 600 "${MARKER_DIR}/auth-secret"

# Written LAST, and only if every step above succeeded. user-data-sut.sh will not
# unmask Docker without it.
date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER"

log "SANITIZED — marker written. The application may now start."
cat "$REPORT"
