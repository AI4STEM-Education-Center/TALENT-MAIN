import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const dbUrl = process.env.DATABASE_URL ?? "";
const urlWithPool = dbUrl.includes("connection_limit")
  ? dbUrl
  : `${dbUrl}${dbUrl.includes("?") ? "&" : "?"}connection_limit=10&pool_timeout=30`;

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    datasources: { db: { url: urlWithPool } },
  });

// Execute PRAGMA statements to optimize SQLite for concurrent access
if (process.env.DB_PROVIDER === "sqlite") {
  prisma.$executeRawUnsafe(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;`).catch(console.error);
}

globalForPrisma.prisma = prisma;
