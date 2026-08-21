// Capacity ramp: find the knee, not a pass/fail.
//
// Steps VUs upward and holds each level long enough for queueing to show. The
// knee is where event-loop delay starts climbing faster than throughput — for
// this architecture that is the real capacity number, because every Prisma
// query is a SYNCHRONOUS better-sqlite3 call (src/lib/prisma.ts), so added
// concurrency becomes event-loop queueing rather than database parallelism.
//
// The SLO thresholds are deliberately NOT abort conditions here: the point is to
// observe degradation past the limit, so the run is expected to breach them and
// the report records where. Read the report, not the exit code.

import { requireTier, identityFor, scaled, RUN_LABEL, SLO } from "../lib/config.js";
import { thresholds, TREND_STATS } from "../lib/metrics.js";
import { studentQuizJourney, teacherMonitorJourney, adminObservabilityJourney, publicLanding } from "../lib/journeys.js";

requireTier("ramp-capacity", ["ec2-clone"]);

const PEAK = scaled(Number(__ENV.BENCH_PEAK || 300));
const STEP_HOLD = __ENV.BENCH_STEP_HOLD || "3m";

function ladder(peak) {
  const stages = [];
  for (const fraction of [0.1, 0.25, 0.5, 0.75, 1.0]) {
    const target = Math.max(1, Math.round(peak * fraction));
    stages.push({ duration: "45s", target: target });
    stages.push({ duration: STEP_HOLD, target: target });
  }
  stages.push({ duration: "1m", target: 0 });
  return stages;
}

const STEPS = [
  "static_page",
  "student_dashboard",
  "class_quizzes",
  "student_quiz_start",
  "student_quiz_submit",
  "student_results",
  "teacher_dashboard",
  "teacher_quiz_stats",
  "notifications",
  "admin_resources",
  "admin_stats",
  "admin_logs",
];

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    students: { executor: "ramping-vus", exec: "student", startVUs: 0, stages: ladder(PEAK), gracefulRampDown: "60s" },
    // A fixed background mix so the request profile stays realistic at every
    // rung instead of becoming pure student traffic at the top.
    teachers: { executor: "constant-vus", exec: "teacher", vus: Math.max(1, Math.round(PEAK / 40)), duration: "20m" },
    admin: { executor: "constant-vus", exec: "admin", vus: 1, duration: "20m" },
    anonymous: { executor: "constant-arrival-rate", exec: "anon", rate: 2, timeUnit: "1s", duration: "20m", preAllocatedVUs: 5, maxVUs: 20 },
  },
  // Only correctness thresholds abort-worthy; latency SLOs are observational here.
  thresholds: Object.assign({}, thresholds(STEPS, SLO), {
    unexpected_errors: ["count<9223372036854775807"],
  }),
};

export function student() {
  studentQuizJourney(identityFor("students", __VU), { fetchMedia: true, mediaLimit: 4, thinkPerQuestion: [1, 5] });
}
export function teacher() {
  teacherMonitorJourney(identityFor("teachers", __VU));
}
export function admin() {
  // 2s is the admin dashboard's real polling floor.
  adminObservabilityJourney(identityFor("admins", 1), "24h");
}
export function anon() {
  publicLanding();
}

export function handleSummary(data) {
  return { stdout: `\nramp-capacity complete: peak=${PEAK} label=${RUN_LABEL}\n` };
}
