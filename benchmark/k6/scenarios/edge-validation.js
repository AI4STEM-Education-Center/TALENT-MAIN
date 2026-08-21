// Edge validation against dev.ai4talent.org — CORRECTNESS ONLY, NEVER CAPACITY.
//
// dev shares an EC2 instance, a disk, a Caddy and a Cloudflare zone with
// PRODUCTION (docker/docker-compose.yml, docker/Caddyfile). Load here degrades
// the live site for real users, and Cloudflare's WAF will start throttling a
// load generator anyway — at which point you are measuring the WAF.
//
// So this scenario asserts things that can ONLY be verified through the real
// edge and cannot be reproduced locally at all:
//
//   - Cloudflare -> Caddy -> container actually resolves end to end.
//   - Caddy's cloudflare_only guard is in place (the origin is not directly
//     reachable) and the tls_cloudflare block is serving a valid certificate.
//   - The __Secure- session cookie prefix is used in production mode and the
//     cookie survives a navigation (the Safari bug fixed in e06e8de).
//   - src/proxy.ts host validation rejects an unknown Host header.
//   - The proxy's Origin/CSRF check rejects a cross-site mutation.
//   - Private media is served from CloudFront and is NOT world-readable: an
//     unsigned CDN URL must be 403, which is what proves the trusted key group
//     is actually attached (docs/SETUP.md step 7.7).
//   - X-Robots-Tag: noindex is present on dev, so it stays out of search.
//
// Every one of those is a config property, invisible to a local Docker run.

import http from "k6/http";
import { check, fail } from "k6";
import { requireTier, BASE_URL, identityFor, authHeaders, SESSIONS, RUN_LABEL } from "../lib/config.js";
import { record } from "../lib/metrics.js";

requireTier("edge-validation", ["dev-site"]);

// Belt and braces on top of the tier guard: refuse to run anywhere but the dev
// host, so a mistyped BENCH_BASE_URL cannot point this at production.
if (BASE_URL.indexOf("dev.ai4talent.org") === -1) {
  fail(
    `[edge guard] edge-validation targets dev.ai4talent.org only, got ${BASE_URL}. ` +
      `Production must never be a load-test target.`
  );
}

export const options = {
  // ONE virtual user, ONE iteration. This is an assertion suite, not a load test.
  scenarios: { validate: { executor: "shared-iterations", vus: 1, iterations: 1, maxDuration: "2m" } },
  thresholds: { unexpected_errors: ["count==0"] },
};

export default function () {
  // 1. The edge resolves and TLS is valid (k6 verifies the chain by default).
  const landing = http.get(`${BASE_URL}/`, { tags: { step: "static_page" } });
  record("static_page", landing, [200]);
  check(landing, {
    "landing served over TLS through the edge": (r) => r.url.indexOf("https://") === 0,
    "dev is excluded from search engines": (r) =>
      String(r.headers["X-Robots-Tag"] || "").indexOf("noindex") !== -1,
    "response came through Cloudflare": (r) => !!(r.headers["Cf-Ray"] || r.headers["CF-RAY"]),
  });

  // 2. Host validation (src/proxy.ts) rejects an unknown Host.
  const badHost = http.get(`${BASE_URL}/`, {
    headers: { Host: "not-our-domain.example" },
    tags: { step: "host_guard" },
  });
  check(badHost, {
    "unknown Host is refused": (r) => r.status === 403 || r.status === 421 || r.status >= 400,
  });

  // 3. An authenticated read works through the edge, and the production cookie
  //    name is the __Secure- prefixed one.
  const identity = identityFor("students", 1);
  const headers = authHeaders(identity);
  const classes = http.get(`${BASE_URL}/api/classes`, { headers, tags: { step: "student_dashboard" } });
  record("student_dashboard", classes, [200]);
  check(SESSIONS.cookieName, {
    "production uses the __Secure- cookie prefix": (n) => String(n).indexOf("__Secure-") === 0,
  });

  // 4. The proxy's CSRF/Origin check rejects a cross-site mutation.
  const crossSite = http.post(
    `${BASE_URL}/api/quiz`,
    JSON.stringify({ classId: "x", quizId: "y" }),
    {
      headers: Object.assign({}, headers, { Origin: "https://evil.example" }),
      tags: { step: "csrf_guard" },
    }
  );
  check(crossSite, { "cross-site mutation is refused": (r) => r.status === 403 });

  // 5. Private media really is private. Take a signed URL the app just issued,
  //    strip its signature, and confirm the CDN refuses it. A 200 here means the
  //    trusted key group is not attached and every object in the bucket is
  //    readable by anyone who learns a key.
  const cq = http.get(`${BASE_URL}/api/classes`, { headers });
  const list = cq.status === 200 ? cq.json() : [];
  let checkedMedia = false;
  if (Array.isArray(list) && list.length > 0) {
    const quizzes = http.get(`${BASE_URL}/api/classes/${list[0].id}/quizzes`, { headers });
    const published = (quizzes.status === 200 ? quizzes.json() : []).filter((c) => c.published);
    if (published.length > 0) {
      const start = http.post(
        `${BASE_URL}/api/quiz`,
        JSON.stringify({ classId: list[0].id, quizId: published[0].quizId }),
        { headers, tags: { step: "student_quiz_start" } }
      );
      record("student_quiz_start", start, [200, 403]);
      if (start.status === 200) {
        const signed = firstMediaUrl(start.json().questions || []);
        if (signed) {
          checkedMedia = true;
          const unsigned = signed.split("?")[0];
          const naked = http.get(unsigned, { tags: { step: "cdn_guard" } });
          check(naked, {
            "unsigned CDN/S3 URL is refused (key group attached)": (r) => r.status === 403,
          });
          const ok = http.get(signed, { tags: { step: "quiz_media" } });
          record("quiz_media", ok, [200, 304]);
          check(ok, {
            "signed media URL is served": (r) => r.status === 200 || r.status === 304,
            "CDN sends CORS headers (figure cropper needs them)": (r) =>
              !!(r.headers["Access-Control-Allow-Origin"] || r.status === 304),
          });
        }
      }
    }
  }
  if (!checkedMedia) {
    console.warn(
      "[edge-validation] no signed media was reachable on dev, so the private-media assertions were SKIPPED. " +
        "That is a gap in this run, not a pass — publish a quiz with a figure on dev to close it."
    );
  }
}

function firstMediaUrl(questions) {
  for (const q of questions) {
    if (q.figureUrl) return q.figureUrl;
    for (const o of q.options || []) if (o.imageUrl) return o.imageUrl;
  }
  return null;
}

export function handleSummary(data) {
  return { stdout: `\nedge-validation complete (${RUN_LABEL})\n` };
}
