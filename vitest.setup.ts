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
