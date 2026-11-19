import { execFileSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

const TEST_DIR = path.resolve(process.cwd(), "test");
const TEMPLATE_DB_FILE = path.join(TEST_DIR, "test-template.db");

/**
 * Absolute path to the schema-synced template SQLite database. Using an
 * absolute path avoids Prisma's relative `file:` resolution (which differs
 * between the CLI, which resolves against the schema dir, and the runtime
 * client). Each Vitest worker clones this template into its own per-worker
 * file (`test/test-<poolId>.db`) so test files can run in parallel with zero
 * write contention or cross-file bleed.
 */
export function testTemplateDbPath(): string {
  return TEMPLATE_DB_FILE;
}

export function testDbUrl(): string {
  return `file:${TEMPLATE_DB_FILE}`;
}

function removeThrowawayDbs() {
  for (const entry of readdirSync(TEST_DIR)) {
    if (
      /^test(?:-template|-[\w-]+)?(?:\.queue)?\.db(?:-(?:journal|wal|shm))?$/.test(
        entry,
      )
    ) {
      rmSync(path.join(TEST_DIR, entry), { force: true });
    }
  }
}

export default function setup() {
  // Clean slate — drop any template, worker, queue, or WAL/SHM sidecar DBs
  // left behind by a previous run.
  removeThrowawayDbs();

  // Prisma 7 removed `--skip-generate` from `db push` (push no longer triggers
  // client generation). The datasource URL is read from prisma.config.ts, which
  // picks up the DATABASE_URL passed below.
  // Prisma's macOS schema-engine can exit with a generic startup error when
  // creating a fresh SQLite file unless Rust engine logging is initialized.
  // `trace` is consumed internally (the CLI remains quiet) and makes startup
  // reliable; retries remain as a guard against genuinely transient failures.
  //
  // Prisma 7.10+ refuses `db push --accept-data-loss` outright when it detects
  // an AI coding agent in the environment (CLAUDECODE, AI_AGENT, CURSOR_AGENT,
  // COPILOT_CLI, …) unless PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION is set.
  // That guard exists to stop an agent destroying a REAL database, and this
  // spawn provably cannot reach one: the target is the absolute
  // test/test-template.db path resolved above, the file was just deleted, and
  // DATABASE_URL is overridden explicitly so a developer's .env cannot
  // redirect it.
  //
  // Standing consent is scoped to THIS call deliberately. It weakens nothing
  // that currently applies to production: the gate only fires on
  // `--accept-data-loss`, `--force-reset` and `migrate reset`, and the paths
  // that touch a real database (`npm run db:push`, `npm run deploy`, and
  // docker-entrypoint.sh in production) all push WITHOUT those flags, so they
  // are never gated. An explicit value from the environment still wins, so a
  // user's own consent message is passed through untouched.
  const env = {
    ...process.env,
    DATABASE_URL: testDbUrl(),
    RUST_LOG: "trace",
    PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION:
      process.env.PRISMA_USER_CONSENT_FOR_DANGEROUS_AI_ACTION ||
      "Standing consent: target is the throwaway vitest database test/test-template.db, deleted and recreated by test/global-setup.ts on every run.",
  };
  // Invoke the installed CLI through node rather than `npx`: Node can't spawn
  // `npx` on Windows (it resolves to npx.cmd, which needs a shell), and going
  // direct skips npx's resolution step on CI too.
  const prismaCli = path.resolve(
    process.cwd(),
    "node_modules",
    "prisma",
    "build",
    "index.js",
  );
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync(
        process.execPath,
        [prismaCli, "db", "push", "--accept-data-loss"],
        {
          stdio: "inherit",
          env,
        },
      );
      return () => {
        removeThrowawayDbs();
      };
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.warn(
          `[test setup] Prisma db push failed (attempt ${attempt}/3); retrying.`,
        );
      }
    }
  }
  throw lastError;
}
