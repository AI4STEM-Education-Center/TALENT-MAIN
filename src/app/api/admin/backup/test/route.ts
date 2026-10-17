import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import { resolveWebdav } from "@/lib/backup";
import { testConnection } from "@/lib/webdav";

/**
 * POST /api/admin/backup/test
 * Probe the configured WebDAV endpoint and report reachability.
 */
export async function POST() {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;

  const cfg = await resolveWebdav();
  if (!cfg) {
    return NextResponse.json({
      success: false,
      error: "WebDAV is not configured.",
    });
  }

  const result = await testConnection(cfg);
  return NextResponse.json({
    success: result.ok,
    message: result.message,
    error: result.ok ? undefined : result.message,
  });
}
