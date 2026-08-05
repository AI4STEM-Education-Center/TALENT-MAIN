/**
 * Tier 1 — regression detection on the local production Docker image.
 *
 * Purpose: is this commit slower than the last one? The output is meant to be
 * diffed by benchmark/collect/compare.ts against a committed baseline, not read
 * as a capacity figure — a dev machine's core count and NVMe fsync latency have
 * nothing to do with a t-class EC2 instance on EBS.
 *
 * That comparability is the whole design constraint here, so the shape is fixed
 * and modest: 5 → 25 concurrent students in three steps, a constant teacher and
 * admin floor, and a fixed duration. Resist the urge to tune it per run; a
 * moving scenario makes every historical baseline worthless.
 */

import { studentIdentity, teacherIdentity, adminIdentity, thresholds } from "../lib/config.js";
import { studentQuizSession, teacherMonitoring, adminPolling } from "../lib/journeys.js";
import { sampleProbe } from "../lib/metrics.js";
import { sleep } from "k6";

/* global __ENV, __VU */

const PROBE_URL = __ENV.BENCH_PROBE_URL || "";

export const options = {
  // Discarded by design: Next.js compiles routes lazily on first hit, SQLite's
  // page cache is cold, and mmap is unwarmed. Including that in a comparison
  // measures start-up, not the commit.
  discardResponseBodies: false,
  scenarios: {
    students: {
      executor: "ramping-vus",
      exec: "student",
      startVUs: 5,
      stages: [
        { duration: "1m", target: 5 }, // warm
        { duration: "2m", target: 15 },
        { duration: "3m", target: 25 },
        { duration: "1m", target: 25 },
      ],
      gracefulRampDown: "30s",
    },
    teachers: {
      executor: "constant-vus",
      exec: "teacher",
      vus: 2,
      duration: "7m",
    },
    admin: {
      executor: "constant-arrival-rate",
      exec: "admin",
      // The materials page polls every 2s; this reproduces one open tab.
      rate: 30,
      timeUnit: "1m",
      duration: "7m",
      preAllocatedVUs: 2,
    },
    probe: {
      executor: "constant-arrival-rate",
      exec: "probe",
      rate: 12,
      timeUnit: "1m",
      duration: "7m",
      preAllocatedVUs: 1,
    },
  },
  thresholds: thresholds({ abortOnFail: false }),
};

export function student() {
  studentQuizSession(studentIdentity(__VU), {
    // Think time stays on: it is what makes "25 concurrent students" mean the
    // same thing here as it does in tier 3.
    answerThink: true,
    awaitResult: true,
    resultTimeoutS: 120,
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
