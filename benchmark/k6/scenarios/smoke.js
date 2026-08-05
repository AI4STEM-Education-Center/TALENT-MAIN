/**
 * Smoke — one pass of every journey, single VU.
 *
 * Not a performance test. It answers "is the harness wired to a working
 * deployment?" before a long run burns time or EC2 minutes: sessions
 * authenticate, the live quizzes are actually attemptable, the worker publishes
 * a result, and the aggregation endpoints return.
 *
 * Runs on all three tiers. Always run it first.
 */

import { check } from "k6";
import {
  BASE_URL,
  TIER,
  studentIdentity,
  teacherIdentity,
  adminIdentity,
  ADMIN_SESSIONS,
  thresholds,
} from "../lib/config.js";
import { studentQuizSession, teacherMonitoring, adminPolling } from "../lib/journeys.js";

export const options = {
  scenarios: {
    smoke: { executor: "shared-iterations", vus: 1, iterations: 1, maxDuration: "5m" },
  },
  thresholds: {
    // The tier's gates are included mainly for their side effect: they are what
    // materialises the per-step submetrics so the summary table is complete even
    // for a single-iteration run. A smoke run has no real latency opinion.
    ...thresholds({ abortOnFail: false }),
    unexpected_errors: [{ threshold: "rate<0.01", abortOnFail: true }],
    checks: [{ threshold: "rate>0.99", abortOnFail: true }],
  },
};

export function setup() {
  console.log(`Smoke against ${BASE_URL} (tier: ${TIER.name} — ${TIER.purpose})`);
}

export default function () {
  const student = studentIdentity(0);
  const attemptId = studentQuizSession(student, {
    // Think time would make a smoke run take 25 × 20s for no benefit.
    answerThink: false,
    awaitResult: true,
    resultTimeoutS: 60,
  });
  check(attemptId, { "student completed a quiz attempt": (id) => Boolean(id) });

  teacherMonitoring(teacherIdentity(0));

  // The admin session is optional: a tier-2 run against the live dev site may
  // deliberately mint students only.
  if (ADMIN_SESSIONS.length > 0) adminPolling(adminIdentity());
}
