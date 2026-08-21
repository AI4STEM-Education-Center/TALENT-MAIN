/**
 * Strip personal data out of collected artifacts before they leave the instance.
 *
 * WHY THIS IS REQUIRED ON TIER 3. The clone carries a copy of production's
 * database (see ec2/sanitize-sut.sh), so anything the run collects off it can
 * contain real names and email addresses. Three specific channels:
 *
 *   1. CONTAINER LOGS. Route error paths log identifiers, and Auth.js failures
 *      log the submitted identifier verbatim (src/lib/auth.ts logSystemEvent).
 *   2. k6 CONSOLE OUTPUT. The error taxonomy prints up to 300 characters of any
 *      unexpected response body, which for a 500 out of a user-scoped route can
 *      include a name or an email.
 *   3. THE SESSION BUNDLE. Not personal data as such, but every entry is a LIVE
 *      session cookie for a real account. That must never be attached to a PR,
 *      pasted into a chat, or uploaded as a CI artifact.
 *
 * Collected artifacts are the thing most likely to be shared casually — dropped
 * into a ticket or a Slack thread — so scrubbing happens on the box, before
 * anything is downloaded.
 *
 * Usage:
 *   tsx benchmark/collect/scrub.ts --in run/ --out run-scrubbed/
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs, str } from "../tools/args";

/** Files that are never safe to keep, whatever is inside them. */
const DENY_FILENAMES = [/^sessions.*\.json$/i, /^env\.original$/i, /^auth-secret$/i, /\.pem$/i, /^\.env/i];

const REPLACEMENTS: Array<{ name: string; pattern: RegExp; replace: string }> = [
  // Email addresses. Broad on purpose: a false positive costs a redacted string
  // in a log, a false negative puts a real student's address in a shared file.
  {
    name: "email",
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    replace: "<email:redacted>",
  },
  // Auth.js JWE session cookies (5 dot-separated base64url segments). These are
  // live credentials, not merely identifying.
  {
    name: "session-token",
    pattern: /\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: "<jwe:redacted>",
  },
  // CloudFront signed-URL parameters and AWS presign signatures: still-valid
  // read grants for private objects.
  { name: "cf-signature", pattern: /([?&])Signature=[^&\s"']+/g, replace: "$1Signature=<redacted>" },
  { name: "cf-keypair", pattern: /([?&])Key-Pair-Id=[^&\s"']+/g, replace: "$1Key-Pair-Id=<redacted>" },
  { name: "aws-signature", pattern: /([?&])X-Amz-Signature=[^&\s"']+/g, replace: "$1X-Amz-Signature=<redacted>" },
  { name: "aws-credential", pattern: /([?&])X-Amz-Credential=[^&\s"']+/g, replace: "$1X-Amz-Credential=<redacted>" },
  // AWS access key ids, in case one survives in a log line from before sanitize.
  { name: "aws-akid", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: "<aws-key:redacted>" },
  { name: "bearer", pattern: /Bearer\s+[A-Za-z0-9._\-]{20,}/g, replace: "Bearer <redacted>" },
];

/** Extensions worth rewriting. Anything else is copied only if explicitly text. */
const TEXT_EXTENSIONS = new Set([".json", ".log", ".txt", ".md", ".ndjson", ".csv", ".yml", ".yaml"]);

function main() {
  const args = parseArgs();
  const inDir = path.resolve(str(args, "in"));
  const outDir = path.resolve(str(args, "out"));

  if (!fs.existsSync(inDir)) throw new Error(`--in directory does not exist: ${inDir}`);
  fs.mkdirSync(outDir, { recursive: true });

  const counts: Record<string, number> = {};
  let filesCopied = 0;
  let filesDropped = 0;

  const walk = (relative: string) => {
    const absolute = path.join(inDir, relative);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      const childRelative = path.join(relative, entry.name);
      if (entry.isDirectory()) {
        walk(childRelative);
        continue;
      }
      if (DENY_FILENAMES.some((pattern) => pattern.test(entry.name))) {
        console.log(`  DROPPED ${childRelative} (never safe to export)`);
        filesDropped++;
        continue;
      }

      const target = path.join(outDir, childRelative);
      fs.mkdirSync(path.dirname(target), { recursive: true });

      if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        // Unknown format: cannot be scrubbed reliably, so it is dropped rather
        // than exported unexamined. Silently copying it would be the failure.
        console.log(`  DROPPED ${childRelative} (not a scrubbable text format)`);
        filesDropped++;
        continue;
      }

      let text = fs.readFileSync(path.join(inDir, childRelative), "utf8");
      for (const rule of REPLACEMENTS) {
        const matches = text.match(rule.pattern);
        if (matches) {
          counts[rule.name] = (counts[rule.name] ?? 0) + matches.length;
          text = text.replace(rule.pattern, rule.replace);
        }
      }
      fs.writeFileSync(target, text);
      filesCopied++;
    }
  };

  walk(".");

  const manifest = { scrubbedAt: new Date().toISOString(), filesCopied, filesDropped, redactions: counts };
  fs.writeFileSync(path.join(outDir, "scrub-manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`\nscrub: ${filesCopied} file(s) exported, ${filesDropped} dropped`);
  console.log(`scrub: redactions ${JSON.stringify(counts)}`);
  console.log(`scrub: -> ${outDir}`);
}

main();
