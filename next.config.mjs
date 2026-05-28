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

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce a self-contained server for Docker deployment
  output: "standalone",
  env: {
    NEXT_PUBLIC_APP_VERSION: versionData.version,
    NEXT_PUBLIC_RELEASE_DATE: versionData.date,
    NEXT_PUBLIC_CHANGELOG: changelogText,
  },
  // Trust X-Forwarded-* headers from Cloudflare Tunnel proxy
  // Cloudflare terminates TLS; requests arrive over HTTP to cloudflared -> localhost
  // trustHost is handled by NextAuth's trustHost: true in auth config
};

export default nextConfig;
