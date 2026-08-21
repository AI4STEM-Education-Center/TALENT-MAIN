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

/**
 * Host the application should believe it is serving.
 *
 * THIS IS NOT COSMETIC. src/proxy.ts validates the host on EVERY request against
 * a fixed allowlist (`ai4talent.org`, `*.ai4talent.org`, `localhost`,
 * `localhost:3000`, …) and returns a bare 403 for anything else. The local tier
 * publishes on 3100 to avoid colliding with `next dev`, so a request to
 * `http://127.0.0.1:3100` arrives with `Host: 127.0.0.1:3100` — not on the list —
 * and EVERY request is refused before it reaches a route.
 *
 * That failure is nastier than it sounds: 403 is a legitimately "designed"
 * status for this app (CSRF origin mismatch, the consent gate, the attempt cap),
 * so the taxonomy counted all of it as correct behaviour and the run reported a
 * clean PASS having exercised nothing. The first CI run of this harness did
 * exactly that.
 *
 * The fix mirrors production rather than working around it: Caddy forwards
 * `X-Forwarded-Host`, and src/proxy.ts prefers that header over `Host`. So the
 * harness sends the same thing the real proxy chain does. The CSRF check
 * compares the request's Origin against that same resolved host, so Origin is
 * derived from it and the two can never drift.
 */
export const FORWARDED_HOST = __ENV.BENCH_FORWARDED_HOST || "";

/** Origin the app will accept, consistent with FORWARDED_HOST. */
const EFFECTIVE_ORIGIN = FORWARDED_HOST
  ? `${BASE_URL.indexOf("https://") === 0 ? "https" : "http"}://${FORWARDED_HOST}`
  : BASE_URL;

/**
 * Headers every request needs, authenticated or not. Unauthenticated requests
 * need them too — the host check runs before any route, so `GET /` is refused
 * just as readily as an API call.
 */
export function baseHeaders() {
  const headers = { Origin: EFFECTIVE_ORIGIN };
  if (FORWARDED_HOST) headers["X-Forwarded-Host"] = FORWARDED_HOST;
  return headers;
}

export function authHeaders(identity) {
  const headers = baseHeaders();
  headers.Cookie = `${COOKIE_NAME}=${identity.token}`;
  // The proxy's CSRF check (src/proxy.ts) rejects a mutating /api/ request whose
  // Origin does not match the resolved host. Browsers always send Origin, so the
  // harness must too or every POST/PATCH is a 403 that looks like an app bug.
  headers["Content-Type"] = "application/json";
  return headers;
}

/**
 * The specific class+quiz that carries figures and image answer choices.
 *
 * Written to the seed manifest by seed/seed-bench.ts and passed through by the
 * runners. Scenarios that care about signing must target it EXPLICITLY rather
 * than discovering a quiz at random: only one quiz per class is media-heavy, so a
 * random pick exercises the signing path roughly a quarter of the time, and the
 * smoke run's media coverage becomes a coin flip. Two consecutive CI runs of this
 * harness reported 10 signed URLs and then none, for exactly that reason.
 *
 * `{}` when unset — callers fall back to random discovery.
 */
export const MEDIA_TARGET = (function () {
  const raw = __ENV.BENCH_MEDIA_TARGET;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`[config] BENCH_MEDIA_TARGET is not valid JSON: ${raw}`);
  }
})();

/** `true` when the target has CloudFront configured, so signing cost is in play. */
export const CLOUDFRONT_EXPECTED = __ENV.BENCH_EXPECT_CLOUDFRONT === "1";

/**
 * Whether to actually FETCH signed media, as opposed to only verifying that the
 * app signed it.
 *
 * Tier-dependent, because the two tiers are asking different questions:
 *
 *   local      The CloudFront distribution is necessarily a throwaway — you
 *              cannot stand up a real private distribution in CI, and the seeded
 *              objects do not exist in any bucket. So the domain does not
 *              resolve, and every fetch is a DNS failure that the taxonomy
 *              correctly reports as an unexpected error. Six per iteration, from
 *              a fixture, describing nothing about the app.
 *              What matters locally is the SIGNING cost and that a signed URL was
 *              produced at all — both fully exercised without any fetch.
 *
 *   ec2-clone  The distribution and the objects are real, so a 403 means the
 *   dev-site   trusted key group is misattached or the clock has skewed, and a
 *              404 means the object is missing. Both are genuine findings that
 *              only a real fetch can surface, so these tiers fetch.
 *
 * Override with BENCH_FETCH_MEDIA=1 / =0 when a local run does have a real CDN.
 */
export const FETCH_MEDIA =
  __ENV.BENCH_FETCH_MEDIA !== undefined && __ENV.BENCH_FETCH_MEDIA !== ""
    ? __ENV.BENCH_FETCH_MEDIA === "1"
    : TIER !== "local";
