import path from "node:path";

/**
 * Resolve DATABASE_URL into an absolute `file:` URL for SQLite.
 *
 * Prisma's bundled engine (≤ v6) resolved relative `file:` paths against the
 * schema directory (`prisma/`). The Prisma 7 better-sqlite3 adapter and the v7
 * CLI both resolve relative paths against `process.cwd()` instead — so a bare
 * `file:./data/prod.db` would silently open a *different* file after the
 * upgrade. We re-anchor relative paths to `<cwd>/prisma` to preserve the
 * pre-upgrade location, and make them absolute so the runtime client and the
 * CLI (`prisma db push`) always agree on the same file — the same reason the
 * test harness pins an absolute path.
 *
 * Absolute paths and `file::memory:` are returned unchanged. Engine-only query
 * params (e.g. the old `?connection_limit`) are dropped — better-sqlite3 has a
 * single-connection model and would treat them as part of the filename.
 */
export function resolveDatabaseUrl(
  raw: string | undefined = process.env.DATABASE_URL,
): string {
  if (!raw || !raw.startsWith("file:")) return raw ?? "";
  const filePath = raw.slice("file:".length).split("?")[0];
  if (filePath === ":memory:") return raw;
  const absolute = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), "prisma", filePath);
  return `file:${absolute}`;
}
