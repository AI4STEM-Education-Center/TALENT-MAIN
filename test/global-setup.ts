import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Absolute path to the throwaway SQLite test database. Using an absolute path
 * avoids Prisma's relative `file:` resolution (which differs between the CLI,
 * which resolves against the schema dir, and the runtime client). Both this
 * file and vitest.setup.ts derive the same path from cwd, so they always agree.
 */
export function testDbUrl(): string {
  return `file:${path.resolve(process.cwd(), "test", "test.db")}`;
}

export default function setup() {
  const dbFile = path.resolve(process.cwd(), "test", "test.db");

  // Clean slate — drop any DB + WAL/SHM sidecars left by a previous run.
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const f = `${dbFile}${suffix}`;
    if (existsSync(f)) rmSync(f);
  }

  // Prisma 7 removed `--skip-generate` from `db push` (push no longer triggers
  // client generation). The datasource URL is read from prisma.config.ts, which
  // picks up the DATABASE_URL passed below.
  // Prisma's macOS schema-engine can exit with a generic startup error when
  // creating a fresh SQLite file unless Rust engine logging is initialized.
  // `trace` is consumed internally (the CLI remains quiet) and makes startup
  // reliable; retries remain as a guard against genuinely transient failures.
  const env = { ...process.env, DATABASE_URL: testDbUrl(), RUST_LOG: "trace" };
  // Invoke the installed CLI through node rather than `npx`: Node can't spawn
  // `npx` on Windows (it resolves to npx.cmd, which needs a shell), and going
  // direct skips npx's resolution step on CI too.
  const prismaCli = path.resolve(process.cwd(), "node_modules", "prisma", "build", "index.js");
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      execFileSync(process.execPath, [prismaCli, "db", "push", "--accept-data-loss"], {
        stdio: "inherit",
        env,
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        console.warn(`[test setup] Prisma db push failed (attempt ${attempt}/3); retrying.`);
      }
    }
  }
  throw lastError;
}
