// Spike and recovery: does it come BACK?
//
// Capacity tells you where it breaks. This tells you what happens after — which
// for this deployment is the more important question, because several things
// here do not self-heal:
//
//  - In-memory rate-limit buckets and the usage-tracker window are process
//    state (src/lib/rate-limit.ts, src/lib/usage-tracker.ts). A restart resets
//    them; a spike that triggers a container restart silently drops a traffic
//    sample.
//  - The Honker queue is a SEPARATE SQLite file, and every enqueue* call opens a
//    FRESH handle (src/lib/queue.ts). A spike of submits is also a spike of file
//    opens, and the backlog it leaves keeps the worker competing with the web
//    tier for the app database long after the load stops.
//  - `unless-stopped` restart policy means a crash looks like recovery. The post
//    spike phase is what distinguishes "absorbed it" from "was restarted".
//
// Compare the quiet phase BEFORE the spike with the quiet phase AFTER. Equal
// latency means it recovered. Worse means something is still draining.

import {
  requireTier,
  identityFor,
  scaled,
  studentTarget,
  hasStudentTarget,
  RUN_LABEL,
  SLO,
} from "../lib/config.js";
import { thresholds, TREND_STATS } from "../lib/metrics.js";
import { studentQuizJourney, publicLanding } from "../lib/journeys.js";

requireTier("spike-recovery", ["ec2-clone"]);

const SPIKE = studentTarget(Number(__ENV.PRESSURE_SPIKE || 400));
const BASELINE = hasStudentTarget()
  ? Math.max(1, Math.round(SPIKE / 20))
  : scaled(Number(__ENV.PRESSURE_BASELINE || 20));

const STEPS = [
  "static_page",
  "student_dashboard",
  "class_quizzes",
  "student_quiz_start",
  "student_quiz_submit",
  "student_results",
];

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    profile: {
      executor: "ramping-vus",
      exec: "student",
      startVUs: BASELINE,
      stages: [
        { duration: "3m", target: BASELINE }, // quiet BEFORE — the reference
        { duration: "10s", target: SPIKE }, // near-instant spike
        { duration: "2m", target: SPIKE }, // sustained overload
        { duration: "10s", target: BASELINE }, // load removed
        { duration: "5m", target: BASELINE }, // quiet AFTER — did it recover?
      ],
      gracefulRampDown: "30s",
    },
    // A steady, cheap heartbeat through the whole run. Its latency curve is the
    // clearest single view of the event loop being blocked, because it does no
    // database work of its own.
    heartbeat: {
      executor: "constant-arrival-rate",
      exec: "beat",
      rate: 1,
      timeUnit: "1s",
      duration: "20m30s",
      preAllocatedVUs: 3,
      maxVUs: 30,
    },
  },
  thresholds: Object.assign({}, thresholds(STEPS, SLO), {
    // Overload is the POINT of this scenario, so latency breaches during the
    // spike are expected. sqlite_busy is still zero-tolerance: dropping a
    // graded submission is not an acceptable overload behaviour.
    unexpected_errors: ["count<9223372036854775807"],
    sqlite_busy: ["count==0"],
  }),
};

export function student() {
  studentQuizJourney(identityFor("students", __VU), {
    fetchMedia: false,
    thinkPerQuestion: [1, 3],
  });
}
export function beat() {
  publicLanding();
}

export function handleSummary(data) {
  return {
    stdout: `\nspike-recovery complete: ${BASELINE} -> ${SPIKE} -> ${BASELINE} label=${RUN_LABEL}\n`,
  };
}
