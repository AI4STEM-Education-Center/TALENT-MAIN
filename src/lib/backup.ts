import { Prisma, type BackupConfig } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptApiKey } from "@/lib/crypto";
import { resolveWebdavConfig, type ResolvedWebdavConfig } from "@/lib/webdav";
import {
  resolveAppEnv,
  listBackups,
  performBackup,
  removeBackup,
  stageRestore,
  type RetentionPolicy,
  type BackupListItem,
} from "@/lib/backup-core";
import {
  backupS3ToWebdav,
  getS3WebdavBackupSummary,
  restoreS3FromWebdav,
  type S3BackupResult,
} from "@/lib/s3-webdav-backup";

// Prisma-aware backup orchestration: reads the singleton BackupConfig, resolves
// WebDAV credentials (decrypting the stored password), runs the backup with
// status bookkeeping, and computes the schedule. The filesystem/WebDAV mechanics
// live in src/lib/backup-core.ts (kept prisma-free).

const DEFAULT_RETENTION: RetentionPolicy = {
  keepRecent: 7,
  keepWeekly: 4,
  keepMonthly: 12,
  keepYearly: 3,
};

export async function getConfigRow(): Promise<BackupConfig | null> {
  return prisma.backupConfig.findFirst();
}

export function retentionFromRow(row: BackupConfig | null): RetentionPolicy {
  if (!row) return { ...DEFAULT_RETENTION };
  return {
    keepRecent: row.keepRecent,
    keepWeekly: row.keepWeekly,
    keepMonthly: row.keepMonthly,
    keepYearly: row.keepYearly,
  };
}

function decryptRowPassword(row: BackupConfig | null): string | null {
  if (row?.passwordEnc && row.passwordIv && row.passwordTag) {
    try {
      return decryptApiKey(row.passwordEnc, row.passwordIv, row.passwordTag);
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolve WebDAV config from the stored DB row. null = unconfigured. */
export async function resolveWebdav(
  row?: BackupConfig | null,
): Promise<ResolvedWebdavConfig | null> {
  const r = row === undefined ? await getConfigRow() : row;
  return resolveWebdavConfig({
    webdavUrl: r?.webdavUrl ?? null,
    webdavUsername: r?.webdavUsername ?? null,
    password: decryptRowPassword(r ?? null),
    baseDir: r?.baseDir ?? null,
  });
}

export async function listBackupsForCurrentEnv(): Promise<BackupListItem[]> {
  const cfg = await resolveWebdav();
  if (!cfg) return [];
  const env = resolveAppEnv();
  const backups = await listBackups(cfg, env);
  return Promise.all(
    backups.map(async (backup) => {
      const s3 = await getS3WebdavBackupSummary(cfg, env, backup.name);
      return {
        ...backup,
        includesS3: s3 !== null,
        s3ObjectCount: s3?.objectCount ?? null,
        s3TotalBytes: s3?.totalBytes ?? null,
      };
    }),
  );
}

export async function stageRestoreForCurrentEnv(
  name: string,
): Promise<{ s3: S3BackupResult | null }> {
  const cfg = await resolveWebdav();
  if (!cfg) throw new Error("WebDAV is not configured");
  const env = resolveAppEnv();
  // Restore object bytes before arming the database swap. If S3 verification or
  // upload fails, the running database remains authoritative and no restart is armed.
  const s3 = await restoreS3FromWebdav(cfg, env, name);
  await stageRestore(cfg, env, name);
  return { s3 };
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

function getTzOffsetMs(timeZone: string, date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  const asUTC = Date.UTC(
    +map.year,
    +map.month - 1,
    +map.day,
    +map.hour,
    +map.minute,
    +map.second,
  );
  return asUTC - date.getTime();
}

/** UTC instant for a wall-clock time in `timeZone`, DST-corrected. */
function zonedWallToUTC(
  y: number,
  m0: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, m0, d, hh, mm, 0);
  let result = guess - getTzOffsetMs(timeZone, new Date(guess));
  // One refinement pass settles DST boundaries.
  result = guess - getTzOffsetMs(timeZone, new Date(result));
  return new Date(result);
}

function tzYmd(
  date: Date,
  timeZone: string,
): { year: number; month0: number; day: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) map[p.type] = p.value;
  return { year: +map.year, month0: +map.month - 1, day: +map.day };
}

/**
 * Next backup instant strictly after `from`: a series anchored at `anchorTime`
 * (interpreted in `timezone`) stepping every `intervalHours`. With the defaults
 * (24h @ 02:00 America/New_York) this is "daily at 2 AM Eastern".
 */
export function computeNextRun(
  row: Pick<BackupConfig, "intervalHours" | "anchorTime" | "timezone">,
  from: Date = new Date(),
): Date {
  const interval = Math.max(1, row.intervalHours || 24);
  const tz = row.timezone || "America/New_York";
  const [hhRaw, mmRaw] = (row.anchorTime || "02:00").split(":");
  const hh = Math.min(23, Math.max(0, parseInt(hhRaw, 10) || 0));
  const mm = Math.min(59, Math.max(0, parseInt(mmRaw, 10) || 0));

  const ymd = tzYmd(from, tz);
  let anchor = zonedWallToUTC(ymd.year, ymd.month0, ymd.day, hh, mm, tz);
  const stepMs = interval * 3_600_000;

  while (anchor.getTime() > from.getTime())
    anchor = new Date(anchor.getTime() - stepMs);
  let next = anchor;
  while (next.getTime() <= from.getTime())
    next = new Date(next.getTime() + stepMs);
  return next;
}

export function isBackupDue(
  row: BackupConfig | null,
  now: Date = new Date(),
): row is BackupConfig {
  if (!row || !row.enabled) return false;
  if (!row.nextRunAt) return true;
  return now.getTime() >= row.nextRunAt.getTime();
}

/**
 * If a scheduled backup is due, advance nextRunAt so we don't re-enqueue on
 * every tick, and return true so the caller enqueues a job.
 */
export async function claimDueBackup(now: Date = new Date()): Promise<boolean> {
  const row = await getConfigRow();
  if (!isBackupDue(row, now)) return false;
  await prisma.backupConfig.update({
    where: { id: row.id },
    data: { nextRunAt: computeNextRun(row, now) },
  });
  return true;
}

async function updateStatus(
  data: Prisma.BackupConfigUpdateInput,
): Promise<void> {
  const row = await getConfigRow();
  if (!row) return;
  await prisma.backupConfig.update({ where: { id: row.id }, data });
}

/** Run a backup now with full status bookkeeping. Called by the worker. */
export async function runBackupJob(
  options: { includeS3?: boolean } = {},
): Promise<{ key: string; pruned: string[]; s3: S3BackupResult | null }> {
  const row = await getConfigRow();
  const cfg = await resolveWebdav(row);
  if (!cfg) throw new Error("WebDAV is not configured");
  const env = resolveAppEnv();

  await updateStatus({ lastStatus: "RUNNING", lastError: null });
  try {
    let s3: S3BackupResult | null = null;
    const result = await performBackup(
      cfg,
      env,
      retentionFromRow(row),
      options.includeS3 === true
        ? {
            beforePublish: async (name) => {
              s3 = await backupS3ToWebdav(cfg, env, name);
            },
            onPublishFailure: async (name) => {
              await removeBackup(cfg, env, name);
            },
          }
        : undefined,
    );
    await updateStatus({
      lastStatus: "SUCCESS",
      lastError: null,
      lastRunAt: new Date(),
      lastBackupKey: result.key,
      ...(row ? { nextRunAt: computeNextRun(row) } : {}),
    });
    return { key: result.key, pruned: result.pruned, s3 };
  } catch (e) {
    await updateStatus({
      lastStatus: "FAILED",
      lastError: e instanceof Error ? e.message : String(e),
      lastRunAt: new Date(),
      ...(row ? { nextRunAt: computeNextRun(row) } : {}),
    });
    throw e;
  }
}
