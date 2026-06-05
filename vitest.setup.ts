import path from "node:path";

// Runs in every worker before the test files are imported. Establishes the
// environment variables the app modules read at import time (prisma.ts reads
// DATABASE_URL; crypto.ts reads API_KEY_ENCRYPTION_SECRET) so importing them
// never blows up and Tier 2 specs talk to the throwaway test DB.
//
// The DB path MUST match test/global-setup.ts. Both derive it from cwd with an
// absolute path so the CLI (db push) and the runtime client agree.
process.env.DATABASE_URL = `file:${path.resolve(process.cwd(), "test", "test.db")}`;
// Intentionally NOT setting DB_PROVIDER=sqlite: prisma.ts runs WAL/busy_timeout
// PRAGMAs via $executeRawUnsafe when it is set, which SQLite rejects (they return
// rows). Tests run serially, so the concurrency PRAGMAs aren't needed here.

// A fixed, valid 32-byte (64 hex char) key so crypto round-trips are deterministic.
process.env.API_KEY_ENCRYPTION_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
