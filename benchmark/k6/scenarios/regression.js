// Regression: the commit-to-commit comparison, and the only scenario meant to
// be run often.
//
// Fixed VUs, fixed duration, fixed dataset, no ramping — every variable pinned
// so the ONLY difference between two runs is the code. Ramping would make the
// numbers depend on where in the ramp each sample landed, which is fine for
// finding a knee and useless for detecting a 20% slowdown.
//
// Absolute numbers from this tier mean nothing (it is a laptop or a CI runner).
// Deltas mean everything. collect/compare.ts is what reads two of these.

import { requireTier, identityFor, RUN_LABEL, SLO } from "../lib/config.js";
import { thresholds, TREND_STATS } from "../lib/metrics.js";
import { studentQuizJourney, teacherMonitorJourney, adminObservabilityJourney, publicLanding } from "../lib/journeys.js";

requireTier("regression", ["local"]);

const STEPS = [
  "static_page", "student_dashboard", "class_quizzes", "student_quiz_start", "quiz_media",
  "student_quiz_submit", "student_results", "teacher_dashboard", "teacher_quiz_stats",
  "notifications", "admin_resources", "admin_stats", "admin_logs",
];

export const options = {
  summaryTrendStats: TREND_STATS,
  // Pinned deliberately. Do not "tune" these — changing them invalidates every
  // stored baseline, which is why they are literals and not env-driven.
  scenarios: {
    students: { executor: "constant-vus", exec: "student", vus: 10, duration: "3m" },
    teachers: { executor: "constant-vus", exec: "teacher", vus: 2, duration: "3m" },
    admin: { executor: "constant-vus", exec: "admin", vus: 1, duration: "3m" },
    anonymous: { executor: "constant-arrival-rate", exec: "anon", rate: 1, timeUnit: "1s", duration: "3m", preAllocatedVUs: 2, maxVUs: 10 },
  },
  thresholds: thresholds(STEPS, SLO),
};

export function student() {
  // Think time is FIXED, not random, so run-to-run variance comes from the app.
  studentQuizJourney(identityFor("students", __VU), { fetchMedia: true, mediaLimit: 4, thinkPerQuestion: [0.5, 0.5] });
}
export function teacher() { teacherMonitorJourney(identityFor("teachers", __VU)); }
export function admin() { adminObservabilityJourney(identityFor("admins", 1), "24h"); }
export function anon() { publicLanding(); }

export function handleSummary(data) {
  return { stdout: `\nregression complete (${RUN_LABEL})\n` };
}
