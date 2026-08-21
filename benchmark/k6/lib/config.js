// Shared configuration and tier enforcement for every k6 scenario.
//
// k6 scripts run in a Go-hosted JS runtime with no filesystem access at
// runtime, so everything here comes from environment variables (`-e KEY=value`
// or the exported BENCH_* vars the runners set). `open()` IS available, but only
// during the init phase, which is why the pre-minted session file is read at
// module scope rather than inside a VU function.

import { fail } from "k6";

// tiers.json is the single source of truth for tier definitions and SLOs. k6
// v2 cannot `import` a .json file as a module (it parses it as JS and fails), so
// it is read with open() during the init phase and parsed here. open() is
// unavailable at any later point, which is why this is module scope.
const TIER_CONFIG = JSON.parse(open("../../config/tiers.json"));

/** SLO table keyed by journey step name. */
export const SLO = TIER_CONFIG.slo;

/** Tier definitions (target, maxVus, allowed scenarios). */
export const TIERS = TIER_CONFIG.tiers;

/** Tier this run is allowed to target. Set by the runner scripts, never by hand. */
export const TIER = __ENV.BENCH_TIER || "";

/** Base URL of the system under test. */
export const BASE_URL = (__ENV.BENCH_BASE_URL || "http://127.0.0.1:3100").replace(/\/+$/, "");

/** Scale knob: multiplies VU counts in every scenario that declares a shape. */
export const SCALE = Number(__ENV.BENCH_SCALE || 1);

/** Human label recorded in the report (commit sha, instance id, "before"/"after"). */
export const RUN_LABEL = __ENV.BENCH_RUN_LABEL || "unlabelled";

/**
 * Refuse to run a scenario outside the tier it is valid for.
 *
 * This is the single most important safety property of the harness. Two
 * concrete failures it prevents:
 *
 *  1. `exam-day` against `local` — reporting a cohort capacity measured on a
 *     laptop, where the Docker VM's CPU allocation, not the app, is the limit.
 *  2. `ramp-capacity` against `dev-site` — dev.ai4talent.org shares an EC2 box,
 *     a disk and a Caddy with PRODUCTION (docker/docker-compose.yml), so a
 *     capacity ramp there degrades the live site for real users, and what you
 *     actually measure is Cloudflare's WAF throttling you.
 */
export function requireTier(scenarioName, allowedTiers) {
  if (!TIER) {
    fail(
      `[tier guard] BENCH_TIER is not set. Run '${scenarioName}' through benchmark/run-local.sh, ` +
        `run-dev-site.sh or run-ec2.sh rather than invoking k6 directly.`
    );
  }
  if (allowedTiers.indexOf(TIER) === -1) {
    fail(
      `[tier guard] Scenario '${scenarioName}' is only valid on tier(s) ` +
        `[${allowedTiers.join(", ")}], but BENCH_TIER=${TIER}. ` +
        `Refusing to run: the number this would produce is not the number you think it is. ` +
        `See benchmark/config/tiers.json.`
    );
  }
}

/**
 * Hard ceiling on VUs per tier, applied to the computed shape rather than
 * trusted from BENCH_SCALE. `dev-site` is capped at 5 because it is the live
 * shared box; `local` at 25 because past that you are measuring Docker Desktop.
 */
const TIER_MAX_VUS = Object.keys(TIERS).reduce(function (acc, name) {
  acc[name] = TIERS[name].maxVus;
  return acc;
}, {});

export function cappedVus(requested) {
  const max = TIER_MAX_VUS[TIER];
  if (max === undefined) return requested;
  return Math.max(1, Math.min(requested, max));
}

export function scaled(baseVus) {
  return cappedVus(Math.max(1, Math.round(baseVus * SCALE)));
}

// ─── Pre-minted sessions ─────────────────────────────────────────────────────
//
// WHY NOT LOG IN. Logins are throttled to 10/min/IP in src/lib/auth.ts, and
// bcryptjs at cost 12 is the most expensive single operation in the app — and
// bcryptjs is pure JS, so it does not yield the event loop while hashing.
// Logging every VU in would mean (a) tripping the throttle and measuring the
// throttle, and (b) swamping every other measurement with hash cost. Login cost
// is measured deliberately and in isolation by scenarios/login-storm.js.
//
// Sessions are therefore minted directly as Auth.js JWT cookies by
// tools/mint-sessions.ts, using the target's own AUTH_SECRET.

const SESSION_FILE = __ENV.BENCH_SESSION_FILE || "";

// Validated at INIT, not on first use. Discovering a missing bundle inside a VU
// function means the run starts, every iteration throws, and a three-minute
// scenario emits thousands of identical stack traces before exiting — the real
// cause buried in the noise. Failing here costs nothing and says one thing once.
function loadSessions() {
  if (!SESSION_FILE) {
    fail(
      "[sessions] BENCH_SESSION_FILE is not set. Every scenario needs pre-minted sessions; " +
        "generate them with `tsx benchmark/tools/mint-sessions.ts` or let the runner scripts do it."
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(open(SESSION_FILE));
  } catch (e) {
    fail(`[sessions] could not read or parse ${SESSION_FILE}: ${e}`);
  }
  if (!parsed || !Array.isArray(parsed.students) || !Array.isArray(parsed.teachers)) {
    fail(`[sessions] ${SESSION_FILE} is not a session bundle (expected .students / .teachers arrays)`);
  }
  if (parsed.students.length === 0 && parsed.teachers.length === 0) {
    fail(`[sessions] ${SESSION_FILE} contains no identities — the seed or the mint step produced nothing`);
  }
  return parsed;
}

/** Parsed at init time — `open()` is unavailable inside VU code. */
export const SESSIONS = loadSessions();

export const COOKIE_NAME = __ENV.BENCH_COOKIE_NAME || "authjs.session-token";

/**
 * Deterministically assign VU number `n` a DISTINCT identity.
 *
 * Distinctness is load-bearing, not tidiness. Sharing one student across VUs
 * would (a) collapse every write onto one row so the measurement becomes
 * contention on a single row rather than realistic write spread, and (b) hit
 * the pending-attempt resume path in POST /api/quiz — which reuses the existing
 * unfinished attempt instead of creating one — so every VU after the first
 * would measure a resume, not a quiz start.
 */
export function identityFor(pool, n) {
  const list = SESSIONS[pool];
  if (!list || list.length === 0) fail(`[sessions] no '${pool}' identities in the session bundle`);
  if (list.length < __VU) {
    // Not fatal, but it silently changes what is being measured, so say so.
    console.warn(
      `[sessions] only ${list.length} '${pool}' identities for ${__VU}+ VUs — identities will be reused ` +
        `and write contention will be concentrated. Re-mint with a larger --count.`
    );
  }
  return list[(n - 1) % list.length];
}

export function authHeaders(identity) {
  return {
    Cookie: `${COOKIE_NAME}=${identity.token}`,
    // The proxy's CSRF check (src/proxy.ts) rejects a mutating /api/ request
    // whose Origin does not match the Host. Browsers always send it, so the
    // harness must too or every POST/PATCH is a 403 that looks like a bug.
    Origin: BASE_URL,
    "Content-Type": "application/json",
  };
}

/** `true` when the target has CloudFront configured, so signing cost is in play. */
export const CLOUDFRONT_EXPECTED = __ENV.BENCH_EXPECT_CLOUDFRONT === "1";
