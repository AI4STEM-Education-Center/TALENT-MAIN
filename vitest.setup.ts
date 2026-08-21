import path from "node:path";

// Runs in every worker before the test files are imported. Establishes the
// environment variables the app modules read at import time (prisma.ts reads
// DATABASE_URL; crypto.ts reads API_KEY_ENCRYPTION_SECRET) so importing them
// never blows up and Tier 2 specs talk to the throwaway test DB.
//
// The DB path MUST match test/global-setup.ts. Both derive it from cwd with an
// absolute path so the CLI (db push) and the runtime client agree.
process.env.DATABASE_URL = `file:${path.resolve(process.cwd(), "test", "test.db")}`;
// prisma.ts applies its SQLite PRAGMAs (journal_mode=WAL, synchronous=NORMAL,
// cache_size, temp_store, mmap_size) unconditionally on import via
// $queryRawUnsafe — there is no longer a DB_PROVIDER gate — so importing the
// client converts test.db to WAL. Tests run serially (vitest.config.ts:
// fileParallelism: false), so the concurrency PRAGMAs aren't stressed, but they
// are still in effect; test/prisma.pragmas.test.ts reads them back to confirm.

// A fixed, valid 32-byte (64 hex char) key so crypto round-trips are deterministic.
process.env.API_KEY_ENCRYPTION_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// storage.ts now requires static AWS credentials — getS3Client() throws without
// them rather than falling through to the SDK's instance-role provider chain —
// so any spec that reaches a signing helper needs these present. Dummy values
// are enough: every spec that touches the SDK stubs it. Exported so specs which
// mutate the S3 environment can restore this baseline instead of unsetting it
// and leaking a broken environment into later files (vitest runs them serially
// in one worker). CLOUDFRONT_* is deliberately left unset so the default test
// path is the presigned-S3 fallback.
export const TEST_AWS_ENV = {
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  AWS_REGION: "us-east-1",
  AWS_S3_BUCKET: "test-bucket",
} as const;

Object.assign(process.env, TEST_AWS_ENV);
