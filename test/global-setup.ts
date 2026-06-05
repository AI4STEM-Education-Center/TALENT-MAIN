import { execSync } from "node:child_process";
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

  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: testDbUrl() },
  });
}
