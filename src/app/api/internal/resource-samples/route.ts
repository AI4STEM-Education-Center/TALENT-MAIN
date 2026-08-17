import { NextRequest, NextResponse } from "next/server";
import { logApiError } from "@/lib/system-log";
import { isResourceRange, type ResourceRange } from "@/lib/resource-metrics";
import { buildResourceReport } from "@/lib/resource-monitor";
import { verifyResourceMonitorToken } from "@/lib/resource-peer";

export const runtime = "nodejs";

/**
 * Deployment-to-deployment feed of this environment's node metrics, so the
 * admin System Resources tab on either site can show all four nodes (see
 * src/lib/resource-peer.ts for the topology).
 *
 * Authenticated by the shared RESOURCE_MONITOR_TOKEN rather than a session:
 * the caller is the peer's server, which has no user to sign in as. It is
 * therefore reachable without a session (see the /api/internal/ bypass in
 * src/proxy.ts) and returns nothing but aggregate CPU/RAM/storage numbers —
 * no user, class, or content data. Requests still pass the proxy's host
 * allowlist, so RESOURCE_MONITOR_PEER_URL must be the peer's public URL.
 */
export async function GET(req: NextRequest) {
  if (!verifyResourceMonitorToken(req.headers.get("authorization"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const requested = req.nextUrl.searchParams.get("range");
    const range: ResourceRange = isResourceRange(requested) ? requested : "24h";
    const report = await buildResourceReport(range);
    return NextResponse.json(report);
  } catch (error) {
    logApiError("INTERNAL_RESOURCE_SAMPLES", error, "Failed to build resource report for peer");
    return NextResponse.json({ error: "Failed to load resource metrics" }, { status: 500 });
  }
}
