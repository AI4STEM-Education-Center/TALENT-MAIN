/**
 * Tier 2 — the live dev deployment (https://dev.ai4talent.org).
 *
 * Purpose: validate the parts of the system that only exist at the edge —
 * Cloudflare, TLS, session cookies over a proxy, S3 presigned redirects — plus
 * quantify how much latency the edge path adds on top of tier 3's
 * origin-direct measurements.
 *
 * This is explicitly NOT a load test, and the guard rails below are deliberate:
 *
 *   - dev and prod share one EC2 host (docker-compose.dev.yml maps dev to 3001,
 *     prod to 3000). Sustained load here degrades production and imports
 *     production's noise into the measurement.
 *   - Cloudflare's WAF classifies synthetic bursts as an attack and starts
 *     answering 403, which silently invalidates a run.
 *   - the dev database holds real data; thousands of synthetic attempts is not
 *     a reasonable thing to leave behind.
 *
 * So: 3 VUs, arrival-rate capped, correctness checks over throughput.
 */

import { check, sleep } from "k6";
import http from "k6/http";
import { BASE_URL, TIER, studentIdentity, thresholds } from "../lib/config.js";
import { studentQuizSession, page } from "../lib/journeys.js";
import { record } from "../lib/metrics.js";

/* global __VU */

if (TIER.name !== "dev") {
  // A capacity-shaped tier running this file would report edge findings that
  // cannot exist (no CDN in front of a local container or an EC2 clone).
  throw new Error(
    `edge-validation is a tier-2 scenario; got BENCH_TIER=${TIER.name}. ` +
      `Run with BENCH_TIER=dev, or use regression.js / exam-day.js instead.`
  );
}

export const options = {
  scenarios: {
    edge: {
      executor: "constant-arrival-rate",
      exec: "edge",
      // 6 journeys/minute across at most 3 VUs — low enough to stay well under
      // any sane WAF rate threshold.
      rate: 6,
      timeUnit: "1m",
      duration: "5m",
      preAllocatedVUs: 3,
      maxVUs: 3,
    },
  },
  thresholds: {
    ...thresholds({ abortOnFail: false }),
    checks: [{ threshold: "rate>0.99", abortOnFail: true }],
  },
};

/**
 * One-time assertions about the deployment itself. These are the findings tier 2
 * exists to produce; the latency numbers are secondary.
 */
export function setup() {
  const response = http.get(`${BASE_URL}/login`, {
    tags: { step: "edge_login_page" },
    headers: { accept: "text/html" },
  });
  record("edge_login_page", response, { expect: [200] });

  const headers = response.headers;
  const findings = {
    protocol: response.proto,
    tlsVersion: response.tls_version || null,
    tlsCipher: response.tls_cipher_suite || null,
    ocspStatus: (response.ocsp && response.ocsp.status) || null,
    cfRay: headers["Cf-Ray"] || headers["cf-ray"] || null,
    cfCacheStatus: headers["Cf-Cache-Status"] || null,
    server: headers.Server || null,
    hsts: headers["Strict-Transport-Security"] || null,
    contentEncoding: headers["Content-Encoding"] || null,
  };
  console.log(`Edge findings: ${JSON.stringify(findings, null, 2)}`);

  check(findings, {
    "served over TLS 1.2 or better": (f) =>
      f.tlsVersion === "tls1.2" || f.tlsVersion === "tls1.3",
    "proxied through Cloudflare (cf-ray present)": (f) => Boolean(f.cfRay),
    "HTTP/2 or HTTP/3 negotiated": (f) => f.protocol !== "HTTP/1.1",
    "HSTS header present": (f) => Boolean(f.hsts),
    "response compressed": (f) => Boolean(f.contentEncoding),
  });

  return findings;
}

export function edge() {
  const identity = studentIdentity(__VU);

  // The session cookie has to survive the proxy: __Secure- prefixed, sent over
  // TLS, and accepted by the origin behind the tunnel. An SSR page that renders
  // 200 instead of redirecting to /login proves the whole chain.
  const dashboard = page(identity.cookie, "/student", "page_student_dashboard");
  check(dashboard, {
    "authenticated SSR page renders (no /login redirect)": (r) => r.status === 200,
    "response is HTML, not a JSON error": (r) =>
      String(r.headers["Content-Type"] || "").includes("text/html"),
  });

  // A full journey at low volume: this is what exercises presigned S3 URLs, the
  // grading transaction, and the worker over the real edge path.
  const attemptId = studentQuizSession(identity, {
    answerThink: false,
    awaitResult: true,
    resultTimeoutS: 120,
  });
  check(attemptId, { "quiz attempt completed end to end": (id) => Boolean(id) });

  sleep(2);
}

/**
 * Follow one presigned figure URL to S3.
 *
 * Called from the journey's start payload rather than fabricated, because the
 * point is the round trip: signature validity, bucket CORS, and the fact that
 * S3 is reached directly rather than proxied through the origin.
 */
export function checkPresignedUrl(url) {
  if (!url) return;
  const response = http.get(url, { tags: { step: "s3_presigned_get" }, redirects: 1 });
  record("s3_presigned_get", response, { expect: [200] });
  check(response, {
    "presigned S3 object fetched": (r) => r.status === 200,
    "S3 served it directly (not via the app origin)": (r) => !r.url.includes(BASE_URL),
  });
}
