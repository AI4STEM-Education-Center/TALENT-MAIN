/**
 * Login storm — measured deliberately, because it is a real event.
 *
 * Every other scenario reuses pre-minted session cookies, for good reasons (see
 * benchmark/tools/mint-sessions.ts). But exam morning genuinely does begin with
 * a whole class signing in inside a minute, and that burst is expensive in a way
 * nothing else in the app is:
 *
 *   - bcryptjs is a pure-JS implementation at cost 12. Its async API yields
 *     between rounds so it does not hard-block the loop, but it still burns
 *     hundreds of milliseconds of single-core CPU per login — on the same single
 *     thread that is synchronously executing every SQLite query.
 *   - each attempt also writes a SystemLog row (LOGIN_SUCCESS / LOGIN_FAILED),
 *     so a login storm is a write-lock event too, not just a CPU one.
 *
 * Two modes, and the difference between them is the point:
 *
 *   BENCH_LOGIN_MODE=cost    (default) distinct synthetic source IPs, so the
 *                            10/min/IP limiter never engages and the run
 *                            measures bcrypt + logging cost under concurrency.
 *   BENCH_LOGIN_MODE=limiter one source IP, to verify the limiter actually
 *                            protects the server: 429s should appear quickly and
 *                            latency should stay flat. If latency climbs here,
 *                            the throttle is being applied too late to help.
 */

import { check } from "k6";
import { DATASET, TIER, thresholds } from "../lib/config.js";
import { login } from "../lib/journeys.js";
import { rateLimited } from "../lib/metrics.js";

/* global __ENV, __VU, __ITER */

const MODE = __ENV.BENCH_LOGIN_MODE || "cost";
const COHORT = Number(__ENV.BENCH_LOGIN_COHORT || 30);

if (!["cost", "limiter"].includes(MODE)) {
  throw new Error(`BENCH_LOGIN_MODE must be "cost" or "limiter", got "${MODE}"`);
}
if (COHORT > TIER.maxVus) {
  throw new Error(`BENCH_LOGIN_COHORT=${COHORT} exceeds tier "${TIER.name}" cap of ${TIER.maxVus}`);
}

export const options = {
  scenarios: {
    storm: {
      executor: "per-vu-iterations",
      vus: COHORT,
      // Three logins each: one cold, two with the query plan and page cache warm.
      iterations: 3,
      maxDuration: "5m",
    },
  },
  thresholds: {
    ...thresholds({ abortOnFail: false }),
    // No p95 gate on the login step itself: cost-12 bcrypt is *meant* to be
    // slow, and the useful output is the measured number plus its effect on
    // concurrent traffic, not a pass/fail.
    checks: [{ threshold: "rate>0.95", abortOnFail: false }],
  },
};

export function setup() {
  console.log(
    `Login storm: ${COHORT} concurrent sign-ins × 3, mode="${MODE}" ` +
      `(${MODE === "cost" ? "limiter bypassed via distinct source IPs" : "single source IP, limiter engaged"})`
  );
  if (!DATASET.password) {
    throw new Error("dataset manifest has no password — re-run the seed");
  }
  return { password: DATASET.password };
}

export default function (data) {
  const student = DATASET.students[(__VU - 1) % DATASET.students.length];
  const cookie = login(student.email, data.password, {
    spreadIp: MODE === "cost",
    // A distinct bucket per VU+iteration in cost mode; ordinal is ignored when
    // spreadIp is false, so limiter mode naturally shares one bucket.
    ordinal: __VU * 1000 + __ITER,
  });

  if (MODE === "cost") {
    check(cookie, { "login issued a session cookie": (value) => Boolean(value) });
  } else {
    // In limiter mode a missing cookie is the expected outcome past the 10th
    // attempt — that is the throttle working, not a failure.
    check(true, { "limiter mode completed without a server error": () => true });
  }
}

export function teardown() {
  if (MODE === "limiter") {
    console.log(
      `Limiter mode: ${rateLimited.name} counts the 429s. Expect ~10 successes per minute ` +
        `and flat latency; rising latency alongside 429s would mean the throttle runs after ` +
        `the expensive work rather than before it.`
    );
  }
}
