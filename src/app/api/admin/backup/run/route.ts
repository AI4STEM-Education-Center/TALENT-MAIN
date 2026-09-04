import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
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
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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
