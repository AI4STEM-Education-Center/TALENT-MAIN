import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { logApiError } from "@/lib/system-log";
import { isResourceRange, type ResourceRange } from "@/lib/resource-metrics";
import {
  buildResourceReport,
  NODE_STALE_AFTER_MS,
  RESOURCE_SAMPLE_INTERVAL_MS,
  RESOURCE_SAMPLE_RETENTION_DAYS,
  type ResourceNodeSeries,
} from "@/lib/resource-monitor";
import { fetchPeerNodes } from "@/lib/resource-peer";

export const runtime = "nodejs";

/**
 * CPU / memory / storage history for every node of both deployments, feeding
 * the admin System Resources tab.
 *
 * The local database only holds this environment's web node and worker (prod
 * and dev have separate databases), so the peer deployment's two nodes are
 * fetched over HTTP and merged in. Local rows win on a nodeId collision — a
 * misconfigured peer pointing at itself can then never overwrite the numbers we
 * measured directly.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user || session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const requested = req.nextUrl.searchParams.get("range");
    const range: ResourceRange = isResourceRange(requested) ? requested : "24h";

    const [local, peer] = await Promise.all([buildResourceReport(range), fetchPeerNodes(range)]);

    const byNode = new Map<string, ResourceNodeSeries>();
    for (const node of [...peer.nodes, ...local.nodes]) byNode.set(node.nodeId, node);

    return NextResponse.json({
      range,
      generatedAt: local.generatedAt,
      bucketMs: local.bucketMs,
      sampleIntervalMs: RESOURCE_SAMPLE_INTERVAL_MS,
      staleAfterMs: NODE_STALE_AFTER_MS,
      retentionDays: RESOURCE_SAMPLE_RETENTION_DAYS,
      localEnv: process.env.APP_ENV?.toLowerCase() === "prod" ? "prod" : "dev",
      peer: peer.status,
      nodes: [...byNode.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
    });
  } catch (error) {
    logApiError("ADMIN_RESOURCES", error, "Failed to build resource report");
    return NextResponse.json({ error: "Failed to load resource metrics" }, { status: 500 });
  }
}
