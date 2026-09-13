// Exam day: the shape that actually breaks this app.
//
// A cohort arrives over a couple of minutes, works through the quiz with real
// think time, and then submits in a CLUMP — because a class finishes together.
// Uniform-RPS load testing never produces that clump, and the clump is the
// whole problem: every submit takes SQLite's single write lock inside a
// transaction (src/app/api/quiz/route.ts PATCH), so N simultaneous submits are
// a QUEUE of length N, not N parallel writes. Past a certain N the tail waits
// longer than better-sqlite3's 5s `timeout` and a graded submission is LOST.
//
// Meanwhile a teacher watches the stats page, whose cost GROWS as the cohort
// submits, and the worker is generating AI exam results against the same
// database file. Omitting either would report a capacity the real deployment
// cannot reach.

import { requireTier, identityFor, scaled, SESSIONS, RUN_LABEL, SLO } from "../lib/config.js";
import { thresholds, TREND_STATS } from "../lib/metrics.js";
import { studentQuizJourney, teacherMonitorJourney } from "../lib/journeys.js";

// ec2-clone ONLY. On `local` this would report the Docker VM's CPU share as the
// cohort limit; the number would be wrong and someone would plan around it.
requireTier("exam-day", ["ec2-clone"]);

const COHORT = scaled(Number(__ENV.PRESSURE_COHORT || 120));
const TEACHERS = Math.max(1, Math.round(COHORT / 30));

const STEPS = [
  "student_dashboard",
  "class_quizzes",
  "student_quiz_start",
  "quiz_media",
  "student_quiz_submit",
  "student_results",
  "teacher_dashboard",
  "teacher_quiz_stats",
  "notifications",
];

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    // Arrival: the cohort trickles in over two minutes, as a class settling.
    cohort: {
      executor: "ramping-vus",
      exec: "student",
      startVUs: 0,
      stages: [
        { duration: "2m", target: COHORT },
        { duration: "8m", target: COHORT },
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "60s",
    },
    // The submit clump. A second wave with ZERO think time, released after the
    // first wave has had time to reach its own submits, so the write lock sees
    // genuinely simultaneous contention rather than a smear.
    clump: {
      executor: "per-vu-iterations",
      exec: "clumpStudent",
      vus: COHORT,
      iterations: 1,
      startTime: "5m",
      maxDuration: "5m",
    },
    teacher: {
      executor: "constant-vus",
      exec: "teacher",
      vus: TEACHERS,
      duration: "11m",
    },
  },
  thresholds: thresholds(STEPS, SLO),
};

export function student() {
  studentQuizJourney(identityFor("students", __VU), {
    fetchMedia: true,
    mediaLimit: 6,
    thinkPerQuestion: [2, 8],
  });
}

export function clumpStudent() {
  // Offset into the identity pool so the clump uses DIFFERENT students from the
  // arrival wave. Overlapping them would hit the attempt cap and the
  // pending-attempt resume path, turning a fresh-start measurement into a resume.
  const pool = SESSIONS.students.length;
  studentQuizJourney(identityFor("students", __VU + Math.floor(pool / 2)), {
    fetchMedia: false,
    thinkPerQuestion: [0, 0],
  });
}

export function teacher() {
  teacherMonitorJourney(identityFor("teachers", __VU));
}

export function handleSummary(data) {
  return {
    stdout: `\nexam-day complete: cohort=${COHORT} label=${RUN_LABEL}\n`,
  };
}
