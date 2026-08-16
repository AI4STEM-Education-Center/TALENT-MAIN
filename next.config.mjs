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
// inline styles, and cross-origin S3 image URLs, so a strict enforced policy
// would break rendering until each source is enumerated. Observe violations
// (wire up a report endpoint), then promote this to `Content-Security-Policy`.
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
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
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
  // optimizable. Turning the optimizer off makes that explicit and drops the
  // /_next/image endpoint, which is the only thing that would ever hand bytes
  // to sharp -> libvips (GHSA-f88m-g3jw-g9cj). next pins sharp ^0.34.5, so the
  // patched 0.35.x is outside its range; removing the consumer beats forcing an
  // unsupported override. Revisit if a real next/image usage is ever added.
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
