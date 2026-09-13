// Smoke: one of everything, once. Proves the harness, the seed, the minted
// sessions and the target agree before any expensive run is started.
//
// This is the scenario to run first after changing anything, and the one CI
// runs on a pull request.

import { requireTier, SESSIONS, identityFor, RUN_LABEL, SLO, MEDIA_TARGET } from "../lib/config.js";
import { thresholds, requireSteps, TREND_STATS } from "../lib/metrics.js";
import {
  studentQuizJourney,
  teacherMonitorJourney,
  adminObservabilityJourney,
  publicLanding,
} from "../lib/journeys.js";

requireTier("smoke", ["ec2-clone"]);

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
  // Latency thresholds pass trivially on a step with ZERO samples, so a journey
  // that bailed out early reports every remaining step as a clean 0.0ms row and
  // the run PASSES. smoke exists to prove the plumbing, so it asserts that the
  // whole journey actually ran — this is the check that would have caught the
  // host-allowlist 403s on the first CI run instead of reporting them as health.
  thresholds: Object.assign(
    thresholds(STEPS, SLO),
    requireSteps([
      "static_page",
      "student_dashboard",
      "class_quizzes",
      "student_quiz_start",
      "student_quiz_submit",
      "teacher_dashboard",
      "admin_resources",
    ])
  ),
};

export default function () {
  publicLanding();
  studentQuizJourney(identityFor("students", 1), {
    fetchMedia: true,
    // Pinned to the media-heavy quiz. Random discovery hits it only about a
    // quarter of the time, so smoke's coverage of the RSA signing path — one of
    // the main things this harness exists to measure — would otherwise be a coin
    // flip, and the report's "no signed media" warning would fire at random.
    target: MEDIA_TARGET,
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
