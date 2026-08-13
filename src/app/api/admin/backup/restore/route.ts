import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { stageRestoreForCurrentEnv } from "@/lib/backup";
import { logApiError } from "@/lib/system-log";

/**
 * POST /api/admin/backup/restore  { name }
 * Download + verify the chosen backup and STAGE it for the next boot — the file
 * is never swapped under live connections. A deliberate service restart (the
 * Docker entrypoint applies the staged file before connecting) completes it.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || !/^backup-\d{8}T\d{6}Z\.db\.gz$/.test(name)) {
      return NextResponse.json({ error: "A valid backup name is required." }, { status: 400 });
    }

    const { s3 } = await stageRestoreForCurrentEnv(name);
    return NextResponse.json({
      success: true,
      message: s3
        ? `Backup verified, ${s3.objectCount} S3 object(s) restored, and database staged. Restart the service to apply the database.`
        : "Backup verified and staged. Restart the service to apply it (the staged DB is swapped in before the app connects).",
    });
  } catch (error) {
    logApiError("BACKUP_RESTORE", error);
    const message = error instanceof Error ? error.message : "Failed to stage restore.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
