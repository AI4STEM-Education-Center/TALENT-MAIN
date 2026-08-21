// Custom metrics and the error taxonomy every scenario shares.
//
// WHY A TAXONOMY. This app answers a lot of load with deliberate, correct
// refusals: 409 when an attempt was already submitted, 403 for the per-class
// attempt cap or an unpublished quiz, 410 when the quiz was deleted mid-attempt,
// 429 from the login throttle and the per-route rate limiters. Summing those
// with 5xx produces one of two wrong answers:
//
//   - the run looks BROKEN when the app is behaving exactly as designed, or
//   - the run looks FINE while graded submissions are being lost to a write-lock
//     timeout, because the losses hid inside a large "errors" bucket.
//
// So designed statuses get their own counter and only `unexpected_errors` can
// fail a run.

import { Counter, Trend, Rate } from "k6/metrics";

export const designedRefusals = new Counter("designed_refusals");
export const unexpectedErrors = new Counter("unexpected_errors");
export const sqliteBusy = new Counter("sqlite_busy");
export const stepDuration = new Trend("step_duration", true);
export const stepFailRate = new Rate("step_failed");

/**
 * Trend statistics every scenario must request.
 *
 * k6's DEFAULT set is avg/min/med/max/p(90)/p(95) — it contains neither `count`
 * nor `p(99)`. The SLOs in config/tiers.json are written in p95 AND p99, and the
 * report shows a per-step count, so without this the report renders those cells
 * empty and a p99 SLO can never be evaluated. Requested explicitly rather than
 * left to the default, because the failure is silent: the table still draws.
 */
export const TREND_STATS = ["avg", "min", "med", "max", "p(90)", "p(95)", "p(99)", "count"];

/** Statuses this app returns on purpose, per route. */
const DESIGNED = {
  401: "unauthenticated",
  403: "forbidden/attempt-cap/csrf-origin/consent-gate",
  409: "already-submitted",
  410: "quiz-deleted",
  429: "rate-limited",
};

/**
 * Detect a lost write rather than a slow one.
 *
 * better-sqlite3 is opened with `timeout: 5000` (src/lib/prisma.ts), so a write
 * that cannot get the single write lock inside five seconds throws
 * SQLITE_BUSY. Prisma surfaces that as a 500, which is indistinguishable from
 * any other 500 by status alone — hence the body sniff. A non-zero count means
 * a student's graded submission was DROPPED, which is a correctness failure
 * masquerading as a performance one.
 */
function looksLikeSqliteBusy(res) {
  if (res.status !== 500) return false;
  const body = typeof res.body === "string" ? res.body : "";
  return /SQLITE_BUSY|database is locked|timed out/i.test(body);
}

/**
 * Record one journey step.
 *
 * `expected` lists the statuses that mean this step did its job. Anything in
 * DESIGNED but not in `expected` is a designed refusal (counted, never fatal).
 * Everything else is an unexpected error (fatal to the run).
 *
 * Returns true when the step succeeded, so callers can branch without
 * re-reading the status.
 */
export function record(step, res, expected) {
  const ok = expected.indexOf(res.status) !== -1;

  // Tag with the step name so the summary can break latency down per journey
  // step rather than reporting one meaningless aggregate over everything.
  stepDuration.add(res.timings.duration, { step: step });
  stepFailRate.add(!ok, { step: step });

  if (ok) return true;

  if (looksLikeSqliteBusy(res)) {
    sqliteBusy.add(1, { step: step });
    console.error(`[${step}] SQLITE_BUSY — a write lost the write lock after 5s. Body: ${trim(res.body)}`);
    return false;
  }

  if (DESIGNED[res.status]) {
    designedRefusals.add(1, { step: step, status: String(res.status) });
    return false;
  }

  unexpectedErrors.add(1, { step: step, status: String(res.status) });
  console.error(
    `[${step}] unexpected ${res.status} (${res.error || "no transport error"}): ${trim(res.body)}`
  );
  return false;
}

function trim(body) {
  if (typeof body !== "string") return "<non-string body>";
  return body.length > 300 ? `${body.slice(0, 300)}…` : body;
}

/**
 * Threshold set shared by every scenario.
 *
 * `steps` must list every step name the scenario records. k6 only MATERIALISES
 * a tagged submetric when a threshold references it — without an entry per step
 * the summary table is silently partial, showing a few steps and quietly
 * omitting the rest. That is a reporting bug that reads like "those steps
 * didn't run".
 *
 * Related trap, for whoever edits a scenario next: the keys returned from
 * `handleSummary` are paths relative to k6's WORKING DIRECTORY, not to the
 * script. Returning "summary.json" drops a file wherever k6 was invoked from
 * (it landed in the repo root once). The runners already capture the
 * machine-readable summary via `--summary-export <run-dir>/summary.json`, so
 * scenarios return stdout ONLY.
 */
export function thresholds(steps, slo) {
  const out = {
    // Only genuinely unexpected results fail a run.
    unexpected_errors: ["count==0"],
    // A lost write is never acceptable at any load level.
    sqlite_busy: ["count==0"],
  };
  for (const step of steps) {
    const limits = slo[step];
    if (!limits) continue;
    const checks = [];
    if (limits.p95) checks.push(`p(95)<${limits.p95}`);
    if (limits.p99) checks.push(`p(99)<${limits.p99}`);
    if (checks.length) out[`step_duration{step:${step}}`] = checks;
  }
  return out;
}
