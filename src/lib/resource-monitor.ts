import { prisma } from "./prisma";
import { getS3Config, getS3KeyPrefix, sumS3PrefixBytes } from "./storage";
import {
  bucketSamples,
  collectResourceSample,
  createCpuSampler,
  rangeConfig,
  readCpuCores,
  resolveNodeIdentity,
  type NodeIdentity,
  type NodeRole,
  type ResourcePoint,
  type ResourceRange,
} from "./resource-metrics";

// Persistence and read model for the admin resource monitor. The measuring
// itself lives in src/lib/resource-metrics.ts; this file is the half that
// touches Prisma, so it is imported only from the worker, the Next.js
// instrumentation hook, and the admin/internal API routes.

export const RESOURCE_SAMPLE_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.RESOURCE_SAMPLE_INTERVAL_MS) || 60_000
);

/** The admin UI charts one week, so keeping more than that is dead weight. */
export const RESOURCE_SAMPLE_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.RESOURCE_SAMPLE_RETENTION_DAYS) || 7
);

/** A node is "offline" in the UI once it misses this many sample ticks. */
export const NODE_STALE_AFTER_MS = RESOURCE_SAMPLE_INTERVAL_MS * 3;

// ─── S3 footprint ───────────────────────────────────────────────────────────

const S3_USAGE_TTL_MS = 60 * 60 * 1000;

let s3Usage: { bytes: number | null; at: number } | null = null;

/**
 * Bytes stored under this environment's S3 prefix, refreshed at most hourly.
 *
 * Only the worker calls this: it is a full paginated bucket listing, and one
 * scan per environment per hour is plenty for a storage chart. Web nodes write
 * a null s3Bytes and the read model carries the worker's last value forward.
 * Returns null when S3 is unconfigured or the listing fails, so a bucket
 * problem degrades the chart instead of stopping CPU/RAM sampling.
 */
async function refreshS3UsageBytes(now: number): Promise<number | null> {
  if (s3Usage && now - s3Usage.at < S3_USAGE_TTL_MS) return s3Usage.bytes;
  let bytes: number | null = null;
  try {
    const { bucket } = getS3Config();
    ({ bytes } = await sumS3PrefixBytes(bucket, getS3KeyPrefix()));
  } catch (err: unknown) {
    console.error(
      "[Resources] S3 usage scan failed:",
      err instanceof Error ? err.message : err
    );
  }
  s3Usage = { bytes, at: now };
  return bytes;
}

// ─── Sampling ───────────────────────────────────────────────────────────────

let samplerStarted = false;

/**
 * Start this process's once-a-minute self-measurement loop. Idempotent, because
 * Next.js can evaluate the instrumentation module more than once in dev.
 *
 * Failures are logged at most once per outage rather than every tick: a
 * monitoring loop that floods the log it shares with real errors is worse than
 * a gap in the chart. Deliberately NOT written through logSystemEvent for the
 * same reason.
 */
export function startResourceSampler(role: NodeRole): void {
  if (samplerStarted) return;
  samplerStarted = true;

  const identity = resolveNodeIdentity(role);
  const sampleCpuPercent = createCpuSampler();
  // Prime the CPU counter so the first recorded tick is a real delta, not 0.
  sampleCpuPercent(readCpuCores());

  console.log(
    `[Resources] Sampling node ${identity.nodeId} every ${RESOURCE_SAMPLE_INTERVAL_MS}ms`
  );

  let failing = false;
  const tick = async () => {
    try {
      const s3Bytes = role === "worker" ? await refreshS3UsageBytes(Date.now()) : null;
      const sample = collectResourceSample(identity, sampleCpuPercent(readCpuCores()), s3Bytes);
      await prisma.resourceSample.create({ data: sample });
      failing = false;
    } catch (err: unknown) {
      if (!failing) {
        failing = true;
        console.error(
          `[Resources] Sampling ${identity.nodeId} failed (suppressing until it recovers):`,
          err instanceof Error ? err.message : err
        );
      }
    }
  };

  const timer = setInterval(tick, RESOURCE_SAMPLE_INTERVAL_MS);
  // Never hold the event loop open for telemetry.
  timer.unref?.();
  void tick();
}

/** Drop samples past the retention window. Idempotent — a missed run catches up. */
export async function pruneResourceSamples(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - RESOURCE_SAMPLE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.resourceSample.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return count;
}

// ─── Read model ─────────────────────────────────────────────────────────────

export interface ResourceNodeSeries {
  nodeId: string;
  appEnv: string;
  role: string;
  hostname: string;
  /** Cores available to the node — a property of the box, not of a moment. */
  cpuCores: number;
  /** Newest raw sample time (epoch ms), used to decide online/stale. */
  lastSampleAt: number;
  points: ResourcePoint[];
}

export interface ResourceReport {
  range: ResourceRange;
  generatedAt: number;
  bucketMs: number;
  nodes: ResourceNodeSeries[];
}

const reportCache = new Map<ResourceRange, { report: ResourceReport; at: number }>();

/** Drops the memoized reports. Exists so specs can seed rows and re-read them. */
export function clearResourceReportCache(): void {
  reportCache.clear();
}

function reportCacheTtlMs(range: ResourceRange): number {
  // Never serve something older than a sample tick on the live view; the wide
  // ranges barely move between polls, so they can cache for longer.
  return range === "1h" ? Math.min(20_000, RESOURCE_SAMPLE_INTERVAL_MS) : 60_000;
}

/**
 * Bucketed series for every node THIS database knows about — which, because
 * prod and dev are separate deployments with separate databases, means this
 * environment's web node and worker only. The admin route merges the peer
 * environment's report (src/lib/resource-peer.ts) to complete the picture.
 *
 * Cached briefly: the admin page polls, and a 7-day window is ~20k rows.
 */
export async function buildResourceReport(
  range: ResourceRange,
  now: Date = new Date()
): Promise<ResourceReport> {
  const cached = reportCache.get(range);
  if (cached && now.getTime() - cached.at < reportCacheTtlMs(range)) return cached.report;

  const { windowMs, bucketMs } = rangeConfig(range);
  const since = new Date(now.getTime() - windowMs);
  const samples = await prisma.resourceSample.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: "asc" },
    select: {
      createdAt: true,
      nodeId: true,
      appEnv: true,
      role: true,
      hostname: true,
      cpuPercent: true,
      cpuCores: true,
      memUsedBytes: true,
      memLimitBytes: true,
      dbBytes: true,
      diskTotalBytes: true,
      diskFreeBytes: true,
      s3Bytes: true,
    },
  });

  const byNode = new Map<string, typeof samples>();
  for (const sample of samples) {
    const existing = byNode.get(sample.nodeId);
    if (existing) existing.push(sample);
    else byNode.set(sample.nodeId, [sample]);
  }

  const nodes: ResourceNodeSeries[] = [...byNode.values()].map((rows) => {
    const latest = rows[rows.length - 1];
    return {
      nodeId: latest.nodeId,
      appEnv: latest.appEnv,
      role: latest.role,
      hostname: latest.hostname,
      cpuCores: latest.cpuCores,
      lastSampleAt: latest.createdAt.getTime(),
      points: bucketSamples(rows, bucketMs),
    };
  });

  const report: ResourceReport = {
    range,
    generatedAt: now.getTime(),
    bucketMs,
    nodes: nodes.sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
  };
  reportCache.set(range, { report, at: now.getTime() });
  return report;
}
