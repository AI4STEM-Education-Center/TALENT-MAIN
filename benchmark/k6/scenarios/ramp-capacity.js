/**
 * Tier 3 — find the breaking point.
 *
 * Steps concurrent students upward until an SLO breaks. The step at which it
 * breaks *is* the deliverable: "N concurrent students at p95 < X ms" is the
 * number that answers "can we run a 300-student cohort?", and it is the only
 * form of capacity statement worth recording. Peak RPS is not, because with
 * think time in the model a higher RPS just means shorter journeys.
 *
 * abortOnFail is on. Once the SLO is breached, everything after it is measuring
 * a system that has already failed, so the run stops and reports the last good
 * step. delayAbortEval (set in config.thresholds) gives each step time to
 * stabilise before its percentile is judged.
 *
 * Tunables:
 *   BENCH_STEP_VUS   students added per step (default 25)
 *   BENCH_STEPS      number of steps (default 8 → up to 200)
 *   BENCH_STEP_MIN   minutes per step (default 4)
 */

import { sleep } from "k6";
import { studentIdentity, teacherIdentity, thresholds, TIER } from "../lib/config.js";
import { studentQuizSession, teacherMonitoring } from "../lib/journeys.js";
import { sampleProbe } from "../lib/metrics.js";

/* global __ENV, __VU */

const STEP_VUS = Number(__ENV.BENCH_STEP_VUS || 25);
const STEPS = Number(__ENV.BENCH_STEPS || 8);
const STEP_MIN = Number(__ENV.BENCH_STEP_MIN || 4);
const PROBE_URL = __ENV.BENCH_PROBE_URL || "";

const peak = STEP_VUS * STEPS;
if (peak > TIER.maxVus) {
  throw new Error(
    `peak ${peak} VUs exceeds tier "${TIER.name}" cap of ${TIER.maxVus} — ` +
      `capacity testing belongs on the isolated EC2 clone (BENCH_TIER=ec2).`
  );
}

/**
 * Each step holds a flat concurrency for STEP_MIN minutes. A step needs to be
 * long enough for a WAL checkpoint to land inside it, or you measure the lull
 * between checkpoints and call it capacity.
 */
const stages = [];
for (let step = 1; step <= STEPS; step++) {
  stages.push({ duration: "30s", target: STEP_VUS * step }); // ramp into the step
  stages.push({ duration: `${STEP_MIN}m`, target: STEP_VUS * step }); // hold
}

const totalMin = STEPS * (STEP_MIN + 0.5);

export const options = {
  scenarios: {
    students: {
      executor: "ramping-vus",
      exec: "student",
      startVUs: STEP_VUS,
      stages,
      gracefulRampDown: "1m",
    },
    // A fixed teacher floor across every step, so the step-to-step comparison
    // isn't confounded by changing background load.
    teachers: {
      executor: "constant-vus",
      exec: "teacher",
      vus: 3,
      duration: `${totalMin}m`,
    },
    probe: {
      executor: "constant-arrival-rate",
      exec: "probe",
      rate: 30,
      timeUnit: "1m",
      duration: `${totalMin}m`,
      preAllocatedVUs: 1,
    },
  },
  thresholds: thresholds({ abortOnFail: true }),
};

export function setup() {
  console.log(
    `Capacity ramp: ${STEPS} steps of ${STEP_VUS} students (peak ${peak}), ` +
      `${STEP_MIN}m per step, aborting at the first SLO breach.`
  );
  console.log(
    `SLO gates — quiz_start p95<${TIER.slo.quizStartP95}ms, ` +
      `quiz_submit p95<${TIER.slo.quizSubmitP95}ms, ` +
      `stats p95<${TIER.slo.statsP95}ms`
  );
}

export function student() {
  studentQuizSession(studentIdentity(__VU), {
    browseFirst: true,
    answerThink: true,
    // Result polling is dropped here: at 200 VUs the poll traffic would itself
    // become a significant share of the load, muddying the capacity number.
    // Queue drain is measured by exam-day.js and soak.js instead.
    awaitResult: false,
  });
}

export function teacher() {
  teacherMonitoring(teacherIdentity(__VU), { includeExport: false });
}

export function probe() {
  const snapshot = sampleProbe(PROBE_URL);
  // Event-loop delay is the leading indicator on this stack: because
  // better-sqlite3 runs synchronously on the server's only thread, the loop
  // starts queueing before HTTP latency visibly degrades. Logging it per step
  // makes the saturation point visible in the run log, not just in the summary.
  if (snapshot && snapshot.eventLoopDelayMs) {
    console.log(
      `probe: loop p99=${snapshot.eventLoopDelayMs.p99.toFixed(1)}ms ` +
        `cpu=${snapshot.cpuPercentOfCore}% ` +
        `wal=${snapshot.sqlite && snapshot.sqlite.walBytes ? Math.round(snapshot.sqlite.walBytes / 1024) : "?"}KiB`
    );
  }
  sleep(1);
}
