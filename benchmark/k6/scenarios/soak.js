/**
 * Tier 3 — soak. The run that catches what short tests structurally cannot.
 *
 * Four failure modes here are invisible in a ten-minute run:
 *
 *   1. WAL growth. SQLite's write-ahead log only truncates at a checkpoint, and
 *      a checkpoint needs a moment without active readers. Under sustained mixed
 *      load the WAL can grow monotonically — fine for an hour, then not.
 *   2. Worker queue drift. If exam-result generation drains slightly slower than
 *      submissions arrive, the backlog grows linearly and students stop seeing
 *      summaries. The rate difference is too small to see in ten minutes.
 *   3. Memory and handle leaks in a single long-lived Node process.
 *   4. EC2 burst-credit exhaustion — the trap specific to this deployment. A
 *      t-class instance on gp2/gp3 with burst IOPS looks excellent for twenty
 *      minutes and collapses at forty, once CPU credits or the volume's burst
 *      bucket runs dry. Anything shorter than an hour will not find this, and it
 *      is the single most likely cause of a "but it was fast in testing"
 *      production incident on this stack.
 *
 * Default 90 minutes at a comfortable load — the point is duration, not stress.
 * Pair the run with benchmark/collect/metrics.sh, which is what records the
 * host-level IOPS and credit-balance series this scenario exists to expose.
 */

import { sleep } from "k6";
import { studentIdentity, teacherIdentity, adminIdentity, thresholds, TIER } from "../lib/config.js";
import { studentQuizSession, teacherMonitoring, adminPolling } from "../lib/journeys.js";
import { sampleProbe } from "../lib/metrics.js";

/* global __ENV, __VU */

const DURATION_MIN = Number(__ENV.BENCH_SOAK_MIN || 90);
const VUS = Number(__ENV.BENCH_SOAK_VUS || 20);
const PROBE_URL = __ENV.BENCH_PROBE_URL || "";

if (VUS > TIER.maxVus) {
  throw new Error(`BENCH_SOAK_VUS=${VUS} exceeds tier "${TIER.name}" cap of ${TIER.maxVus}`);
}

const duration = `${DURATION_MIN}m`;

export const options = {
  scenarios: {
    students: {
      executor: "constant-vus",
      exec: "student",
      vus: VUS,
      duration,
    },
    teachers: {
      executor: "constant-vus",
      exec: "teacher",
      vus: 2,
      duration,
    },
    admin: {
      executor: "constant-arrival-rate",
      exec: "admin",
      rate: 30,
      timeUnit: "1m",
      duration,
      preAllocatedVUs: 2,
    },
    // Sampled every 2s for the whole soak: the WAL and RSS *series* is the
    // deliverable, and a sparse sample would smooth away a slow linear climb.
    probe: {
      executor: "constant-arrival-rate",
      exec: "probe",
      rate: 30,
      timeUnit: "1m",
      duration,
      preAllocatedVUs: 1,
    },
  },
  thresholds: {
    ...thresholds({ abortOnFail: false }),
    // A soak that finishes with a growing result backlog has failed even if
    // every latency gate passed.
    result_ready_timeouts: [{ threshold: "count<5", abortOnFail: false }],
  },
};

export function setup() {
  console.log(`Soak: ${VUS} students for ${DURATION_MIN} minutes on tier "${TIER.name}".`);
  console.log(
    "Watch for: monotonic WAL growth, climbing RSS/handles, rising result_ready_duration, " +
      "and (on burstable instances) a latency cliff 30-60 minutes in as CPU or EBS credits drain."
  );
}

export function student() {
  studentQuizSession(studentIdentity(__VU), {
    browseFirst: true,
    answerThink: true,
    // Result polling stays on: queue drain drift is one of the things a soak
    // exists to detect, and result_ready_duration is how it shows up.
    awaitResult: true,
    resultTimeoutS: 180,
  });
}

export function teacher() {
  teacherMonitoring(teacherIdentity(__VU));
}

export function admin() {
  adminPolling(adminIdentity());
}

export function probe() {
  sampleProbe(PROBE_URL);
  sleep(1);
}
