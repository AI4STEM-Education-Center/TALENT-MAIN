import fs from "node:fs";
import path from "node:path";

const versionFilePath = path.join(process.cwd(), "version.json");
const changelogFilePath = path.join(process.cwd(), "CHANGELOG.md");

const versionData = fs.existsSync(versionFilePath)
  ? JSON.parse(fs.readFileSync(versionFilePath, "utf8"))
  : { version: "0.0.0", date: "1970-01-01" };

const changelogText = fs.existsSync(changelogFilePath)
  ? fs.readFileSync(changelogFilePath, "utf8")
  : "";

const isProd = process.env.NODE_ENV === "production";
const appEnv = process.env.APP_ENV?.toLowerCase() === "prod" ? "prod" : "dev";

// Content-Security-Policy is shipped in Report-Only mode first: the app relies
// on Next.js' inline bootstrap script, next-themes' inline theme script, KaTeX
// inline styles, and cross-origin CloudFront-signed image URLs, so a strict
// enforced policy would break rendering until each source is enumerated.
// Observe violations (wire up a report endpoint), then promote this to
// `Content-Security-Policy`. Note that enforcing it will need `connect-src`
// widened to BOTH the CloudFront domain and the S3 host, since uploads `fetch`
// a presigned PUT straight to the bucket.
const cspReportOnly = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
  // HSTS only in production: localhost dev is plain HTTP and must not be pinned
  // to HTTPS. In prod, Cloudflare terminates TLS and serves the app over HTTPS.
  ...(isProd
    ? [
        {
          key: "Strict-Transport-Security",
          value: "max-age=31536000; includeSubDomains",
        },
      ]
    : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce a self-contained server for Docker deployment
  output: "standalone",
  serverExternalPackages: ["@russellthehippo/honker-node"],
  // Nothing in this app imports next/image — every picture is a presigned S3
  // URL rendered through a plain <img> (see QuizReviewResult / QuizEditor),
  // because a presigned URL expires and would need remote-pattern config to be
  // optimizable. That, on its own, is why the optimizer is off.
  //
  // Turning it off also drops the /_next/image endpoint, the only route that
  // would hand bytes to sharp -> libvips. Note the advisory that originally
  // motivated this (GHSA-f88m-g3jw-g9cj) no longer applies: next@16.3.1 now
  // resolves sharp 0.35.3 / libvips 1.3.2, i.e. the patched line, so the old
  // "next pins sharp ^0.34.5 and the fix is outside its range" reasoning is
  // stale. Keeping the optimizer off is now a presigned-URL decision, not a
  // vulnerability workaround. Revisit if real next/image usage is ever added.
  images: { unoptimized: true },
  env: {
    // APP_ENV distinguishes the public dev and production sites. NODE_ENV is
    // "production" in both Docker deployments because both run optimized
    // builds, so client UI must use this deployment-specific switch instead.
    NEXT_PUBLIC_APP_ENV: appEnv,
    NEXT_PUBLIC_APP_VERSION: versionData.version,
    NEXT_PUBLIC_RELEASE_DATE: versionData.date,
    NEXT_PUBLIC_CHANGELOG: changelogText,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Trust X-Forwarded-* headers from Cloudflare Tunnel proxy
  // Cloudflare terminates TLS; requests arrive over HTTP to cloudflared -> localhost
  // trustHost is handled by NextAuth's trustHost: true in auth config
};

export default nextConfig;
