// Soak: what only shows up over hours.
//
// Every finding this scenario is designed to catch is a slow leak that a ten
// minute run cannot see, and each one is specific to this codebase:
//
//  - The rate-limiter Map is only pruned opportunistically, once it exceeds
//    5000 entries (src/lib/rate-limit.ts). Steady traffic from many client IPs
//    grows it between prunes.
//  - SQLite WAL growth. journal_mode=WAL with synchronous=NORMAL means fsync
//    happens at CHECKPOINTS. A long write-heavy run is exactly how the -wal
//    file grows, and the box has a 20 GB root volume shared by prod and dev.
//  - The resource spool grows by one NDJSON line per node per minute and is
//    compacted only hourly, while readSpool() parses ALL of it synchronously on
//    every admin poll. Admin dashboard latency should therefore DRIFT UPWARD
//    over the soak. That drift is the finding.
//  - mmap_size=256MiB plus a 64MiB page cache per process, four containers, no
//    memory limits in either compose file. RSS is worth watching.
//
// The admin poll runs throughout precisely so that drift is measured, not
// discovered later in production.

import { requireTier, identityFor, scaled, RUN_LABEL, SLO } from "../lib/config.js";
import { thresholds, TREND_STATS } from "../lib/metrics.js";
import { studentQuizJourney, teacherMonitorJourney, adminObservabilityJourney } from "../lib/journeys.js";

requireTier("soak", ["ec2-clone"]);

const VUS = scaled(Number(__ENV.BENCH_SOAK_VUS || 40));
const DURATION = __ENV.BENCH_SOAK_DURATION || "2h";

const STEPS = [
  "student_dashboard", "class_quizzes", "student_quiz_start", "student_quiz_submit",
  "student_results", "teacher_dashboard", "teacher_quiz_stats", "notifications",
  "admin_resources", "admin_stats", "admin_logs",
];

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    students: { executor: "constant-vus", exec: "student", vus: VUS, duration: DURATION },
    teachers: { executor: "constant-vus", exec: "teacher", vus: Math.max(1, Math.round(VUS / 20)), duration: DURATION },
    // One admin holding the System Resources tab open for the entire soak. This
    // is the drift probe, not background noise.
    admin: { executor: "constant-vus", exec: "admin", vus: 1, duration: DURATION },
  },
  thresholds: thresholds(STEPS, SLO),
};

export function student() {
  studentQuizJourney(identityFor("students", __VU), { fetchMedia: true, mediaLimit: 3, thinkPerQuestion: [3, 12] });
}
export function teacher() {
  teacherMonitorJourney(identityFor("teachers", __VU));
}
export function admin() {
  // "7d" deliberately: the widest range reads the most spool lines, so the
  // synchronous parse cost is at its realistic worst rather than its best.
  adminObservabilityJourney(identityFor("admins", 1), "7d");
}

export function handleSummary(data) {
  return { stdout: `\nsoak complete: ${VUS} VUs for ${DURATION} label=${RUN_LABEL}\n` };
}
