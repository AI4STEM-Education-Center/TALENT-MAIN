/**
 * Tier 3 — exam day. The headline scenario.
 *
 * This is the realistic worst case for this architecture, and the reason the
 * whole harness exists. A cohort does not arrive as a smooth request rate: a
 * class opens the quiz within a couple of minutes of the bell, works quietly for
 * twenty minutes, and then submits in a clump. That clump is what serializes,
 * because src/app/api/quiz/route.ts grades inside one transaction holding
 * SQLite's single write lock while the worker drains AI jobs against the same
 * database file, and better-sqlite3 executes every query synchronously on the
 * web server's only thread.
 *
 * A uniform-RPS test never produces that shape, which is why it can report a
 * comfortable p95 for a system that will drop submissions on exam morning.
 *
 * Tunables:
 *   BENCH_COHORT      students starting the quiz (default 60)
 *   BENCH_ARRIVAL_MIN minutes over which they arrive (default 2)
 */

import { sleep } from "k6";
import { studentIdentity, teacherIdentity, adminIdentity, thresholds, TIER } from "../lib/config.js";
import { studentQuizSession, teacherMonitoring, adminPolling } from "../lib/journeys.js";
import { sampleProbe } from "../lib/metrics.js";

/* global __ENV, __VU */

const COHORT = Number(__ENV.BENCH_COHORT || 60);
const ARRIVAL_MIN = Number(__ENV.BENCH_ARRIVAL_MIN || 2);
const PROBE_URL = __ENV.BENCH_PROBE_URL || "";

if (COHORT > TIER.maxVus) {
  throw new Error(
    `BENCH_COHORT=${COHORT} exceeds tier "${TIER.name}" cap of ${TIER.maxVus}. ` +
      `Exam-day load belongs on the isolated EC2 clone (BENCH_TIER=ec2).`
  );
}

export const options = {
  scenarios: {
    // per-vu-iterations, not arrival-rate: each synthetic student sits exactly
    // one exam, the way a real cohort does. An arrival-rate executor would keep
    // launching fresh attempts and measure a treadmill instead of an exam.
    cohort: {
      executor: "per-vu-iterations",
      exec: "student",
      vus: COHORT,
      iterations: 1,
      // Arrival is spread inside the journey (see the jittered sleep below), so
      // this only has to be long enough for the slowest student to finish.
      maxDuration: `${ARRIVAL_MIN + 45}m`,
    },
    // Teachers watch the class fill up while it happens — the stats endpoints
    // aggregate over exactly the rows being written.
    teachers: {
      executor: "constant-vus",
      exec: "teacher",
      vus: 3,
      duration: `${ARRIVAL_MIN + 20}m`,
    },
    admin: {
      executor: "constant-arrival-rate",
      exec: "admin",
      rate: 30,
      timeUnit: "1m",
      duration: `${ARRIVAL_MIN + 20}m`,
      preAllocatedVUs: 2,
    },
    probe: {
      executor: "constant-arrival-rate",
      exec: "probe",
      rate: 20,
      timeUnit: "1m",
      duration: `${ARRIVAL_MIN + 20}m`,
      preAllocatedVUs: 1,
    },
  },
  // Not abortOnFail: the interesting output of an exam-day run is the full
  // picture of how it degraded, not the instant of first breach.
  thresholds: thresholds({ abortOnFail: false }),
};

export function setup() {
  console.log(
    `Exam day: ${COHORT} students arriving over ${ARRIVAL_MIN}m on tier "${TIER.name}"`
  );
}

export function student() {
  // Poisson-ish arrival across the window rather than all at t=0. A true
  // simultaneous start is a spike test (see spike-recovery.js); exam day is a
  // dense but not instantaneous ramp, and the difference changes which
  // bottleneck you observe.
  const jitter = -Math.log(1 - Math.random()) / 2; // exponential, mean 0.5
  sleep(Math.min(1, jitter) * ARRIVAL_MIN * 60);

  studentQuizSession(studentIdentity(__VU), {
    browseFirst: true,
    answerThink: true,
    awaitResult: true,
    // Generous: under a full cohort's submission clump the worker queue is the
    // thing being measured, and a short timeout would record a harness
    // impatience as an application failure.
    resultTimeoutS: 300,
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
