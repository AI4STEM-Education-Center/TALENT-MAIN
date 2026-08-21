// Login storm: measure the most expensive operation in the app, on purpose.
//
// bcryptjs at cost 12 (every hash site in src/app/api/auth/*) is the single
// heaviest thing this process does. Two properties make it worth its own
// scenario rather than a step inside every journey:
//
//  1. bcryptjs is a PURE JAVASCRIPT implementation. Unlike native bcrypt it does
//     not hand control back to the event loop while stretching, so a hash blocks
//     EVERY other in-flight request for its full duration. This is the clearest
//     case in the codebase of one user's request stalling everyone else's.
//  2. Logins are throttled to 10/min/IP in src/lib/auth.ts, and over the limit
//     `authorize` returns null — indistinguishable from a wrong password. So the
//     429s and the failures are BOTH designed, and a scenario that mixed logins
//     into normal traffic would measure the throttle while thinking it measured
//     the app.
//
// Because the throttle is per IP, a single load generator can only ever push 10
// real hashes per minute. What this scenario measures is therefore the LATENCY
// of a hash under concurrency and the throttle's correctness, not a hash
// throughput number. To measure real capacity the generator needs many source
// IPs — see the note in the report output.

import http from "k6/http";
import { requireTier, BASE_URL, SESSIONS, RUN_LABEL, SLO } from "../lib/config.js";
import { thresholds, record, TREND_STATS } from "../lib/metrics.js";

requireTier("login-storm", ["local", "ec2-clone"]);

const VUS = Number(__ENV.BENCH_LOGIN_VUS || 10);

export const options = {
  summaryTrendStats: TREND_STATS,
  scenarios: {
    logins: { executor: "constant-vus", exec: "login", vus: VUS, duration: __ENV.BENCH_LOGIN_DURATION || "2m" },
  },
  thresholds: thresholds(["login"], SLO),
};

/**
 * Auth.js credentials sign-in is a two-step dance: fetch a CSRF token, then POST
 * it back with the credentials. Skipping the CSRF fetch produces a uniform
 * failure that looks like a wrong password.
 */
export function login() {
  const csrfRes = http.get(`${BASE_URL}/api/auth/csrf`, { tags: { step: "csrf" } });
  if (!record("csrf", csrfRes, [200])) return;

  let csrfToken;
  try {
    csrfToken = csrfRes.json("csrfToken");
  } catch (e) {
    return;
  }

  const creds = SESSIONS.credentials || [];
  if (creds.length === 0) {
    console.error("[login-storm] session bundle has no `credentials` entries — mint with --with-credentials");
    return;
  }
  const who = creds[(__VU - 1) % creds.length];

  const res = http.post(
    `${BASE_URL}/api/auth/callback/credentials`,
    { identifier: who.identifier, password: who.password, csrfToken: csrfToken, redirect: "false" },
    {
      headers: { Origin: BASE_URL, Cookie: cookieHeader(csrfRes) },
      redirects: 0,
      tags: { step: "login" },
    }
  );
  // 200 and 302 are both success shapes depending on redirect handling; 401 is
  // the designed response for a throttled OR wrong-password attempt.
  record("login", res, [200, 302]);
}

function cookieHeader(res) {
  const jar = res.cookies || {};
  return Object.keys(jar).map((name) => `${name}=${jar[name][0].value}`).join("; ");
}

export function handleSummary(data) {
  const note =
    "\nNOTE: logins are throttled 10/min/IP (src/lib/auth.ts). From one generator IP this measures\n" +
    "hash LATENCY under concurrency and the throttle's correctness — not hash throughput.\n";
  return { stdout: `\nlogin-storm complete (${RUN_LABEL})${note}` };
}
