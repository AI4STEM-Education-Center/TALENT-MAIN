import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { listBackupsForCurrentEnv } from "@/lib/backup";
import { resolveAppEnv } from "@/lib/backup-core";
import { logApiError } from "@/lib/system-log";

/**
 * GET /api/admin/backup/list
 * List available backups in the current environment's folder, newest first.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const backups = await listBackupsForCurrentEnv();
    return NextResponse.json({
      appEnv: resolveAppEnv(),
      backups: backups.map((b) => ({
        name: b.name,
        date: b.date.toISOString(),
        size: b.size,
      })),
    });
  } catch (error) {
    logApiError("BACKUP_LIST", error);
    return NextResponse.json({ error: "Failed to list backups." }, { status: 500 });
  }
}
