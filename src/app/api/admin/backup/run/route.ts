import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import { resolveWebdav } from "@/lib/backup";
import { enqueueBackup } from "@/lib/queue";
import { getS3Config } from "@/lib/storage";
import { logApiError } from "@/lib/system-log";

/**
 * POST /api/admin/backup/run
 * Manual "Backup now" — enqueue a database + S3 backup job for the worker.
 * Scheduled jobs deliberately remain database-only.
 */
export async function POST() {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;

  const cfg = await resolveWebdav();
  if (!cfg) {
    return NextResponse.json(
      { error: "WebDAV is not configured." },
      { status: 400 },
    );
  }

  try {
    getS3Config();
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "S3 is not configured.",
      },
      { status: 400 },
    );
  }

  try {
    enqueueBackup({ includeS3: true });
    return NextResponse.json({
      success: true,
      message: "Database and S3 backup queued.",
    });
  } catch (error) {
    logApiError("BACKUP_RUN", error);
    return NextResponse.json(
      { error: "Failed to queue backup." },
      { status: 500 },
    );
  }
}
