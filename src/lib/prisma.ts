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
});

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

// Execute PRAGMA statements to optimize SQLite for concurrent access.
// better-sqlite3 rejects multi-statement SQL and routes $executeRawUnsafe to
// .run(), which throws on PRAGMAs that return a value — so each PRAGMA runs as a
// separate $queryRawUnsafe (verified to actually switch journal_mode to WAL).
if (process.env.DB_PROVIDER === "sqlite") {
  prisma.$queryRawUnsafe(`PRAGMA journal_mode = WAL;`).catch(console.error);
  prisma.$queryRawUnsafe(`PRAGMA busy_timeout = 5000;`).catch(console.error);
}

globalForPrisma.prisma = prisma;
