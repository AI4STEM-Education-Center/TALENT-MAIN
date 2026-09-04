import { prisma } from "./prisma";
import { getS3Config, getS3KeyPrefix, sumS3PrefixBytes } from "./storage";
import {
  bucketSamples,
  collectResourceSample,
  createCpuSampler,
  createHostCpuSampler,
  rangeConfig,
  readCpuCores,
  resolveNodeIdentity,
  type NodeRole,
  type ResourcePoint,
  type ResourceRange,
} from "./resource-metrics";
import {
  createSpoolWriter,
  isSharedSpool,
  readSpool,
  resolveSpoolDir,
  type SpooledSample,
} from "./resource-spool";

// Sampling loop and read model for the admin resource monitor. The measuring
// lives in src/lib/resource-metrics.ts and the shared on-host store in
// src/lib/resource-spool.ts; this file wires the two together.

export const RESOURCE_SAMPLE_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.RESOURCE_SAMPLE_INTERVAL_MS) || 60_000,
);

/** The admin UI charts one week, so keeping more than that is dead weight. */
export const RESOURCE_SAMPLE_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.RESOURCE_SAMPLE_RETENTION_DAYS) || 7,
);

const RETENTION_MS = RESOURCE_SAMPLE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

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
      err instanceof Error ? err.message : err,
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
 * Samples go to the shared spool directory rather than to this environment's
 * database, which is what lets the other deployment chart this node — see the
 * topology note at the top of src/lib/resource-spool.ts.
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
  const sampleHostCpuPercent = createHostCpuSampler();
  // Prime both counters so the first recorded tick is a real delta, not 0.
  sampleCpuPercent(readCpuCores());
  sampleHostCpuPercent();

  const writer = createSpoolWriter(identity.nodeId, RETENTION_MS);
  console.log(
    `[Resources] Sampling node ${identity.nodeId} every ${RESOURCE_SAMPLE_INTERVAL_MS}ms -> ${writer.file}`,
  );

  let failing = false;
  const tick = async () => {
    try {
      const now = Date.now();
      const s3Bytes = role === "worker" ? await refreshS3UsageBytes(now) : null;
      const sample = collectResourceSample(
        identity,
        sampleCpuPercent(readCpuCores()),
        sampleHostCpuPercent(),
        s3Bytes,
      );
      writer.write(sample, now);
      failing = false;
    } catch (err: unknown) {
      if (!failing) {
        failing = true;
        console.error(
          `[Resources] Sampling ${identity.nodeId} failed (suppressing until it recovers):`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  };

  const timer = setInterval(tick, RESOURCE_SAMPLE_INTERVAL_MS);
  // Never hold the event loop open for telemetry.
  timer.unref?.();
  void tick();
}

/**
 * Drain the retired `ResourceSample` table.
 *
 * Samples moved to the shared spool (which each node prunes as it writes), but
 * the rows written before that change are still sitting in both databases. The
 * worker keeps calling this so they age out on the normal retention schedule;
 * once every deployment has been up for a retention window it is a no-op.
 *
 * The table itself stays in schema.prisma on purpose: docker-entrypoint.sh runs
 * `prisma db push` WITHOUT --accept-data-loss in production, so dropping a
 * table would make the container refuse to start. Removing the model needs a
 * deliberate, separately-reviewed migration.
 */
export async function pruneResourceSamples(
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
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

export interface HostPoint {
  t: number;
  cpuPercent: number | null;
  cpuPeakPercent: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  diskTotalBytes: number;
  diskFreeBytes: number;
}

/**
 * The machine itself, as opposed to any one container on it.
 *
 * There is one of these because prod and dev are two compose stacks on a single
 * EC2 instance. Every node reports the same host counters, so the series is
 * reconstructed from all of them together and survives any three of the four
 * being down.
 */
export interface HostSeries {
  cpuCores: number | null;
  memTotalBytes: number | null;
  diskTotalBytes: number;
  diskFreeBytes: number;
  lastSampleAt: number;
  points: HostPoint[];
}

export interface SpoolStatus {
  dir: string;
  /** False when RESOURCE_SPOOL_DIR is unset, i.e. this node cannot see its peer. */
  shared: boolean;
  /** Node files present in the spool directory. */
  files: string[];
  error: string | null;
}

export interface ResourceReport {
  range: ResourceRange;
  generatedAt: number;
  bucketMs: number;
  nodes: ResourceNodeSeries[];
  host: HostSeries | null;
  spool: SpoolStatus;
}

const reportCache = new Map<
  ResourceRange,
  { report: ResourceReport; at: number }
>();

/** Drops the memoized reports. Exists so specs can seed rows and re-read them. */
export function clearResourceReportCache(): void {
  reportCache.clear();
}

function reportCacheTtlMs(range: ResourceRange): number {
  // Never serve something older than a sample tick on the live view; the wide
  // ranges barely move between polls, so they can cache for longer.
  return range === "1h"
    ? Math.min(20_000, RESOURCE_SAMPLE_INTERVAL_MS)
    : 60_000;
}

function buildHostSeries(
  samples: SpooledSample[],
  bucketMs: number,
): HostSeries | null {
  if (samples.length === 0) return null;
  // Bucketing the union of every node's samples: the host fields agree across
  // nodes, so averaging them within a bucket returns that agreed value while
  // tolerating nodes that have no host reading yet. The per-node CPU/memory
  // columns of these buckets are meaningless (they would average four
  // containers) and are dropped here.
  const points = bucketSamples(samples, bucketMs).map<HostPoint>((point) => ({
    t: point.t,
    cpuPercent: point.hostCpuPercent,
    cpuPeakPercent: point.hostCpuPeakPercent,
    memUsedBytes: point.hostMemUsedBytes,
    memTotalBytes: point.hostMemTotalBytes,
    diskTotalBytes: point.diskTotalBytes,
    diskFreeBytes: point.diskFreeBytes,
  }));
  const latest = points[points.length - 1];
  if (!latest) return null;

  // Capacities are carried forward from the newest reading that HAS one rather
  // than read off the newest bucket: only nodes that can read the host's /proc
  // report them, so a bucket containing just a freshly restarted node would
  // otherwise erase the machine's size.
  const reversed = [...samples].reverse();
  return {
    cpuCores:
      reversed.find((s) => s.hostCpuCores !== null)?.hostCpuCores ?? null,
    memTotalBytes:
      reversed.find((s) => s.hostMemTotalBytes !== null)?.hostMemTotalBytes ??
      null,
    diskTotalBytes: latest.diskTotalBytes,
    diskFreeBytes: latest.diskFreeBytes,
    lastSampleAt: samples[samples.length - 1].createdAt.getTime(),
    points,
  };
}

/**
 * Bucketed series for every node in the shared spool — all four when both
 * deployments write to the same mounted directory, this deployment's two when
 * they do not — plus the whole-machine series derived from the same samples.
 *
 * Cached briefly: the admin page polls, and a 7-day window is ~40k lines.
 */
export async function buildResourceReport(
  range: ResourceRange,
  now: Date = new Date(),
): Promise<ResourceReport> {
  const cached = reportCache.get(range);
  if (cached && now.getTime() - cached.at < reportCacheTtlMs(range))
    return cached.report;

  const { windowMs, bucketMs } = rangeConfig(range);
  const { samples, files, error } = readSpool(now.getTime() - windowMs);

  const byNode = new Map<string, SpooledSample[]>();
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
    host: buildHostSeries(samples, bucketMs),
    spool: { dir: resolveSpoolDir(), shared: isSharedSpool(), files, error },
  };
  reportCache.set(range, { report, at: now.getTime() });
  return report;
}
