import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAppEnv, resolveDbFilePath, type AppEnv } from "./backup-core";

// CPU / memory / storage collection for the admin resource monitor,
// deliberately free of any `@/lib/prisma` import so the parsing and arithmetic
// stay unit-testable without a database. Persistence, the sampling loop and the
// read model live in src/lib/resource-monitor.ts.
//
// Every deployment runs two Node processes per environment (a web server and a
// worker) in separate containers, so each process measures ITSELF: there is no
// central agent and nothing needs the Docker socket. Inside a container the
// numbers come from cgroups, which report that container's slice rather than
// the whole host — that is what makes "the dev node" and "the dev worker"
// separately meaningful even though they share a machine.

export type NodeRole = "web" | "worker";

export interface NodeIdentity {
  nodeId: string;
  appEnv: AppEnv;
  role: NodeRole;
  hostname: string;
}

/** Stable identity for the node this process is. */
export function resolveNodeIdentity(role: NodeRole): NodeIdentity {
  const appEnv = resolveAppEnv();
  return { nodeId: `${appEnv}-${role}`, appEnv, role, hostname: os.hostname() };
}

// ─── cgroup readers ─────────────────────────────────────────────────────────
// v2 is the unified hierarchy used by modern Docker/systemd hosts; the v1 paths
// are the fallback for older daemons. Outside a container none of these exist
// and every reader returns null, so collectResourceSample() falls back to
// process/host figures (which is what a developer running `npm run dev` sees).

const CGROUP_V2 = {
  cpuStat: "/sys/fs/cgroup/cpu.stat",
  cpuMax: "/sys/fs/cgroup/cpu.max",
  memCurrent: "/sys/fs/cgroup/memory.current",
  memMax: "/sys/fs/cgroup/memory.max",
  memStat: "/sys/fs/cgroup/memory.stat",
};

const CGROUP_V1 = {
  cpuUsage: "/sys/fs/cgroup/cpuacct/cpuacct.usage",
  cpuQuota: "/sys/fs/cgroup/cpu/cpu.cfs_quota_us",
  cpuPeriod: "/sys/fs/cgroup/cpu/cpu.cfs_period_us",
  memUsage: "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  memLimit: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  memStat: "/sys/fs/cgroup/memory/memory.stat",
};

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readNumberFile(file: string): number | null {
  const raw = readFileOrNull(file);
  if (raw === null) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/** `usage_usec` (total CPU time consumed) out of a cgroup v2 cpu.stat blob. */
export function parseCgroupCpuStat(text: string): number | null {
  const match = text.match(/^usage_usec\s+(\d+)/m);
  return match ? Number(match[1]) : null;
}

/**
 * Cores allowed by a cgroup v2 `cpu.max` ("<quota> <period>", or "max <period>"
 * when uncapped). Returns null when uncapped so the caller can fall back to the
 * host core count.
 */
export function parseCgroupCpuMax(text: string): number | null {
  const [quota, period] = text.trim().split(/\s+/);
  if (!quota || quota === "max") return null;
  const q = Number(quota);
  const p = Number(period);
  if (!Number.isFinite(q) || !Number.isFinite(p) || p <= 0 || q <= 0) return null;
  return q / p;
}

/**
 * `inactive_file` from a cgroup memory.stat — reclaimable page cache. Both
 * `docker stats` and Kubernetes subtract it from total usage, because a
 * container that merely read a large file is not actually holding that memory.
 */
export function parseInactiveFileBytes(text: string): number {
  const match = text.match(/^(?:total_)?inactive_file\s+(\d+)/m);
  return match ? Number(match[1]) : 0;
}

/** Monotonic total CPU time this node has used, in microseconds. */
export function readCpuUsageUsec(): number {
  const v2 = readFileOrNull(CGROUP_V2.cpuStat);
  if (v2) {
    const usec = parseCgroupCpuStat(v2);
    if (usec !== null) return usec;
  }
  const v1Ns = readNumberFile(CGROUP_V1.cpuUsage);
  if (v1Ns !== null) return v1Ns / 1000;
  // Not containerized: this process's own CPU time. Same monotonic-counter
  // shape, so the delta math below is unchanged.
  const usage = process.cpuUsage();
  return usage.user + usage.system;
}

/** Cores this node may use — cgroup quota when set, else the host core count. */
export function readCpuCores(): number {
  const v2 = readFileOrNull(CGROUP_V2.cpuMax);
  if (v2) {
    const cores = parseCgroupCpuMax(v2);
    if (cores !== null) return cores;
  }
  const quota = readNumberFile(CGROUP_V1.cpuQuota);
  const period = readNumberFile(CGROUP_V1.cpuPeriod);
  if (quota !== null && period !== null && quota > 0 && period > 0) return quota / period;
  return Math.max(1, os.cpus().length);
}

export interface MemoryUsage {
  usedBytes: number;
  limitBytes: number;
}

export function readMemoryUsage(): MemoryUsage {
  const hostTotal = os.totalmem();

  const v2Current = readNumberFile(CGROUP_V2.memCurrent);
  if (v2Current !== null) {
    const cache = parseInactiveFileBytes(readFileOrNull(CGROUP_V2.memStat) ?? "");
    const rawMax = readFileOrNull(CGROUP_V2.memMax)?.trim();
    const max = rawMax && rawMax !== "max" ? Number(rawMax) : NaN;
    return {
      usedBytes: Math.max(0, v2Current - cache),
      // An unlimited container is bounded by the host, not by "max".
      limitBytes: Number.isFinite(max) && max > 0 && max < hostTotal ? max : hostTotal,
    };
  }

  const v1Usage = readNumberFile(CGROUP_V1.memUsage);
  if (v1Usage !== null) {
    const cache = parseInactiveFileBytes(readFileOrNull(CGROUP_V1.memStat) ?? "");
    const v1Limit = readNumberFile(CGROUP_V1.memLimit);
    return {
      usedBytes: Math.max(0, v1Usage - cache),
      // v1 reports "no limit" as a sentinel near 2^63, hence the host clamp.
      limitBytes: v1Limit !== null && v1Limit > 0 && v1Limit < hostTotal ? v1Limit : hostTotal,
    };
  }

  return { usedBytes: hostTotal - os.freemem(), limitBytes: hostTotal };
}

/**
 * Percentage of this node's CPU capacity used between two ticks. Normalised by
 * core count, so 100 means "every core saturated" rather than "one core busy".
 */
export function cpuPercentFromDelta(
  deltaUsageUsec: number,
  deltaWallMs: number,
  cores: number
): number {
  if (deltaWallMs <= 0 || cores <= 0 || deltaUsageUsec < 0) return 0;
  const percent = (deltaUsageUsec / 1000 / deltaWallMs) * 100 / cores;
  return Math.min(100, Math.round(percent * 100) / 100);
}

/**
 * Stateful CPU reader: a counter delta needs a previous reading, so the first
 * call has nothing to compare against and reports 0.
 */
export function createCpuSampler(now: () => number = Date.now) {
  let lastUsageUsec: number | null = null;
  let lastAt = now();

  return function sampleCpuPercent(cores: number): number {
    const usage = readCpuUsageUsec();
    const at = now();
    const previous = lastUsageUsec;
    const previousAt = lastAt;
    lastUsageUsec = usage;
    lastAt = at;
    if (previous === null) return 0;
    return cpuPercentFromDelta(usage - previous, at - previousAt, cores);
  };
}

// ─── Storage ────────────────────────────────────────────────────────────────

/** This environment's SQLite data directory (prod and dev mount different volumes). */
export function resolveDataDir(): string {
  return path.dirname(resolveDbFilePath());
}

/**
 * Recursive size of a directory, ignoring anything unreadable. The data
 * directory holds a handful of files (the app DB, its WAL, the queue DB), so a
 * synchronous walk is cheap enough for a once-a-minute sample.
 */
export function directorySizeBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += directorySizeBytes(full);
      else if (entry.isFile()) total += fs.statSync(full).size;
    } catch {
      // Raced with a delete (WAL checkpoint, backup cleanup) — skip it.
    }
  }
  return total;
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
}

/** Capacity of the filesystem backing `dir`. Zeroes if statfs is unavailable. */
export function readDiskUsage(dir: string): DiskUsage {
  try {
    const stats = fs.statfsSync(dir);
    return {
      totalBytes: stats.blocks * stats.bsize,
      // bavail (not bfree) — the reserved root blocks are not usable by us.
      freeBytes: stats.bavail * stats.bsize,
    };
  } catch {
    return { totalBytes: 0, freeBytes: 0 };
  }
}

export interface ResourceSampleInput {
  nodeId: string;
  appEnv: AppEnv;
  role: NodeRole;
  hostname: string;
  cpuPercent: number;
  cpuCores: number;
  memUsedBytes: number;
  memLimitBytes: number;
  dbBytes: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  s3Bytes: number | null;
}

/**
 * One complete reading for this node. `cpuPercent` comes from the caller's
 * sampler (it needs the previous tick) and `s3Bytes` from the caller's cache
 * (only the worker scans the bucket, hourly).
 */
export function collectResourceSample(
  identity: NodeIdentity,
  cpuPercent: number,
  s3Bytes: number | null
): ResourceSampleInput {
  const dataDir = resolveDataDir();
  const memory = readMemoryUsage();
  const disk = readDiskUsage(dataDir);
  return {
    ...identity,
    cpuPercent,
    cpuCores: readCpuCores(),
    memUsedBytes: memory.usedBytes,
    memLimitBytes: memory.limitBytes,
    dbBytes: directorySizeBytes(dataDir),
    diskTotalBytes: disk.totalBytes,
    diskFreeBytes: disk.freeBytes,
    s3Bytes,
  };
}

// ─── Read model: ranges and bucketing ───────────────────────────────────────

export const RESOURCE_RANGES = ["1h", "24h", "7d"] as const;
export type ResourceRange = (typeof RESOURCE_RANGES)[number];

export function isResourceRange(value: string | null): value is ResourceRange {
  return !!value && (RESOURCE_RANGES as readonly string[]).includes(value);
}

const MINUTE = 60 * 1000;

/**
 * Window length and chart resolution per range. A week of 60s samples is ~10k
 * points per node, far more than a chart can show, so longer ranges aggregate
 * into wider buckets — capping every range at roughly 60-340 points.
 */
export function rangeConfig(range: ResourceRange): { windowMs: number; bucketMs: number } {
  switch (range) {
    case "1h":
      return { windowMs: 60 * MINUTE, bucketMs: MINUTE };
    case "24h":
      return { windowMs: 24 * 60 * MINUTE, bucketMs: 10 * MINUTE };
    case "7d":
      return { windowMs: 7 * 24 * 60 * MINUTE, bucketMs: 30 * MINUTE };
  }
}

export interface ResourcePoint {
  /** Bucket start, epoch ms. */
  t: number;
  cpuPercent: number;
  cpuPeakPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  dbBytes: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  s3Bytes: number | null;
}

export interface BucketableSample {
  createdAt: Date;
  cpuPercent: number;
  memUsedBytes: number;
  memLimitBytes: number;
  dbBytes: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  s3Bytes: number | null;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Aggregate raw samples into fixed-width time buckets, oldest first.
 *
 * Rates (CPU, memory) are averaged — and CPU additionally keeps the bucket's
 * peak, so a 30-minute bucket cannot hide a spike. Levels (storage, limits) use
 * the newest reading in the bucket rather than an average: "how full is the
 * disk" is a point-in-time fact, not something to smooth. s3Bytes is the newest
 * NON-NULL reading, because web nodes never scan the bucket and would otherwise
 * blank out an environment's line.
 */
export function bucketSamples(samples: BucketableSample[], bucketMs: number): ResourcePoint[] {
  if (bucketMs <= 0) return [];
  const buckets = new Map<number, BucketableSample[]>();
  for (const sample of samples) {
    const key = Math.floor(sample.createdAt.getTime() / bucketMs) * bucketMs;
    const existing = buckets.get(key);
    if (existing) existing.push(sample);
    else buckets.set(key, [sample]);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, rows]) => {
      const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const latest = ordered[ordered.length - 1];
      const latestS3 = [...ordered].reverse().find((r) => r.s3Bytes !== null)?.s3Bytes ?? null;
      return {
        t,
        cpuPercent: Math.round(average(ordered.map((r) => r.cpuPercent)) * 100) / 100,
        cpuPeakPercent: Math.max(...ordered.map((r) => r.cpuPercent)),
        memUsedBytes: Math.round(average(ordered.map((r) => r.memUsedBytes))),
        memLimitBytes: latest.memLimitBytes,
        dbBytes: latest.dbBytes,
        diskTotalBytes: latest.diskTotalBytes,
        diskFreeBytes: latest.diskFreeBytes,
        s3Bytes: latestS3,
      };
    });
}
