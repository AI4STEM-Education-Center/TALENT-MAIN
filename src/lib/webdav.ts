import { createClient, type WebDAVClient, type FileStat } from "webdav";

// Thin, prisma-free wrapper over the `webdav` client plus config resolution.
// Kept free of any `@/lib/prisma` import so the filesystem/WebDAV mechanics in
// src/lib/backup-core.ts stay testable without pulling in the DB. The DB-backed
// config lives in src/lib/backup.ts.

export interface ResolvedWebdavConfig {
  url: string;
  username: string | null;
  password: string | null;
  baseDir: string;
}

/** Shape of the persisted config a server caller passes in (password decrypted). */
export interface WebdavRowLike {
  webdavUrl?: string | null;
  webdavUsername?: string | null;
  password?: string | null;
  baseDir?: string | null;
}

function normalizeDir(dir: string): string {
  let d = dir.trim();
  if (!d.startsWith("/")) d = `/${d}`;
  return d.replace(/\/+$/, "") || "/";
}

/** Join WebDAV path segments into a single normalized absolute path. */
export function joinPath(...segments: string[]): string {
  const joined = segments
    .flatMap((s) => {
      const trimmed = s.replace(/^\/+|\/+$/g, "");
      return trimmed ? [trimmed] : [];
    })
    .join("/");
  return `/${joined}`;
}

/**
 * Resolve a persisted config row into a usable WebDAV config. Returns null when
 * no URL is configured.
 */
export function resolveWebdavConfig(row?: WebdavRowLike | null): ResolvedWebdavConfig | null {
  const url = row?.webdavUrl ?? null;
  if (!url) return null;
  return {
    url,
    username: row?.webdavUsername ?? null,
    password: row?.password ?? null,
    baseDir: normalizeDir(row?.baseDir ?? "/backups"),
  };
}

export function getClient(cfg: ResolvedWebdavConfig): WebDAVClient {
  return createClient(cfg.url, {
    ...(cfg.username ? { username: cfg.username } : {}),
    ...(cfg.password ? { password: cfg.password } : {}),
  });
}

export async function ensureDir(client: WebDAVClient, dir: string): Promise<void> {
  if (await client.exists(dir)) return;
  await client.createDirectory(dir, { recursive: true });
}

export async function putFile(
  client: WebDAVClient,
  remotePath: string,
  data: Buffer,
): Promise<void> {
  await client.putFileContents(remotePath, data, { overwrite: true });
}

export async function getFile(client: WebDAVClient, remotePath: string): Promise<Buffer> {
  const data = await client.getFileContents(remotePath, { format: "binary" });
  return data as unknown as Buffer;
}

/** List regular files (not subdirectories) directly inside `dir`. */
export async function listFiles(client: WebDAVClient, dir: string): Promise<FileStat[]> {
  if (!(await client.exists(dir))) return [];
  const items = await client.getDirectoryContents(dir);
  return items.filter((f) => f.type === "file");
}

export async function removeFile(client: WebDAVClient, remotePath: string): Promise<void> {
  await client.deleteFile(remotePath);
}

/** Delete a WebDAV file or collection when it exists. */
export async function removePath(client: WebDAVClient, remotePath: string): Promise<void> {
  if (await client.exists(remotePath)) await client.deleteFile(remotePath);
}

/** Cheap reachability probe used by the admin "Test connection" button. */
export async function testConnection(
  cfg: ResolvedWebdavConfig,
): Promise<{ ok: boolean; message: string }> {
  try {
    const client = getClient(cfg);
    await client.getDirectoryContents("/");
    return { ok: true, message: `Connected to ${cfg.url}` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Connection failed" };
  }
}
