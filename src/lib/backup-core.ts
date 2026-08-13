import Database from "better-sqlite3";
import { gzipSync, gunzipSync } from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebDAVClient } from "webdav";
import { resolveDatabaseUrl } from "./db-url";
import {
  type ResolvedWebdavConfig,
  getClient,
  ensureDir,
  putFile,
  getFile,
  listFiles,
  removeFile,
  removePath,
  joinPath,
} from "./webdav";

// Filesystem + WebDAV backup mechanics, deliberately free of any `@/lib/prisma`
// import so the snapshot/upload/retention logic stays unit-testable without the
// DB. The prisma-aware orchestration (config row, status, scheduling) lives in
// src/lib/backup.ts.

export type AppEnv = "prod" | "dev";

export interface RetentionPolicy {
  keepRecent: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
}

const STAGED_NAME = ".restore-staged.db";
const PENDING_MARKER = ".pending-restore";

/** Which environment's backup folder this server reads/writes. Defaults to dev. */
export function resolveAppEnv(): AppEnv {
  return process.env.APP_ENV?.toLowerCase() === "prod" ? "prod" : "dev";
}

/** Absolute path to the live SQLite file (DATABASE_URL re-anchored like Prisma). */
export function resolveDbFilePath(): string {
  const url = resolveDatabaseUrl();
  return url.startsWith("file:") ? url.slice("file:".length) : url;
}

function dataDir(): string {
  return path.dirname(resolveDbFilePath());
}

export function stagedRestorePath(): string {
  return path.join(dataDir(), STAGED_NAME);
}

export function pendingMarkerPath(): string {
  return path.join(dataDir(), PENDING_MARKER);
}

/** Remote folder for an environment, e.g. `/backups/dev`. */
export function backupFolder(cfg: ResolvedWebdavConfig, env: AppEnv): string {
  return joinPath(cfg.baseDir, env);
}

// ─── Backup file naming ─────────────────────────────────────────────────────
// backup-YYYYMMDDTHHMMSSZ.db.gz (UTC). The timestamp drives GFS bucketing.

export function backupKeyName(d: Date): string {
  const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `backup-${stamp}.db.gz`;
}

export function parseBackupTimestamp(name: string): Date | null {
  const m = name.match(/^backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db\.gz$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  return Number.isFinite(t) ? new Date(t) : null;
}

// ─── Snapshot ───────────────────────────────────────────────────────────────

/**
 * Produce a gzipped, consistent online snapshot of the live DB using SQLite's
 * `VACUUM INTO` on a dedicated connection. This is the same technique as the
 * EC2 `sqlite3 .backup` script — WAL-safe and non-blocking to the running app
 * (it takes only a read transaction), so the live site is unaffected.
 */
export function createSnapshotGz(): Buffer {
  const src = resolveDbFilePath();
  if (!fs.existsSync(src)) throw new Error(`Database file not found at ${src}`);

  const tmp = path.join(os.tmpdir(), `al-snapshot-${Date.now()}-${process.pid}.db`);
  const db = new Database(src, { fileMustExist: true, timeout: 5000 });
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
  try {
    return gzipSync(fs.readFileSync(tmp));
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ─── GFS retention ────────────────────────────────────────────────────────────

function yearBucket(d: Date): string {
  return String(d.getUTCFullYear());
}

function monthBucket(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function isoWeekBucket(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * Grandfather-father-son selection: return the set of keys to KEEP given the
 * retention policy. Keeps the N newest outright, then the newest backup in each
 * of the most recent weeks/months/years up to each tier's limit. Pure — unit
 * tested over a fixed list of dates.
 */
export function selectForRetention(
  items: Array<{ key: string; date: Date }>,
  policy: RetentionPolicy,
): Set<string> {
  const sorted = [...items].sort((a, b) => b.date.getTime() - a.date.getTime());
  const keep = new Set<string>();

  for (const it of sorted.slice(0, Math.max(0, policy.keepRecent))) keep.add(it.key);

  const tier = (bucketOf: (d: Date) => string, limit: number) => {
    if (limit <= 0) return;
    const newestPerBucket = new Map<string, string>(); // bucket -> newest key (first seen)
    for (const it of sorted) {
      const b = bucketOf(it.date);
      if (!newestPerBucket.has(b)) newestPerBucket.set(b, it.key);
    }
    let n = 0;
    for (const key of newestPerBucket.values()) {
      if (n++ >= limit) break;
      keep.add(key);
    }
  };

  tier(isoWeekBucket, policy.keepWeekly);
  tier(monthBucket, policy.keepMonthly);
  tier(yearBucket, policy.keepYearly);
  return keep;
}

async function pruneRetention(
  client: WebDAVClient,
  folder: string,
  retention: RetentionPolicy,
): Promise<string[]> {
  const files = await listFiles(client, folder);
  const items = files
    .map((f) => ({ key: f.basename, date: parseBackupTimestamp(f.basename) }))
    .filter((x): x is { key: string; date: Date } => x.date !== null);
  const keep = selectForRetention(items, retention);
  const deleted: string[] = [];
  for (const it of items) {
    if (keep.has(it.key)) continue;
    try {
      await removeFile(client, joinPath(folder, it.key));
      // Manual backups may have a companion S3 snapshot. Keep its lifecycle
      // tied to the database file selected by the same retention decision.
      await removePath(client, joinPath(folder, `${it.key}.s3`));
      deleted.push(it.key);
    } catch {
      /* ignore individual delete failures; next run retries */
    }
  }
  return deleted;
}

// ─── Backup / list / restore ──────────────────────────────────────────────────

export interface BackupListItem {
  name: string;
  date: Date;
  size: number;
  includesS3?: boolean;
}

export async function listBackups(
  cfg: ResolvedWebdavConfig,
  env: AppEnv,
): Promise<BackupListItem[]> {
  const client = getClient(cfg);
  const files = await listFiles(client, backupFolder(cfg, env));
  return files
    .map((f) => ({ name: f.basename, date: parseBackupTimestamp(f.basename), size: f.size }))
    .filter((x): x is BackupListItem => x.date !== null)
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

/** Snapshot → upload → prune. Returns the uploaded key and any pruned names. */
export async function performBackup(
  cfg: ResolvedWebdavConfig,
  env: AppEnv,
  retention: RetentionPolicy,
  hooks: {
    /** Finish optional companion artifacts before the DB file becomes visible. */
    beforePublish?: (name: string) => Promise<void>;
    /** Best-effort rollback when companion creation or DB publication fails. */
    onPublishFailure?: (name: string) => Promise<void>;
  } = {},
): Promise<{ key: string; name: string; pruned: string[] }> {
  const gz = createSnapshotGz();
  const client = getClient(cfg);
  const folder = backupFolder(cfg, env);
  await ensureDir(client, folder);
  const name = backupKeyName(new Date());
  const key = joinPath(folder, name);
  try {
    await hooks.beforePublish?.(name);
    // The DB file is the restore-list publication marker. For manual backups it
    // appears only after the complete S3 companion manifest is available.
    await putFile(client, key, gz);
  } catch (error) {
    try {
      await hooks.onPublishFailure?.(name);
    } catch {
      // Preserve the original backup failure for status reporting.
    }
    throw error;
  }
  const pruned = await pruneRetention(client, folder, retention);
  return { key, name, pruned };
}

/** Roll back a database backup and its optional S3 companion. */
export async function removeBackup(
  cfg: ResolvedWebdavConfig,
  env: AppEnv,
  name: string,
): Promise<void> {
  if (!parseBackupTimestamp(name)) throw new Error("Invalid backup name");
  const client = getClient(cfg);
  const folder = backupFolder(cfg, env);
  await removePath(client, joinPath(folder, name));
  await removePath(client, joinPath(folder, `${name}.s3`));
}

/**
 * Download a backup, verify it, and arm it for the next boot. Never swaps the
 * live file while connections are open — the Docker entrypoint applies it before
 * the DB is opened. Returns the staged path.
 */
export async function stageRestore(
  cfg: ResolvedWebdavConfig,
  env: AppEnv,
  name: string,
): Promise<{ staged: string }> {
  const client = getClient(cfg);
  const gz = await getFile(client, joinPath(backupFolder(cfg, env), name));
  const raw = gunzipSync(gz);

  const staged = stagedRestorePath();
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, raw);

  // Verify the downloaded copy before arming it so a corrupt file can't brick boot.
  const check = new Database(staged, { readonly: true, fileMustExist: true });
  try {
    const result = check.pragma("integrity_check", { simple: true });
    if (result !== "ok") throw new Error(`integrity_check failed: ${String(result)}`);
  } finally {
    check.close();
  }

  fs.writeFileSync(pendingMarkerPath(), `${staged}\n`);
  return { staged };
}
