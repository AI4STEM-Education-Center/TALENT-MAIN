import { describe, it, expect, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";

// Confirms the SQLite tunings in src/lib/prisma.ts are actually live on the
// connection the app uses — not just issued. prisma.ts fires the PRAGMAs
// fire-and-forget (.catch, no await) at import; reading them back through the
// same shared client both proves they applied and serializes after them (the
// better-sqlite3 connection runs queries in order, so this read can't race the
// pending PRAGMA writes).
async function pragma(name: string, col = name): Promise<unknown> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`PRAGMA ${name};`);
  return rows[0]?.[col]; // values arrive as BigInt; callers coerce with Number()
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("SQLite PRAGMAs under the Prisma wrapper", () => {
  it("runs in WAL journal mode", async () => {
    expect(String(await pragma("journal_mode")).toLowerCase()).toBe("wal");
  });

  it("uses synchronous = NORMAL", async () => {
    expect(Number(await pragma("synchronous"))).toBe(1); // NORMAL
  });

  it("sets a 64 MiB page cache", async () => {
    expect(Number(await pragma("cache_size"))).toBe(-65536); // negative = KiB
  });

  it("stores temp B-trees in memory", async () => {
    expect(Number(await pragma("temp_store"))).toBe(2); // MEMORY
  });

  it("enables 256 MiB of memory-mapped I/O", async () => {
    expect(Number(await pragma("mmap_size"))).toBe(268435456);
  });

  it("applies the 5s busy timeout from the adapter", async () => {
    // Set via the better-sqlite3 adapter's `timeout: 5000` option (sqlite3_busy_timeout),
    // which replaced the old busy_timeout PRAGMA. SQLite names this result column `timeout`.
    expect(Number(await pragma("busy_timeout", "timeout"))).toBe(5000);
  });
});
