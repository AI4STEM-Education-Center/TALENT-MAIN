import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveWebdav } from "@/lib/backup";
import { testConnection } from "@/lib/webdav";

/**
 * POST /api/admin/backup/test
 * Probe the configured WebDAV endpoint and report reachability.
 */
export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const cfg = await resolveWebdav();
  if (!cfg) {
    return NextResponse.json({ success: false, error: "WebDAV is not configured." });
  }

  const result = await testConnection(cfg);
  return NextResponse.json({ success: result.ok, message: result.message, error: result.ok ? undefined : result.message });
}
