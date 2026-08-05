/**
 * Shared k6 configuration: tier definitions, SLO thresholds, and the dataset /
 * session fixtures.
 *
 * Everything here runs in k6's init context, so `open()` is legal and the JSON
 * is parsed once per process rather than per iteration.
 */

/* global __ENV, open */

// ─── Tiers ────────────────────────────────────────────────────────────────────
// The three tiers answer different questions, and conflating them is how a
// benchmark ends up lying. Each declares what it is allowed to conclude.
//
// The definitions live in ../../config/tiers.json rather than here because the
// reporter (collect/summarize.ts) needs the same SLO numbers to render a
// verdict. Duplicating them would let a threshold change drift out of sync with
// the pass/fail printed in summary.md.

const TIER_CONFIG = JSON.parse(open("../../config/tiers.json"));
export const TIERS = TIER_CONFIG.tiers;
/** Every step name the journeys record, in report order. */
export const STEPS = TIER_CONFIG.steps;

const tierName = __ENV.BENCH_TIER || "local";
export const TIER = TIERS[tierName];
if (!TIER) {
  throw new Error(
    `unknown BENCH_TIER "${tierName}" — expected one of ${Object.keys(TIERS).join(", ")}`
  );
}

export const BASE_URL = (__ENV.BENCH_BASE_URL || TIER.defaultBaseUrl).replace(/\/+$/, "");

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RESULTS_DIR = __ENV.BENCH_RESULTS_DIR || "../../results";

function loadJson(relativePath, what) {
  try {
    return JSON.parse(open(relativePath));
  } catch (error) {
    throw new Error(
      `could not read ${what} at ${relativePath} (${error.message}). ` +
        `Run \`npm run bench:seed\` and \`npm run bench:sessions\` first, or point ` +
        `BENCH_RESULTS_DIR at an existing run.`
    );
  }
}

export const DATASET = loadJson(`${RESULTS_DIR}/dataset.json`, "dataset manifest");
export const SESSIONS = loadJson(`${RESULTS_DIR}/sessions.json`, "minted sessions");

const byRole = (role) => SESSIONS.filter((session) => session.role === role);
export const STUDENT_SESSIONS = byRole("STUDENT");
export const TEACHER_SESSIONS = byRole("TEACHER");
export const ADMIN_SESSIONS = byRole("ADMIN");

/** Manifest entry per student email, so a VU gets its own class + live quizzes. */
const STUDENT_TARGETS = new Map(DATASET.students.map((student) => [student.email, student]));

/**
 * Bind a VU to one distinct identity.
 *
 * Distinctness is not a nicety: sharing an account collapses every write onto
 * one row (hiding the write-lock contention this whole exercise is about) and
 * trips the pending-attempt resume path in src/app/api/quiz/route.ts, so the
 * second VU would silently reuse the first's attempt instead of creating one.
 */
export function studentIdentity(index) {
  if (STUDENT_SESSIONS.length === 0) throw new Error("no STUDENT sessions were minted");
  const session = STUDENT_SESSIONS[index % STUDENT_SESSIONS.length];
  const target = STUDENT_TARGETS.get(session.email);
  if (!target || !target.classId || target.quizIds.length === 0) {
    throw new Error(`dataset manifest has no live class/quiz for ${session.email}`);
  }
  return {
    email: session.email,
    cookie: session.cookie,
    classId: target.classId,
    quizIds: target.quizIds,
  };
}

export function teacherIdentity(index) {
  if (TEACHER_SESSIONS.length === 0) throw new Error("no TEACHER sessions were minted");
  const session = TEACHER_SESSIONS[index % TEACHER_SESSIONS.length];
  return { email: session.email, cookie: session.cookie, classes: DATASET.classes };
}

export function adminIdentity() {
  if (ADMIN_SESSIONS.length === 0) throw new Error("no ADMIN session was minted");
  return { email: ADMIN_SESSIONS[0].email, cookie: ADMIN_SESSIONS[0].cookie };
}

// ─── Think time ───────────────────────────────────────────────────────────────
// Real users pause. Open-loop endpoint blasting produces a number no cohort
// will ever reproduce; think time is what makes "50 concurrent students" mean
// the same thing here as it does on exam day.

export const THINK = {
  /** Reading a question and choosing an answer. */
  perQuestionS: [Number(__ENV.BENCH_THINK_MIN || 8), Number(__ENV.BENCH_THINK_MAX || 40)],
  /** Between dashboard page views. */
  navigationS: [1, 4],
  /** Teacher reading a stats table. */
  reviewS: [5, 20],
};

export function thinkSeconds([lo, hi]) {
  return lo + Math.random() * (hi - lo);
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

/**
 * k6 thresholds derived from the active tier's SLOs.
 *
 * `abortOnFail` is opt-in: the capacity scenario wants to stop at the first
 * breach (that breach *is* the answer), while a soak wants to keep running and
 * report the whole degradation curve.
 *
 * The second job of this function is less obvious but load-bearing: k6 only
 * materialises a tagged submetric when a threshold references it. Without an
 * entry per step, `step_duration{step:notifications}` and friends would be
 * missing from the summary export entirely, and summary.md would silently show a
 * partial table. So every step in tiers.json gets an entry — a real SLO gate
 * where one is defined, and an always-true `p(95)>=0` placeholder otherwise,
 * purely to bring the submetric into existence.
 */
export function thresholds({ abortOnFail = false } = {}) {
  const slo = TIER.slo;
  const gate = (value) => [
    { threshold: `p(95)<${value}`, abortOnFail, delayAbortEval: "30s" },
  ];

  /** Steps with a real budget. Everything else is observed but not gated. */
  const gated = {
    quiz_start: slo.quizStartP95,
    quiz_submit: slo.quizSubmitP95,
    page_student_dashboard: slo.pageTtfbP95,
    page_class_view: slo.pageTtfbP95,
    page_teacher_dashboard: slo.pageTtfbP95,
    page_teacher_class: slo.pageTtfbP95,
    quiz_stats: slo.statsP95,
    grades_export: slo.statsP95,
  };

  const out = {
    // Unintended failures only. 403/409/410/429 are counted separately because
    // they are the application's designed behaviour, not defects.
    unexpected_errors: [{ threshold: `rate<${slo.errorRate}`, abortOnFail }],
    // Non-negotiable on every tier: a graded submission must never be lost to a
    // lock timeout, and an attempt must never be double-graded.
    "step_failures{step:quiz_submit}": [{ threshold: "count<1", abortOnFail: false }],
  };

  for (const step of STEPS) {
    out[`step_duration{step:${step}}`] =
      gated[step] !== undefined
        ? gate(gated[step])
        : // Always true — present only so the submetric is exported.
          [{ threshold: "p(95)>=0", abortOnFail: false }];
  }

  return out;
}
