/**
 * Tier 3 — spike and recovery.
 *
 * Two questions a steady-state test cannot answer:
 *
 *   1. What happens when a whole class hits "Start" in the same five seconds?
 *      Each start reads the full question set and presigns a URL per figure, all
 *      synchronously on one thread.
 *   2. Does the system *recover*? A single-process Node server with a 5-second
 *      SQLite busy timeout can enter a state where the queue never drains and
 *      latency stays broken long after load returns to normal. Degrading under a
 *      spike is acceptable; not coming back is not.
 *
 * The metric that matters is `recovery_seconds`: how long after the spike ends
 * before the post-spike window's p95 is back inside the SLO.
 */

import { sleep } from "k6";
import { Trend, Gauge } from "k6/metrics";
import { studentIdentity, thresholds, TIER } from "../lib/config.js";
import { studentQuizSession } from "../lib/journeys.js";
import { sampleProbe } from "../lib/metrics.js";

/* global __ENV, __VU */

const BASELINE = Number(__ENV.BENCH_BASELINE_VUS || 10);
const SPIKE = Number(__ENV.BENCH_SPIKE_VUS || 100);
const PROBE_URL = __ENV.BENCH_PROBE_URL || "";

if (SPIKE > TIER.maxVus) {
  throw new Error(`BENCH_SPIKE_VUS=${SPIKE} exceeds tier "${TIER.name}" cap of ${TIER.maxVus}`);
}

/** Latency tagged by phase, so pre/spike/post are directly comparable. */
export const phaseLatency = new Trend("phase_latency", true);
/** Seconds from spike end until p95 is back inside the SLO. */
export const recoverySeconds = new Gauge("recovery_seconds");

export const options = {
  scenarios: {
    baseline: {
      executor: "constant-vus",
      exec: "student",
      vus: BASELINE,
      duration: "12m",
    },
    // The spike itself: a burst of quiz starts, not a ramp. `start` delays it so
    // there is a clean two-minute baseline to compare against.
    spike: {
      executor: "ramping-vus",
      exec: "spikeStudent",
      startTime: "2m",
      startVUs: 0,
      stages: [
        { duration: "5s", target: SPIKE }, // everybody at once
        { duration: "55s", target: SPIKE },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
    // Watches the recovery window and records when latency comes back.
    watcher: {
      executor: "constant-vus",
      exec: "watch",
      vus: 1,
      duration: "12m",
    },
  },
  thresholds: {
    ...thresholds({ abortOnFail: false }),
    // The real assertion of this scenario: back to health within 3 minutes.
    recovery_seconds: [{ threshold: "value<180", abortOnFail: false }],
  },
};

/** Wall-clock phase, derived from k6's own scenario timings. */
function phaseAt(elapsedS) {
  if (elapsedS < 120) return "pre";
  if (elapsedS < 190) return "spike";
  return "post";
}

/** Set once by `watch` when the loop first comes back inside budget. */
let recoveredAtS = null;

export function setup() {
  console.log(`Spike: ${BASELINE} baseline → ${SPIKE} in 5s at t+2m, then recovery watch.`);
  return { startedAtMs: Date.now() };
}

export function student(data) {
  const elapsedS = (Date.now() - data.startedAtMs) / 1000;
  const phase = phaseAt(elapsedS);
  const at = Date.now();

  studentQuizSession(studentIdentity(__VU), {
    browseFirst: false,
    answerThink: true,
    awaitResult: false,
  });

  phaseLatency.add(Date.now() - at, { phase });
}

/**
 * Spike VUs skip think time and go straight for the start endpoint. That is the
 * honest shape of the event being modelled: thirty people pressing a button, not
 * thirty people reading questions.
 */
export function spikeStudent() {
  studentQuizSession(studentIdentity(__VU), {
    browseFirst: false,
    answerThink: false,
    awaitResult: false,
  });
}

/**
 * Probe the health endpoint once a second and record the first sustained return
 * to a healthy event loop after the spike.
 *
 * Recovery is judged on event-loop delay rather than HTTP latency because the
 * loop is the resource that was exhausted; it recovers first, and it recovers
 * unambiguously.
 */
export function watch(data) {
  const elapsedS = (Date.now() - data.startedAtMs) / 1000;
  const snapshot = sampleProbe(PROBE_URL);

  if (snapshot && snapshot.eventLoopDelayMs && elapsedS > 190) {
    const healthy = snapshot.eventLoopDelayMs.p99 < 200;
    if (healthy && recoveredAtS === null) {
      recoveredAtS = elapsedS;
      // Measured from the end of the spike (t+190s), not from the run start.
      recoverySeconds.add(elapsedS - 190);
      console.log(`recovered ${Math.round(elapsedS - 190)}s after the spike ended`);
    }
  }
  sleep(1);
}

export function teardown() {
  if (recoveredAtS === null) {
    // Never recovering inside the window is the finding, and it must not be
    // silently absent from the report.
    console.error(
      "WARNING: event-loop delay never returned below 200ms after the spike — " +
        "recovery_seconds was not recorded, treat this run as a failure to recover."
    );
    recoverySeconds.add(9999);
  }
}
