#!/usr/bin/env bash
#
# Tier 3 — drive a run against a provisioned EC2 clone, from your laptop.
#
#   pressure/ec2/provision.sh --source-instance i-0abc --ack-real-data
#   pressure/run-ec2.sh --run-id pressure-20260820-193000 --scenario exam-day
#   pressure/ec2/teardown.sh --run-id pressure-20260820-193000
#
# The load generator does the work; this script orchestrates over SSH. k6 never
# runs on the system under test, because the app is bottlenecked on a single CPU
# (synchronous better-sqlite3, pure-JS bcrypt, RSA URL signing) and a load
# generator sharing that CPU would understate capacity by however much it took.
#
# Artifacts are SCRUBBED on the load generator before download: the clone holds
# real production data, so container logs and k6 error bodies can contain real
# names and addresses (see collect/scrub.ts).
set -euo pipefail

PRESSURE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${PRESSURE_DIR}/.." && pwd)"
STATE_DIR="${PRESSURE_DIR}/.tmp/ec2"

RUN_ID=""
SCENARIO="smoke"
REGION="${AWS_REGION:-}"
SSH_KEY=""
SCALE="1"
STUDENT_COUNT=""
SUITE_STUDENT_COUNT=""
SUITE_RUN="no"
ORCHESTRATED="no"
SKIP_TEARDOWN="yes"

log() { echo "run-ec2: $*"; }
die() { echo "run-ec2: FATAL: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --run-id) RUN_ID="$2"; shift 2 ;;
    --scenario) SCENARIO="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --ssh-key) SSH_KEY="$2"; shift 2 ;;
    --scale) SCALE="$2"; shift 2 ;;
    --students) STUDENT_COUNT="$2"; shift 2 ;;
    --cohort) STUDENT_COUNT="$2"; shift 2 ;; # legacy alias
    --suite-run) SUITE_RUN="yes"; shift ;;
    --suite-students) SUITE_STUDENT_COUNT="$2"; shift 2 ;;
    --orchestrated) ORCHESTRATED="yes"; shift ;;
    --teardown-after) SKIP_TEARDOWN="no"; shift ;;
    -h|--help) sed -n '3,18p' "$0" | sed 's|^# \{0,1\}||'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$RUN_ID" ] || die "--run-id is required (printed by ec2/provision.sh)"
for count in "$STUDENT_COUNT" "$SUITE_STUDENT_COUNT"; do
  [ -n "$count" ] || continue
  case "$count" in
    *[!0-9]*|'') die "--students must be a positive whole number" ;;
  esac
  [ "$count" -gt 0 ] || die "--students must be greater than zero"
  [ "$count" -le 2000 ] || die "--students cannot exceed the ec2-clone safety ceiling of 2000"
done
STATE_FILE="${STATE_DIR}/${RUN_ID}.json"
[ -f "$STATE_FILE" ] || die "no state file at ${STATE_FILE} — was this run provisioned from this machine?"
command -v jq >/dev/null || die "jq is not installed"

LOADGEN_IP="$(jq -r '.loadgenPublicIp' "$STATE_FILE")"
SUT_IP="$(jq -r '.sutPrivateIp' "$STATE_FILE")"
SUT_ID="$(jq -r '.sut' "$STATE_FILE")"
SUT_TYPE="$(jq -r '.sutType' "$STATE_FILE")"
SRC_TYPE="$(jq -r '.sourceInstanceType' "$STATE_FILE")"
SUT_VCPUS="$(jq -r '.sutVcpus // null' "$STATE_FILE")"
SUT_MEMORY_MIB="$(jq -r '.sutMemoryMiB // null' "$STATE_FILE")"
[ -n "$REGION" ] || REGION="$(jq -r '.region' "$STATE_FILE")"

SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o ServerAliveInterval=30)
[ -n "$SSH_KEY" ] && SSH_OPTS+=(-i "$SSH_KEY")

lg() { ssh "${SSH_OPTS[@]}" "ubuntu@${LOADGEN_IP}" "$@"; }
# The clone has no public IP by design, so every command to it is proxied through
# the load generator.
sut() { lg "ssh -o StrictHostKeyChecking=accept-new ubuntu@${SUT_IP} \"$*\""; }

# ─────────────────────────────────────────────────────────────────────────────
# 1. Wait for both instances, and REFUSE to proceed unless sanitize succeeded
# ─────────────────────────────────────────────────────────────────────────────
log "waiting for the load generator to finish cloud-init (package installation can take several minutes)..."
for attempt in $(seq 1 60); do
  if lg "test -f /opt/pressure/READY" 2>/dev/null; then break; fi
  if [ $((attempt % 3)) -eq 0 ]; then
    log "load generator is still initializing ($((attempt * 10))s elapsed)..."
  fi
  sleep 10
done
lg "test -f /opt/pressure/READY" || die "the load generator never became ready; check 'sudo cat /var/log/pressure/boot.log' on ${LOADGEN_IP}"

# ── Deliver the sanitize payload and start the app ───────────────────────────
# The clone booted with Docker MASKED and the application deliberately not
# running (see ec2/user-data-sut.yml). Its cloud-init carries none of the
# sanitize machinery, because EC2 caps user-data at 16 KB and embedding it came
# to ~47 KB. So it is shipped now, over SSH, through the load generator — the
# clone has no public IP.
log "waiting for the clone to finish cloud-init..."
for attempt in $(seq 1 90); do
  if sut "test -f /opt/pressure/BOOTED" 2>/dev/null; then break; fi
  if [ $((attempt % 3)) -eq 0 ]; then
    log "clone is still initializing ($((attempt * 10))s elapsed)..."
  fi
  sleep 10
done
sut "test -f /opt/pressure/BOOTED" || die "the clone never finished cloud-init; check 'sudo cat /var/log/pressure/boot.log' via ${LOADGEN_IP}"

if sut "test -f /opt/pressure/READY" 2>/dev/null; then
  log "clone is already sanitized and running (resuming an existing run)"
else
  log "delivering the sanitize payload to the clone..."
  # scp through the load generator: -J would need a jump-host-capable ssh on the
  # local machine AND the key forwarded; piping tar over two hops needs neither.
  tar -C "$PRESSURE_DIR" -czf - ec2/sanitize-sut.sh ec2/bootstrap-sut.sh ec2/docker-compose.sut.yml instrument/probe.cjs \
    | lg "cat > /tmp/payload.tgz"
  lg "scp -o StrictHostKeyChecking=accept-new /tmp/payload.tgz ubuntu@${SUT_IP}:/tmp/payload.tgz" >/dev/null
  sut "mkdir -p /tmp/payload && tar -C /tmp/payload -xzf /tmp/payload.tgz \
       && sudo install -m 0700 /tmp/payload/ec2/sanitize-sut.sh /opt/pressure/sanitize-sut.sh \
       && sudo install -m 0700 /tmp/payload/ec2/bootstrap-sut.sh /opt/pressure/bootstrap-sut.sh \
       && sudo install -m 0644 /tmp/payload/instrument/probe.cjs /opt/pressure/probe.cjs \
       && install -m 0644 /tmp/payload/ec2/docker-compose.sut.yml /home/ubuntu/app/docker-compose.sut.yml \
       && rm -rf /tmp/payload /tmp/payload.tgz"

  log "sanitizing the clone and starting the application..."
  # PRESSURE_ACK_REAL_DATA is one of sanitize-sut.sh's three identity checks; it
  # refuses to run without it. The acknowledgement was already made explicitly
  # at provision time (--ack-real-data), which is what this carries forward.
  set +e
  sut "PRESSURE_SOURCE_INSTANCE_ID='$(jq -r '.sourceInstance' "$STATE_FILE")' \
       PRESSURE_ACK_REAL_DATA='yes' \
       PRESSURE_DEADMAN_MINUTES='$(jq -r '.deadmanMinutes // 240' "$STATE_FILE")' \
       /opt/pressure/bootstrap-sut.sh"
  BOOTSTRAP_EXIT=$?
  set -e
  if [ $BOOTSTRAP_EXIT -ne 0 ]; then
    echo >&2
    echo "run-ec2: FATAL: bootstrap failed (exit ${BOOTSTRAP_EXIT}). Docker remains masked and the app is NOT running." >&2
    sut "sudo tail -40 /var/log/pressure/sanitize.log" 2>/dev/null >&2 || true
    echo >&2
    echo "run-ec2: do NOT work around this. Terminate the clone:" >&2
    echo "run-ec2:   pressure/ec2/teardown.sh --run-id ${RUN_ID} --region ${REGION}" >&2
    exit 1
  fi
fi

# Verify the gate independently of the bootstrap exit code. Two things could
# otherwise slip through: a resumed run against a clone someone sanitized by
# hand, and a bootstrap that somehow exited 0 without the marker. Cheap check,
# catastrophic failure mode.
if ! sut "test -f /opt/pressure/SANITIZED" 2>/dev/null; then
  echo >&2
  echo "run-ec2: FATAL: the clone was NOT sanitized. The application is intentionally not running." >&2
  echo "run-ec2: sanitize log:" >&2
  sut "sudo tail -40 /var/log/pressure/sanitize.log" 2>/dev/null >&2 || true
  echo >&2
  echo "run-ec2: do NOT work around this. Terminate the clone:" >&2
  echo "run-ec2:   pressure/ec2/teardown.sh --run-id ${RUN_ID} --region ${REGION}" >&2
  exit 1
fi
if [ "$SUITE_RUN" != "yes" ] || ! lg "test -f /opt/pressure/SUITE_STARTED" 2>/dev/null; then
  log "clone is sanitized. Controls applied:"
  sut "sudo cat /opt/pressure/sanitize-report.json" | sed 's/^/    /'
  [ "$SUITE_RUN" = "yes" ] && lg "touch /opt/pressure/SUITE_STARTED"
fi

sut "test -f /opt/pressure/READY" || die "the clone sanitized but the application never became healthy; check 'sudo tail -50 /var/log/pressure/boot.log'"

if [ "$SUT_TYPE" != "$SRC_TYPE" ]; then
  log "WARNING: the clone is ${SUT_TYPE} but production is ${SRC_TYPE}. Capacity numbers will NOT transfer."
fi

# ─────────────────────────────────────────────────────────────────────────────
# 2. Ship the harness and mint sessions with the CLONE's rotated secret
# ─────────────────────────────────────────────────────────────────────────────
if [ "$SUITE_RUN" = "yes" ] && lg "test -f /opt/pressure/HARNESS_READY" 2>/dev/null; then
  log "reusing the prepared harness and dependencies for this suite"
else
  log "copying the harness to the load generator..."
  lg "rm -rf /opt/pressure/harness && mkdir -p /opt/pressure/harness"
  tar -C "$REPO_DIR" -czf - pressure package.json package-lock.json prisma src/lib/db-url.ts \
    | lg "tar -C /opt/pressure/harness -xzf -"

  log "installing harness dependencies on the load generator..."
  # --omit=dev is wrong here: tsx and prisma are devDependencies and the minter
  # needs both. --ignore-scripts is also wrong: better-sqlite3 must compile its
  # native binding to open the database at all.
  lg "cd /opt/pressure/harness && npm ci --no-audit --no-fund >/dev/null 2>&1 && npx prisma generate >/dev/null 2>&1 && touch /opt/pressure/HARNESS_READY" \
    || die "dependency install failed on the load generator"
fi

# The clone's AUTH_SECRET was ROTATED during sanitize, so production's secret is
# useless here — which is the point. Read the new one off the clone.
log "reading the clone's rotated AUTH_SECRET..."
CLONE_SECRET="$(sut "sudo cat /opt/pressure/auth-secret")"
[ -n "$CLONE_SECRET" ] || die "could not read the rotated AUTH_SECRET from the clone"

MINT_STUDENTS=800
MINT_TEACHERS=40
REQUIRED_STUDENTS=0
MINT_TARGET="${SUITE_STUDENT_COUNT:-$STUDENT_COUNT}"
if [ -n "$MINT_TARGET" ]; then
  REQUIRED_STUDENTS="$MINT_TARGET"
  # exam-day runs a normal cohort and a separate simultaneous-submit cohort.
  # They must use different identities or the second wave measures attempt
  # resume/row contention instead of distinct students.
  if [ "$SCENARIO" = "exam-day" ] || [ "$SUITE_RUN" = "yes" ]; then
    REQUIRED_STUDENTS=$((MINT_TARGET * 2))
  fi
  [ "$REQUIRED_STUDENTS" -le "$MINT_STUDENTS" ] || MINT_STUDENTS="$REQUIRED_STUDENTS"
  REQUIRED_TEACHERS=$(((MINT_TARGET + 19) / 20 + 5))
  [ "$REQUIRED_TEACHERS" -le "$MINT_TEACHERS" ] || MINT_TEACHERS="$REQUIRED_TEACHERS"
fi

SESSION_CACHE_KEY="suite-${SUITE_STUDENT_COUNT:-default}"
if [ "$SUITE_RUN" = "yes" ] && [ "$(lg "cat /opt/pressure/SESSION_CACHE_KEY 2>/dev/null || true")" = "$SESSION_CACHE_KEY" ]; then
  log "reusing the suite's pre-minted session bundle"
else
  # The database lives on the clone, and the minter needs to read it. Copy it to
  # the generator rather than adding a competing Node process to the SUT.
  log "copying a consistent clone database backup to the load generator for session minting..."
  # The escaped quotes must survive both SSH hops so sqlite receives the dot
  # command as one argument rather than `.backup` and its path as two.
  sut "sudo rm -f /tmp/mint.db && sudo sqlite3 /home/ubuntu/app/data/db/prod/prod.db \\\".backup /tmp/mint.db\\\" && sudo chown ubuntu:ubuntu /tmp/mint.db"
  lg "scp -o StrictHostKeyChecking=accept-new ubuntu@${SUT_IP}:/tmp/mint.db /opt/pressure/mint.db" >/dev/null
  sut "rm -f /tmp/mint.db"
  [ "$SUITE_RUN" = "yes" ] && lg "cp /opt/pressure/mint.db /opt/pressure/suite-baseline.db"

  log "minting sessions from the real user set (${MINT_STUDENTS} students, ${MINT_TEACHERS} teachers)..."
  lg "cd /opt/pressure/harness && AUTH_SECRET='${CLONE_SECRET}' npx tsx pressure/tools/mint-sessions.ts \
        --out /opt/pressure/sessions.json --database-url 'file:/opt/pressure/mint.db' \
        --students ${MINT_STUDENTS} --teachers ${MINT_TEACHERS} --admins 2 --secure \
        --credentials-password 'pressure-invalid-${RUN_ID}'" \
    || die "minting sessions failed"
  [ "$SUITE_RUN" = "yes" ] && lg "printf '%s' '${SESSION_CACHE_KEY}' > /opt/pressure/SESSION_CACHE_KEY"
fi
if [ "$REQUIRED_STUDENTS" -gt 0 ]; then
  MINTED_STUDENTS="$(lg "jq -r '.students | length' /opt/pressure/sessions.json")"
  [ "$MINTED_STUDENTS" -ge "$REQUIRED_STUDENTS" ] || \
    die "requested ${MINT_TARGET} concurrent students, but only ${MINTED_STUDENTS} usable student identities exist (suite requires ${REQUIRED_STUDENTS})"
fi

# ─────────────────────────────────────────────────────────────────────────────
# 3. Start the AI stub, then run
# ─────────────────────────────────────────────────────────────────────────────
# sanitize-sut.sh repointed every AiProvider row at
# http://host.docker.internal:8099/v1, which resolves to the CLONE's host. So the
# stub runs on the clone, not the load generator. It is a trivial Node process
# (an SSE writer) and its cost is far smaller than the network round trip to a
# hosted provider that it replaces.
if sut "curl -fsS http://127.0.0.1:8099/healthz >/dev/null" 2>/dev/null; then
  log "AI stub is already running"
else
  log "starting the AI stub on the clone..."
  lg "tar -C /opt/pressure/harness -czf - pressure/mock-ai pressure/tools \
      | ssh -o StrictHostKeyChecking=accept-new ubuntu@${SUT_IP} 'mkdir -p /opt/pressure/ai && tar -C /opt/pressure/ai -xzf -'"
  sut "command -v node >/dev/null 2>&1" \
    || log "WARNING: node is not on the clone; the AI stub cannot start and exam-result generation will fail (recorded as designed worker failures)"
  sut "cd /opt/pressure/ai && (nohup npx --yes tsx pressure/mock-ai/server.ts --port 8099 --host 0.0.0.0 > /tmp/mock-ai.log 2>&1 &) ; sleep 3; curl -fsS http://127.0.0.1:8099/healthz || true"
fi

# Every suite scenario starts from the same post-sanitize database. Without
# this reset, earlier quiz submissions consume attempt limits and later
# scenarios measure a mutated cohort rather than an independent workload.
if [ "$SUITE_RUN" = "yes" ] && lg "test -f /opt/pressure/SCENARIO_COMPLETED" 2>/dev/null; then
  log "restoring the clean post-sanitize database for an independent scenario..."
  lg "scp -o StrictHostKeyChecking=accept-new /opt/pressure/suite-baseline.db ubuntu@${SUT_IP}:/tmp/suite-baseline.db" >/dev/null
  sut "cd /home/ubuntu/app \
       && sudo docker compose -f docker-compose.sut.yml down --timeout 30 \
       && sudo chown --reference=data/db/prod/prod.db /tmp/suite-baseline.db \
       && sudo chmod --reference=data/db/prod/prod.db /tmp/suite-baseline.db \
       && sudo mv /tmp/suite-baseline.db data/db/prod/prod.db \
       && sudo rm -f data/db/prod/prod.db-wal data/db/prod/prod.db-shm \
       && sudo docker compose -f docker-compose.sut.yml up -d --wait --wait-timeout 300" \
    || die "could not restore the suite database baseline"
fi

RUN_DIR_REMOTE="/opt/pressure/run"
lg "rm -rf ${RUN_DIR_REMOTE} && mkdir -p ${RUN_DIR_REMOTE}"

# Zero the probe histograms so the window is the run itself, not provisioning.
lg "curl -fsS -X POST http://${SUT_IP}:9099/reset >/dev/null 2>&1 || true"
lg "curl -fsS -X POST http://${SUT_IP}:9098/reset >/dev/null 2>&1 || true"

log "starting the metrics sampler and running '${SCENARIO}'..."
RUN_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
lg "cd /opt/pressure/harness && nohup pressure/collect/metrics.sh \
      --out ${RUN_DIR_REMOTE}/metrics.ndjson --interval 5 \
      --probe-host ${SUT_IP} --probe-ports '9099 9098' > /tmp/sampler.log 2>&1 & echo \$! > /tmp/sampler.pid"

set +e
lg "cd /opt/pressure/harness && \
    PRESSURE_TIER=ec2-clone \
    PRESSURE_BASE_URL='http://${SUT_IP}:3000' \
    PRESSURE_SESSION_FILE=/opt/pressure/sessions.json \
    PRESSURE_COOKIE_NAME='__Secure-authjs.session-token' \
    PRESSURE_RUN_LABEL='${RUN_ID}' \
    PRESSURE_SCALE='${SCALE}' \
    PRESSURE_STUDENTS='${STUDENT_COUNT}' \
    PRESSURE_EXPECT_CLOUDFRONT=1 \
    PRESSURE_FORWARDED_HOST='localhost:3000' \
    k6 run --summary-export ${RUN_DIR_REMOTE}/summary.json \
      pressure/k6/scenarios/${SCENARIO}.js 2>&1 | tee ${RUN_DIR_REMOTE}/k6.log"
K6_EXIT=$?
set -e
RUN_FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ "$SUITE_RUN" = "yes" ] && lg "touch /opt/pressure/SCENARIO_COMPLETED"

lg "kill \$(cat /tmp/sampler.pid) 2>/dev/null || true"
lg "cd /opt/pressure/harness && pressure/collect/metrics.sh --probe-once \
      --out ${RUN_DIR_REMOTE}/probes.json --probe-host ${SUT_IP} --probe-ports '9099 9098'" || true

# ─────────────────────────────────────────────────────────────────────────────
# 4. Collect, scrub, download
# ─────────────────────────────────────────────────────────────────────────────
log "collecting logs from the clone..."
sut "cd /home/ubuntu/app && sudo docker compose -f docker-compose.sut.yml logs --no-color > /tmp/containers.log 2>&1; sudo chown ubuntu:ubuntu /tmp/containers.log"
lg "scp -o StrictHostKeyChecking=accept-new ubuntu@${SUT_IP}:/tmp/containers.log ${RUN_DIR_REMOTE}/containers.log" >/dev/null || true
sut "sudo cat /opt/pressure/sanitize-report.json" > /tmp/sanitize-report.json 2>/dev/null || true
STUDENT_TARGET_JSON="null"
[ -n "$STUDENT_COUNT" ] && STUDENT_TARGET_JSON="$STUDENT_COUNT"
SUITE_RUN_JSON="false"
[ "$SUITE_RUN" = "yes" ] && SUITE_RUN_JSON="true"
lg "cat > ${RUN_DIR_REMOTE}/meta.json" <<JSON
{
  "runId": "${RUN_ID}-${SCENARIO}",
  "infrastructureRunId": "${RUN_ID}",
  "suiteRun": ${SUITE_RUN_JSON},
  "tier": "ec2-clone",
  "scenario": "${SCENARIO}",
  "label": "${RUN_ID}/${SCENARIO}",
  "sutInstance": "${SUT_ID}",
  "sutType": "${SUT_TYPE}",
  "sutVcpus": ${SUT_VCPUS},
  "sutMemoryMiB": ${SUT_MEMORY_MIB},
  "productionType": "${SRC_TYPE}",
  "dataset": "prod-snapshot (real data, sanitized)",
  "scale": "${SCALE}",
  "studentTarget": ${STUDENT_TARGET_JSON},
  "startedAt": "${RUN_STARTED_AT}",
  "finishedAt": "${RUN_FINISHED_AT}"
}
JSON

# SCRUB BEFORE DOWNLOAD. The clone's logs can contain real names and addresses,
# and the session bundle is a pile of live cookies. Scrubbing on the box means
# the unscrubbed copies never exist on the operator's laptop, where they would be
# the version most likely to get attached to a ticket.
log "scrubbing artifacts on the load generator before download..."
lg "cd /opt/pressure/harness && npx tsx pressure/collect/scrub.ts --in ${RUN_DIR_REMOTE} --out /opt/pressure/run-scrubbed" \
  || die "scrub failed — refusing to download unscrubbed artifacts from a clone holding production data"

LOCAL_RUN_DIR="${PRESSURE_DIR}/.tmp/ec2-runs/${RUN_ID}-${SCENARIO}"
mkdir -p "$LOCAL_RUN_DIR"
log "downloading scrubbed artifacts..."
scp "${SSH_OPTS[@]}" -r "ubuntu@${LOADGEN_IP}:/opt/pressure/run-scrubbed/*" "$LOCAL_RUN_DIR/" >/dev/null

( cd "$REPO_DIR" && npx tsx pressure/collect/summarize.ts \
    --summary "${LOCAL_RUN_DIR}/summary.json" --probes "${LOCAL_RUN_DIR}/probes.json" \
    --meta "${LOCAL_RUN_DIR}/meta.json" --out "${LOCAL_RUN_DIR}/report.md" ) || true

( cd "$REPO_DIR" && node pressure/publish-k6-result.mjs \
    --summary "${LOCAL_RUN_DIR}/summary.json" \
    --meta "${LOCAL_RUN_DIR}/meta.json" \
    --out "${LOCAL_RUN_DIR}/result.json" )

log "artifacts in ${LOCAL_RUN_DIR}"

if [ "$SKIP_TEARDOWN" = "no" ]; then
  log "tearing down (--teardown-after)..."
  "${PRESSURE_DIR}/ec2/teardown.sh" --run-id "$RUN_ID" --region "$REGION"
elif [ "$ORCHESTRATED" != "yes" ]; then
  echo
  log "The clone is STILL RUNNING and still holds production data. When you are done:"
  log "  pressure/ec2/teardown.sh --run-id ${RUN_ID} --region ${REGION}"
fi

exit "$K6_EXIT"
