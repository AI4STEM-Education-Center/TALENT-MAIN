/**
 * Per-step metrics and a deliberate error taxonomy.
 *
 * An aggregate "error rate" is close to useless against this app, because four
 * of its most common non-200s are *correct* behaviour:
 *
 *   429  the login limiter in src/lib/rate-limit.ts did its job
 *   409  the one-shot attempt claim rejected a duplicate submit
 *   403  the per-class attempt cap or availability window closed the quiz
 *   410  the quiz was deleted mid-attempt
 *
 * Lumping those in with 5xx means a run either looks broken when it is fine, or
 * looks fine when submissions are being lost to a SQLite lock timeout. So each
 * class is counted on its own, and only genuinely unexpected responses feed the
 * threshold that fails a run.
 */

import { Trend, Counter, Rate } from "k6/metrics";
import http from "k6/http";

/** Latency per named step, tagged so one Trend serves every step. */
export const stepDuration = new Trend("step_duration", true);
/** Requests that failed their expectation, tagged by step. */
export const stepFailures = new Counter("step_failures");
/** Feeds the run-failing threshold. Excludes designed 4xx. */
export const unexpectedErrors = new Rate("unexpected_errors");

export const designedResponses = new Counter("designed_responses");
export const serverErrors = new Counter("server_errors");
export const sqliteBusy = new Counter("sqlite_busy");
export const rateLimited = new Counter("rate_limited");

/** End-to-end: submit → the worker's AI result being readable. */
export const resultReadyDuration = new Trend("result_ready_duration", true);
export const resultReadyTimeouts = new Counter("result_ready_timeouts");
/** Full student journey, start → graded. */
export const journeyDuration = new Trend("journey_duration", true);

/** Observed event-loop delay inside the web container (see instrument/probe.cjs). */
export const eventLoopP99 = new Trend("event_loop_delay_p99", true);
export const walBytes = new Trend("sqlite_wal_bytes");

const DESIGNED_STATUSES = new Set([401, 403, 409, 410, 429]);

/**
 * Record one request against a named step.
 *
 * @param {string} step        stable step name (also the metric tag)
 * @param {object} response    k6 http response
 * @param {object} [options]
 * @param {number[]} [options.expect]  statuses treated as success (default [200])
 * @returns {boolean} whether the response met expectations
 */
export function record(step, response, options = {}) {
  const expect = options.expect || [200];
  const tags = { step };
  stepDuration.add(response.timings.duration, tags);

  const status = response.status;
  const ok = expect.includes(status);

  if (ok) {
    unexpectedErrors.add(false, tags);
    return true;
  }

  if (DESIGNED_STATUSES.has(status)) {
    designedResponses.add(1, { ...tags, status: String(status) });
    if (status === 429) rateLimited.add(1, tags);
    // Designed behaviour: recorded, but it must not fail the run.
    unexpectedErrors.add(false, tags);
    return false;
  }

  unexpectedErrors.add(true, tags);
  stepFailures.add(1, tags);

  if (status >= 500 || status === 0) {
    serverErrors.add(1, { ...tags, status: String(status) });
    // SQLITE_BUSY surfacing through Prisma is the signature failure of this
    // architecture under write pressure — worth its own counter so a run report
    // can distinguish "we saturated the CPU" from "we exhausted the write lock".
    const body = typeof response.body === "string" ? response.body : "";
    if (/SQLITE_BUSY|database is locked|busy_timeout/i.test(body)) {
      sqliteBusy.add(1, tags);
    }
  }
  return false;
}

/**
 * Sample the in-container probe. Called from a low-rate scenario rather than
 * per-iteration: this is a diagnostic sidecar, and scraping it in the hot path
 * would add load to the very thing being measured.
 */
export function sampleProbe(probeUrl) {
  if (!probeUrl) return null;
  const response = http.get(probeUrl, {
    tags: { step: "probe", probe: "true" },
    timeout: "5s",
  });
  if (response.status !== 200) return null;
  let snapshot;
  try {
    snapshot = response.json();
  } catch {
    return null;
  }
  if (snapshot && snapshot.eventLoopDelayMs) {
    eventLoopP99.add(snapshot.eventLoopDelayMs.p99);
  }
  if (snapshot && snapshot.sqlite && typeof snapshot.sqlite.walBytes === "number") {
    walBytes.add(snapshot.sqlite.walBytes);
  }
  return snapshot;
}
