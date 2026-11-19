import { copyFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";

// Runs in every worker before the test files are imported. Establishes the
// environment variables the app modules read at import time (prisma.ts reads
// DATABASE_URL; crypto.ts reads API_KEY_ENCRYPTION_SECRET) so importing them
// never blows up and Tier 2 specs talk to an isolated per-worker SQLite DB.
//
// test/global-setup.ts runs `prisma db push` once into test/test-template.db.
// Each worker lazily clones that template to test/test-<workerId>.db once,
// allowing Vitest to run test files in parallel across workers with zero write
// contention or cross-file bleed (Honker's queue DB also derives from
// DATABASE_URL, so it splits per worker automatically).
const testDir = path.resolve(process.cwd(), "test");
const workerId = process.env.VITEST_POOL_ID || String(process.pid);
const templateDbFile = path.join(testDir, "test-template.db");
const workerDbFile = path.join(testDir, `test-${workerId}.db`);

if (!existsSync(workerDbFile) && existsSync(templateDbFile)) {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    rmSync(`${workerDbFile}${suffix}`, { force: true });
  }
  copyFileSync(templateDbFile, workerDbFile);
}

process.env.DATABASE_URL = `file:${workerDbFile}`;

// Production auth routes hash passwords with bcrypt cost 12 (~165ms locally,
// ~330ms on CI per call). Cap hashing to cost 4 (~2ms) inside Vitest while
// keeping real bcryptjs hash/compare format and verification intact.
vi.mock("bcryptjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bcryptjs")>();
  const fastHash = (
    password: string,
    saltOrRounds: string | number,
  ): Promise<string> =>
    actual.hash(
      password,
      typeof saltOrRounds === "number"
        ? Math.min(saltOrRounds, 4)
        : saltOrRounds,
    );
  const fastHashSync = (
    password: string,
    saltOrRounds?: string | number,
  ): string =>
    actual.hashSync(
      password,
      typeof saltOrRounds === "number"
        ? Math.min(saltOrRounds, 4)
        : (saltOrRounds ?? 4),
    );
  return {
    ...actual,
    hash: fastHash,
    hashSync: fastHashSync,
    default: {
      ...actual,
      hash: fastHash,
      hashSync: fastHashSync,
    },
  };
});

// A fixed, valid 32-byte (64 hex char) key so crypto round-trips are deterministic.
process.env.API_KEY_ENCRYPTION_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// storage.ts now requires static AWS credentials — getS3Client() throws without
// them rather than falling through to the SDK's instance-role provider chain —
// so any spec that reaches a signing helper needs these present. Dummy values
// are enough: every spec that touches the SDK stubs it. Exported so specs which
// mutate the S3 environment can restore this baseline instead of unsetting it
// and leaking a broken environment into later files. CLOUDFRONT_* is
// deliberately left unset so the default test path is the presigned-S3
// fallback.
export const TEST_AWS_ENV = {
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  AWS_REGION: "us-east-1",
  AWS_S3_BUCKET: "test-bucket",
} as const;

Object.assign(process.env, TEST_AWS_ENV);
