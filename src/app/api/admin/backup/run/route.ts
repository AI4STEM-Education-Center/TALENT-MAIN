import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveWebdav } from "@/lib/backup";
import { enqueueBackup } from "@/lib/queue";

/**
 * POST /api/admin/backup/run
 * Manual "Backup now" — enqueue a backup job for the worker. Non-blocking: the
 * snapshot + upload happen off the request path so the site stays responsive.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg = await resolveWebdav();
  if (!cfg) {
    return NextResponse.json({ error: "WebDAV is not configured." }, { status: 400 });
  }

  try {
    enqueueBackup();
    return NextResponse.json({ success: true, message: "Backup queued." });
  } catch (error) {
    console.error("[BACKUP_RUN]", error);
    return NextResponse.json({ error: "Failed to queue backup." }, { status: 500 });
  }
}
