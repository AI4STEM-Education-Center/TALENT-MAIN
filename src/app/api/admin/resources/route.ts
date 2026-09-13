import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logApiError } from "@/lib/system-log";
import { isResourceRange, type ResourceRange } from "@/lib/resource-metrics";
import {
  buildResourceReport,
  NODE_STALE_AFTER_MS,
  RESOURCE_SAMPLE_INTERVAL_MS,
  RESOURCE_SAMPLE_RETENTION_DAYS,
} from "@/lib/resource-monitor";

export const runtime = "nodejs";

/**
 * CPU / memory / storage history for every node of both deployments plus the
 * EC2 instance they share, feeding the admin System Resources tab.
 *
 * All four nodes come from one read: prod and dev write their samples into a
 * directory bind-mounted into both compose stacks (see src/lib/resource-spool.ts),
 * so this route no longer has to call the peer deployment over HTTPS to
 * complete the picture — and there is nothing to configure before it does.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const requested = req.nextUrl.searchParams.get("range");
    const range: ResourceRange = isResourceRange(requested) ? requested : "24h";

    const report = await buildResourceReport(range);

    return NextResponse.json({
      range,
      generatedAt: report.generatedAt,
      bucketMs: report.bucketMs,
      sampleIntervalMs: RESOURCE_SAMPLE_INTERVAL_MS,
      staleAfterMs: NODE_STALE_AFTER_MS,
      retentionDays: RESOURCE_SAMPLE_RETENTION_DAYS,
      localEnv: process.env.APP_ENV?.toLowerCase() === "prod" ? "prod" : "dev",
      nodes: report.nodes,
      host: report.host,
      // The UI only needs to know whether the shared mount is in place; the
      // directory and file list are there to make a misconfigured mount
      // diagnosable from the page instead of from a shell on the box.
      spool: report.spool,
    });
  } catch (error) {
    logApiError("ADMIN_RESOURCES", error, "Failed to build resource report");
    return NextResponse.json({ error: "Failed to load resource metrics" }, { status: 500 });
  }
}
