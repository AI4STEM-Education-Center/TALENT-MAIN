import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { resolveDatabaseUrl } from "./db-url";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Prisma 7 connects through a driver adapter instead of a bundled query engine.
// better-sqlite3 opens the file named by DATABASE_URL; the adapter is lazy — the
// database isn't opened until the first query. resolveDatabaseUrl re-anchors
// relative `file:` paths to prisma/ (preserving pre-v7 resolution) and the old
// `connection_limit`/`pool_timeout` params are dropped — they were engine
// connection-pool knobs that don't apply to better-sqlite3.
const adapter = new PrismaBetterSqlite3({
  url: resolveDatabaseUrl(),
  // better-sqlite3's native busy handler — applies from the very first query,
  // unlike a PRAGMA issued after connect (replaces the old busy_timeout PRAGMA).
  timeout: 5000,
});

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

// Execute PRAGMA statements to optimize SQLite. The datasource provider is
// hard-coded to sqlite, so these run unconditionally (the old DB_PROVIDER gate
// silently skipped WAL when the env var was missing). better-sqlite3 rejects
// multi-statement SQL and routes $executeRawUnsafe to .run(), which throws on
// PRAGMAs that return a value — so each PRAGMA runs as a separate
// $queryRawUnsafe. The single shared connection means per-connection settings
// (synchronous, cache_size, temp_store, mmap_size) apply to all queries.
const sqlitePragmas = [
  "PRAGMA journal_mode = WAL;", // concurrent readers during writes (persistent)
  "PRAGMA synchronous = NORMAL;", // safe with WAL; fsync at checkpoints only
  "PRAGMA cache_size = -65536;", // 64 MiB page cache
  "PRAGMA temp_store = MEMORY;", // sorts/temp B-trees in RAM
  "PRAGMA mmap_size = 268435456;", // 256 MiB memory-mapped reads
];
for (const pragma of sqlitePragmas) {
  prisma.$queryRawUnsafe(pragma).catch(console.error);
}

globalForPrisma.prisma = prisma;
