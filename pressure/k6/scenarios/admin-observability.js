// The admin dashboard as a load source — the pressure point the resource
// monitor introduced.
//
// THE HYPOTHESIS. Commit 6d47e1f added the System Resources tab. Its data comes
// from GET /api/admin/resources -> buildResourceReport() -> readSpool()
// (src/lib/resource-spool.ts), and readSpool is SYNCHRONOUS:
//
//     entries = fs.readdirSync(dir)
//     for each *.ndjson:  raw = fs.readFileSync(path, "utf8")
//                         for each line: decodeSample(line)
//
// No streaming, no await, no worker thread. Every line of every node's file is
// read and JSON-parsed on the main thread before the response is produced, and
// the filter is applied AFTER parsing, so a "1h" range still parses the whole
// seven-day file.
//
// Scale: four nodes (web, worker, web-dev, worker-dev) x one sample per minute
// x seven days retention = ~40,000 lines, compacted only hourly. On a
// single-process Node server where every Prisma query is already a synchronous
// better-sqlite3 call, that block delays EVERY concurrent request — including
// quiz submissions holding the write lock.
//
// WHAT THIS MEASURES. Two things the other scenarios cannot:
//   1. admin_resources latency as a function of spool size and range width.
//   2. The COLLATERAL cost: what one admin polling this endpoint does to the
//      latency of unrelated student traffic running alongside.
//
// The second is the finding that matters. If student_quiz_submit p95 moves when
// a single admin opens a tab, that is a one-request-blocks-everyone problem, not
// a slow-endpoint problem.

import {
  requireTier,
  identityFor,
  studentTarget,
  RUN_LABEL,
  SLO,
} from "../lib/config.js";
import { thresholds, TREND_STATS } from "../lib/metrics.js";
import {
  adminObservabilityJourney,
  studentQuizJourney,
  publicLanding,
} from "../lib/journeys.js";
import { sleep } from "k6";

requireTier("admin-observability", ["ec2-clone"]);

// The widest range parses the most lines. Default to the worst realistic case.
const RANGE = __ENV.PRESSURE_RESOURCE_RANGE || "7d";
// "0" runs the admin poll in isolation; >0 adds the collateral-damage measurement.
const STUDENTS = studentTarget(Number(__ENV.PRESSURE_COLLATERAL_STUDENTS || 8));

const STEPS = [
  "admin_resources",
  "admin_stats",
  "admin_logs",
  "student_dashboard",
  "class_quizzes",
  "student_quiz_start",
  "student_quiz_submit",
  "student_results",
  "static_page",
];

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    // One admin. Not a fleet — the point is that ONE is enough to matter.
    admin: {
      executor: "constant-vus",
      exec: "admin",
      vus: 1,
      duration: __ENV.PRESSURE_ADMIN_DURATION || "3m",
    },
    students: {
      executor: "constant-vus",
      exec: "student",
      vus: Math.max(1, STUDENTS),
      duration: __ENV.PRESSURE_ADMIN_DURATION || "3m",
      startTime: "0s",
    },
    // Cheap heartbeat: does no DB work, so its latency is close to a pure
    // event-loop-delay signal observed from outside the process.
    heartbeat: {
      executor: "constant-arrival-rate",
      exec: "beat",
      rate: 2,
      timeUnit: "1s",
      duration: __ENV.PRESSURE_ADMIN_DURATION || "3m",
      preAllocatedVUs: 3,
      maxVUs: 20,
    },
  },
  thresholds: thresholds(STEPS, SLO),
};

export function admin() {
  adminObservabilityJourney(identityFor("admins", 1), RANGE);
  // The dashboard's real polling floor.
  sleep(2);
}

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
    stdout:
      `\nadmin-observability complete: range=${RANGE} collateral_students=${STUDENTS} label=${RUN_LABEL}\n` +
      `Compare heartbeat static_page p99 here against a run with PRESSURE_COLLATERAL_STUDENTS=0\n` +
      `and no admin scenario: the difference is the synchronous spool parse.\n`,
  };
}
