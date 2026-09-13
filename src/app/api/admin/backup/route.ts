import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptApiKey, maskApiKey, decryptApiKey } from "@/lib/crypto";
import { computeNextRun } from "@/lib/backup";
import { resolveAppEnv } from "@/lib/backup-core";
import { logApiError } from "@/lib/system-log";

const SINGLETON_ID = "singleton";

function clampInt(
  value: unknown,
  def: number,
  min: number,
  max: number,
): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

function serialize(cfg: {
  webdavUrl: string | null;
  webdavUsername: string | null;
  passwordEnc: string | null;
  passwordIv: string | null;
  passwordTag: string | null;
  baseDir: string;
  enabled: boolean;
  intervalHours: number;
  anchorTime: string;
  timezone: string;
  keepRecent: number;
  keepWeekly: number;
  keepMonthly: number;
  keepYearly: number;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  lastStatus: string | null;
  lastError: string | null;
  lastBackupKey: string | null;
  updatedAt: Date;
}) {
  let maskedPassword: string | null = null;
  if (cfg.passwordEnc && cfg.passwordIv && cfg.passwordTag) {
    try {
      maskedPassword = maskApiKey(
        decryptApiKey(cfg.passwordEnc, cfg.passwordIv, cfg.passwordTag),
      );
    } catch {
      maskedPassword = "••••(decryption failed)";
    }
  }
  return {
    webdavUrl: cfg.webdavUrl,
    webdavUsername: cfg.webdavUsername,
    hasPassword: !!cfg.passwordEnc,
    maskedPassword,
    baseDir: cfg.baseDir,
    enabled: cfg.enabled,
    intervalHours: cfg.intervalHours,
    anchorTime: cfg.anchorTime,
    timezone: cfg.timezone,
    keepRecent: cfg.keepRecent,
    keepWeekly: cfg.keepWeekly,
    keepMonthly: cfg.keepMonthly,
    keepYearly: cfg.keepYearly,
    lastRunAt: cfg.lastRunAt,
    nextRunAt: cfg.nextRunAt,
    lastStatus: cfg.lastStatus,
    lastError: cfg.lastError,
    lastBackupKey: cfg.lastBackupKey,
    updatedAt: cfg.updatedAt,
  };
}

/**
 * GET /api/admin/backup
 * Return the singleton backup config (WebDAV password masked) + current env.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg = await prisma.backupConfig.findFirst();
  return NextResponse.json({
    config: cfg ? serialize(cfg) : null,
    appEnv: resolveAppEnv(),
  });
}

/**
 * PUT /api/admin/backup
 * Upsert the singleton config. A password sent as the masked placeholder
 * ("••••…") is left unchanged; an empty string clears it. Recomputes nextRunAt.
 */
export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json();

    const webdavUrl =
      typeof body.webdavUrl === "string" ? body.webdavUrl.trim() || null : null;
    const webdavUsername =
      typeof body.webdavUsername === "string"
        ? body.webdavUsername.trim() || null
        : null;
    let baseDir =
      typeof body.baseDir === "string" ? body.baseDir.trim() : "/backups";
    if (!baseDir.startsWith("/")) baseDir = `/${baseDir}`;
    baseDir = baseDir.replace(/\/+$/, "") || "/backups";

    const enabled = body.enabled === true;
    const intervalHours = clampInt(body.intervalHours, 24, 1, 24 * 30);
    const anchorTime = /^\d{2}:\d{2}$/.test(body.anchorTime)
      ? body.anchorTime
      : "02:00";
    const timezone =
      typeof body.timezone === "string" && body.timezone.trim()
        ? body.timezone.trim()
        : "America/New_York";

    const keepRecent = clampInt(body.keepRecent, 7, 0, 365);
    const keepWeekly = clampInt(body.keepWeekly, 4, 0, 520);
    const keepMonthly = clampInt(body.keepMonthly, 12, 0, 240);
    const keepYearly = clampInt(body.keepYearly, 3, 0, 100);

    if (enabled && !webdavUrl) {
      return NextResponse.json(
        { error: "A WebDAV URL is required to enable scheduled backups." },
        { status: 400 },
      );
    }

    // Password encryption (mirror SMTP): masked → unchanged; "" → clear; new → encrypt.
    let passwordFields:
      | {
          passwordEnc: string | null;
          passwordIv: string | null;
          passwordTag: string | null;
        }
      | undefined;
    if (typeof body.password === "string") {
      const raw = body.password;
      if (raw && !raw.startsWith("••••")) {
        const enc = encryptApiKey(raw);
        passwordFields = {
          passwordEnc: enc.encrypted,
          passwordIv: enc.iv,
          passwordTag: enc.tag,
        };
      } else if (raw === "") {
        passwordFields = {
          passwordEnc: null,
          passwordIv: null,
          passwordTag: null,
        };
      }
    }

    const nextRunAt = enabled
      ? computeNextRun({ intervalHours, anchorTime, timezone })
      : null;

    const baseData = {
      webdavUrl,
      webdavUsername,
      baseDir,
      enabled,
      intervalHours,
      anchorTime,
      timezone,
      keepRecent,
      keepWeekly,
      keepMonthly,
      keepYearly,
      nextRunAt,
      ...(passwordFields ?? {}),
    };

    const existing = await prisma.backupConfig.findFirst();
    const cfg = existing
      ? await prisma.backupConfig.update({
          where: { id: existing.id },
          data: baseData,
        })
      : await prisma.backupConfig.create({
          data: { id: SINGLETON_ID, ...baseData },
        });

    return NextResponse.json({ config: serialize(cfg) });
  } catch (error) {
    logApiError("BACKUP_PUT", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
