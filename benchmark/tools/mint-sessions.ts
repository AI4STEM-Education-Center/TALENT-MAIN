/**
 * Pre-mint NextAuth session cookies for the benchmark's synthetic users.
 *
 * Two reasons k6 cannot just log in inline:
 *
 * 1. src/lib/auth.ts throttles logins to 10 per minute per IP. A load test that
 *    logs in per iteration measures the rate limiter, not the application.
 * 2. bcryptjs at cost 12 is the single most expensive thing the app does. Paying
 *    it on every iteration would drown out the endpoint under test.
 *
 * So sessions are minted once, here, and reused by the load scenarios — which
 * is also what a real cohort does: log in once in the morning, then browse for
 * an hour on the same cookie. The cost of logging in is measured separately and
 * deliberately by benchmark/k6/scenarios/login-storm.js.
 *
 * `--spread-ip` (default on for direct-to-origin targets) sends a distinct
 * synthetic X-Forwarded-For per request so minting 360 users doesn't take 36
 * minutes waiting out the limiter window. This works only because the benchmark
 * talks straight to the origin; through Cloudflare, cf-connecting-ip is
 * overwritten and the header is ignored — which is the correct behaviour and
 * exactly why the dev-site tier is capped at a handful of users.
 *
 * Output: benchmark/results/sessions.json — [{ email, role, cookieName, cookie }]
 */

import fs from "node:fs";
import path from "node:path";
import { parseFlags } from "./args";

type ManifestUser = { email: string; username: string };
type Manifest = {
  password: string;
  admin: ManifestUser;
  teachers: ManifestUser[];
  students: (ManifestUser & { studentId: string; classId: string | null; quizIds: string[] })[];
};

type Args = {
  baseUrl: string;
  manifestPath: string;
  outPath: string;
  students: number;
  teachers: number;
  concurrency: number;
  spreadIp: boolean;
  password: string | undefined;
};

function parseArgs(argv: string[]): Args {
  const flags = parseFlags(argv);
  const resultsDir = path.resolve(__dirname, "..", "results");
  const baseUrl = flags
    .str("url", process.env.BENCH_BASE_URL || "http://localhost:3100")!
    .replace(/\/+$/, "");

  return {
    baseUrl,
    manifestPath: path.resolve(flags.str("manifest", path.join(resultsDir, "dataset.json"))!),
    outPath: path.resolve(flags.str("out", path.join(resultsDir, "sessions.json"))!),
    students: flags.int("students", Number(process.env.BENCH_SESSION_STUDENTS || 0) || 0),
    teachers: flags.int("teachers", Number(process.env.BENCH_SESSION_TEACHERS || 0) || 0),
    concurrency: flags.int("concurrency", 8),
    // Through a CDN the header is stripped or overwritten, so default it off for
    // https targets and on for direct origin access.
    spreadIp: flags.has("spread-ip") ? flags.bool("spread-ip") : !baseUrl.startsWith("https://"),
    password: flags.str("password") ?? process.env.BENCH_PASSWORD,
  };
}

/** Distinct synthetic client IP per login, so each gets its own limiter bucket. */
function syntheticIp(ordinal: number): string {
  // 198.18.0.0/15 is the IETF benchmarking range (RFC 2544) — never routable,
  // so these can't be confused with real client addresses in the app's logs.
  const n = ordinal % 65536;
  return `198.18.${Math.floor(n / 256)}.${n % 256}`;
}

const COOKIE_PATTERN = /(^|\s)(__Secure-|__Host-)?authjs\.session-token(\.\d+)?=/;

/** Collapse a Set-Cookie list into the `name=value; name=value` request form. */
function collectCookies(setCookies: string[]): Map<string, string> {
  const jar = new Map<string, string>();
  for (const raw of setCookies) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    // An empty value is a deletion (auth.js clears the csrf cookie on failure).
    if (value === "") jar.delete(name);
    else jar.set(name, value);
  }
  return jar;
}

const serializeJar = (jar: Map<string, string>) =>
  [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

type Minted = { email: string; role: string; cookie: string; cookieName: string };

async function mintOne(
  args: Args,
  user: { email: string; role: string },
  ordinal: number
): Promise<Minted> {
  const headers: Record<string, string> = {
    "user-agent": "alw-benchmark/1.0 (session-minter)",
  };
  if (args.spreadIp) {
    const ip = syntheticIp(ordinal);
    headers["x-forwarded-for"] = ip;
    headers["x-real-ip"] = ip;
  }

  // 1. CSRF token — auth.js requires it on the credentials callback and pairs
  //    it with a cookie, so both halves have to be carried forward.
  const csrfResponse = await fetch(`${args.baseUrl}/api/auth/csrf`, { headers, redirect: "manual" });
  if (!csrfResponse.ok) {
    throw new Error(`csrf request failed: ${csrfResponse.status} ${csrfResponse.statusText}`);
  }
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken?: string };
  if (!csrfToken) throw new Error("csrf response contained no token");
  const jar = collectCookies(csrfResponse.headers.getSetCookie());

  // 2. Credentials callback. redirect:manual because a successful sign-in
  //    answers with a 302 whose Set-Cookie carries the session.
  const body = new URLSearchParams({
    identifier: user.email,
    password: args.password ?? "",
    csrfToken,
    callbackUrl: `${args.baseUrl}/`,
    json: "true",
  });
  const loginResponse = await fetch(`${args.baseUrl}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/x-www-form-urlencoded",
      cookie: serializeJar(jar),
    },
    body,
    redirect: "manual",
  });

  if (loginResponse.status === 429) {
    throw new Error("rate limited (429) — lower --concurrency or enable --spread-ip");
  }

  for (const [name, value] of collectCookies(loginResponse.headers.getSetCookie())) {
    jar.set(name, value);
  }

  const sessionEntry = [...jar.keys()].find((name) => COOKIE_PATTERN.test(`${name}=`));
  if (!sessionEntry) {
    // auth.js answers a rejected credential with a redirect to /login?error=…
    // rather than a 4xx, so the missing cookie is the real signal.
    const location = loginResponse.headers.get("location") ?? "";
    throw new Error(
      `no session cookie issued (status ${loginResponse.status}${location ? `, location ${location}` : ""}) — ` +
        `check the password matches the dataset manifest`
    );
  }

  // 3. Confirm the cookie actually authenticates. /api/auth/session returns {}
  //    for an anonymous caller, so a populated user proves the round trip.
  const sessionResponse = await fetch(`${args.baseUrl}/api/auth/session`, {
    headers: { ...headers, cookie: serializeJar(jar) },
  });
  const session = (await sessionResponse.json()) as { user?: { role?: string } };
  if (!session?.user) throw new Error("session cookie did not authenticate");

  return {
    email: user.email,
    role: session.user.role ?? user.role,
    cookieName: sessionEntry,
    cookie: serializeJar(jar),
  };
}

/** Bounded worker pool — 360 parallel bcrypt hashes would just self-inflict a queue. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<{ ok: R[]; failed: { index: number; error: string }[] }> {
  const ok: R[] = [];
  const failed: { index: number; error: string }[] = [];
  let cursor = 0;

  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        ok.push(await worker(items[index], index));
      } catch (error) {
        failed.push({ index, error: (error as Error).message });
      }
      if ((ok.length + failed.length) % 25 === 0) {
        process.stdout.write(`\r  minted ${ok.length}/${items.length} (${failed.length} failed)`);
      }
    }
  });

  await Promise.all(runners);
  return { ok, failed };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.manifestPath)) {
    throw new Error(
      `dataset manifest not found at ${args.manifestPath} — run \`npm run bench:seed\` first`
    );
  }
  const manifest = JSON.parse(fs.readFileSync(args.manifestPath, "utf8")) as Manifest;
  args.password ??= manifest.password;
  if (!args.password) {
    throw new Error("no password available: pass --password or re-seed to regenerate the manifest");
  }

  const students = manifest.students.slice(
    0,
    args.students > 0 ? args.students : manifest.students.length
  );
  const teachers = manifest.teachers.slice(
    0,
    args.teachers > 0 ? args.teachers : manifest.teachers.length
  );

  const targets = [
    ...students.map((s) => ({ email: s.email, role: "STUDENT" })),
    ...teachers.map((t) => ({ email: t.email, role: "TEACHER" })),
    { email: manifest.admin.email, role: "ADMIN" },
  ];

  console.log(`Minting ${targets.length} sessions against ${args.baseUrl}`);
  console.log(`  concurrency=${args.concurrency} spreadIp=${args.spreadIp}`);
  if (!args.spreadIp && targets.length > 10) {
    console.warn(
      `  WARNING: --spread-ip is off and ${targets.length} logins exceed the 10/min/IP limiter.\n` +
        `           Expect 429s. For an https/CDN target, mint far fewer users (tier 2 is low-volume by design).`
    );
  }

  const startedAt = Date.now();
  const { ok, failed } = await pooled(targets, args.concurrency, (user, index) =>
    mintOne(args, user, index)
  );
  process.stdout.write("\r");

  const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`Minted ${ok.length}/${targets.length} sessions in ${elapsedS}s`);
  if (failed.length > 0) {
    const sample = failed.slice(0, 3).map((f) => `${targets[f.index].email}: ${f.error}`);
    console.warn(`  ${failed.length} failed. First few:\n    ${sample.join("\n    ")}`);
  }
  if (ok.length === 0) throw new Error("no sessions minted — cannot run a load scenario");

  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  fs.writeFileSync(args.outPath, JSON.stringify(ok, null, 2));
  console.log(`Sessions: ${args.outPath}`);
}

main().catch((error) => {
  console.error(`\nmint-sessions failed: ${(error as Error).message}`);
  process.exit(1);
});
