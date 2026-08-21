// Smoke: one of everything, once. Proves the harness, the seed, the minted
// sessions and the target agree before any expensive run is started.
//
// This is the scenario to run first after changing anything, and the one CI
// runs on a pull request.

import { requireTier, SESSIONS, identityFor, RUN_LABEL, SLO } from "../lib/config.js";
import { thresholds, TREND_STATS } from "../lib/metrics.js";
import {
  studentQuizJourney,
  teacherMonitorJourney,
  adminObservabilityJourney,
  publicLanding,
} from "../lib/journeys.js";

requireTier("smoke", ["local", "ec2-clone"]);

const STEPS = [
  "static_page",
  "student_dashboard",
  "class_quizzes",
  "student_quiz_start",
  "quiz_media",
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
    smoke: { executor: "shared-iterations", vus: 1, iterations: 1, maxDuration: "3m" },
  },
  thresholds: thresholds(STEPS, SLO),
};

export default function () {
  publicLanding();
  studentQuizJourney(identityFor("students", 1), {
    fetchMedia: true,
    // No think time: this is a functional pass, not a shape.
    thinkPerQuestion: [0, 0],
  });
  teacherMonitorJourney(identityFor("teachers", 1));
  if (SESSIONS.admins && SESSIONS.admins.length > 0) {
    adminObservabilityJourney(identityFor("admins", 1), "24h");
  } else {
    console.warn("[smoke] no admin identity in the session bundle — admin steps skipped");
  }
}

export function handleSummary(data) {
  return { stdout: `\nsmoke complete (${RUN_LABEL})\n` };
}
