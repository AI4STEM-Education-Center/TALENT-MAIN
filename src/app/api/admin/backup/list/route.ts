import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import { listBackupsForCurrentEnv } from "@/lib/backup";
import { resolveAppEnv } from "@/lib/backup-core";
import { logApiError } from "@/lib/system-log";

/**
 * GET /api/admin/backup/list
 * List available backups in the current environment's folder, newest first.
 */
export async function GET() {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;

  try {
    const backups = await listBackupsForCurrentEnv();
    return NextResponse.json({
      appEnv: resolveAppEnv(),
      backups: backups.map((b) => ({
        name: b.name,
        date: b.date.toISOString(),
        size: b.size,
        includesS3: b.includesS3,
        s3ObjectCount: b.s3ObjectCount,
        s3TotalBytes: b.s3TotalBytes,
      })),
    });
  } catch (error) {
    logApiError("BACKUP_LIST", error);
    return NextResponse.json(
      { error: "Failed to list backups." },
      { status: 500 },
    );
  }
}
