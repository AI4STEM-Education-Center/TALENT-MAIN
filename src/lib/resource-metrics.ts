import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAppEnv, resolveDbFilePath, type AppEnv } from "./backup-core";

// CPU / memory / storage collection for the admin resource monitor,
// deliberately free of any `@/lib/prisma` import so the parsing and arithmetic
// stay unit-testable without a database. The sampling loop and the read model
// live in src/lib/resource-monitor.ts; the shared spool they persist through
// lives in src/lib/resource-spool.ts.
//
// Every deployment runs two Node processes per environment (a web server and a
// worker) in separate containers, so each process measures ITSELF: there is no
// central agent and nothing needs the Docker socket. Inside a container the
// numbers come from cgroups, which report that container's slice rather than
// the whole host — that is what makes "the dev node" and "the dev worker"
// separately meaningful even though they share a machine.
//
// Each node ALSO reads the host's /proc, which Docker does not namespace: a
// container's /proc/stat and /proc/meminfo describe the whole EC2 box. That is
// what feeds the "whole machine" panel, and it is the only way to see the
// difference between "our four containers are busy" and "the machine is busy" —
// the four container slices can be near-idle while the box is not.

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

// ─── Host (whole-machine) readers ───────────────────────────────────────────
// Docker does not namespace /proc, so these read the EC2 instance's own
// counters from inside the container. Overridable for the (currently
// hypothetical) case of lxcfs masking them, and every reader returns null when
// the files are absent — macOS during local development, mainly — so the host
// panel degrades to "unavailable" instead of inventing numbers.

const PROC_DIR = process.env.HOST_PROC_DIR?.trim() || "/proc";

export interface HostCpuTimes {
  /** All jiffies across every state, i.e. cores × elapsed time. */
  totalJiffies: number;
  /** The subset spent idle or blocked on I/O — not doing work. */
  idleJiffies: number;
}

/**
 * The aggregate `cpu` line of /proc/stat, which sums every core.
 *
 * Fields are user, nice, system, idle, iowait, irq, softirq, steal, … — idle
 * and iowait are positions 3 and 4. iowait counts as idle here: a core waiting
 * on the EBS volume is not consuming CPU, and calling it busy would make disk
 * pressure masquerade as compute pressure.
 */
export function parseProcStatCpu(text: string): HostCpuTimes | null {
  const line = text.split("\n").find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 5 || fields.some((n) => !Number.isFinite(n))) return null;
  return {
    totalJiffies: fields.reduce((sum, n) => sum + n, 0),
    idleJiffies: fields[3] + fields[4],
  };
}

export interface HostMemory {
  usedBytes: number;
  totalBytes: number;
}

/**
 * MemTotal and MemAvailable out of /proc/meminfo, in bytes (the file is kB).
 *
 * "Used" is total minus AVAILABLE rather than total minus free: the kernel
 * spends every spare page on cache, so MemFree on a healthy box is always near
 * zero and would read as a machine permanently at 100%. MemAvailable is the
 * kernel's own estimate of what a new allocation could actually get.
 */
export function parseMemInfoBytes(text: string): HostMemory | null {
  const field = (name: string): number | null => {
    const match = text.match(new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m"));
    return match ? Number(match[1]) * 1024 : null;
  };
  const total = field("MemTotal");
  if (total === null || total <= 0) return null;
  const available = field("MemAvailable") ?? field("MemFree");
  if (available === null) return null;
  return { usedBytes: Math.max(0, total - available), totalBytes: total };
}

export function readHostCpuTimes(): HostCpuTimes | null {
  const raw = readFileOrNull(path.join(PROC_DIR, "stat"));
  return raw ? parseProcStatCpu(raw) : null;
}

export function readHostMemory(): HostMemory | null {
  const raw = readFileOrNull(path.join(PROC_DIR, "meminfo"));
  return raw ? parseMemInfoBytes(raw) : null;
}

/** Busy share of the whole machine between two /proc/stat readings. */
export function hostCpuPercentFromDelta(
  deltaTotalJiffies: number,
  deltaIdleJiffies: number
): number | null {
  if (deltaTotalJiffies <= 0 || deltaIdleJiffies < 0) return null;
  const busy = Math.max(0, deltaTotalJiffies - deltaIdleJiffies);
  return Math.min(100, Math.round((busy / deltaTotalJiffies) * 10000) / 100);
}

/**
 * Stateful whole-machine CPU reader. Like createCpuSampler this needs a
 * previous reading, but it reports null rather than 0 for "don't know yet":
 * every node writes a host figure, and a freshly restarted node claiming the
 * box was idle would drag the averaged host series down.
 */
export function createHostCpuSampler() {
  let previous: HostCpuTimes | null = null;

  return function sampleHostCpuPercent(): number | null {
    const current = readHostCpuTimes();
    if (!current) return null;
    const last = previous;
    previous = current;
    if (!last) return null;
    return hostCpuPercentFromDelta(
      current.totalJiffies - last.totalJiffies,
      current.idleJiffies - last.idleJiffies
    );
  };
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
  // Whole-machine figures. Every node reports them and they all describe the
  // same EC2 box, so the read model can reconstruct the host series from
  // whichever nodes happen to be alive.
  hostCpuPercent: number | null;
  hostCpuCores: number | null;
  hostMemUsedBytes: number | null;
  hostMemTotalBytes: number | null;
}

/**
 * One complete reading for this node plus its view of the host.
 *
 * `cpuPercent` and `hostCpuPercent` come from the caller's samplers (both need
 * the previous tick) and `s3Bytes` from the caller's cache (only the worker
 * scans the bucket, hourly).
 */
export function collectResourceSample(
  identity: NodeIdentity,
  cpuPercent: number,
  hostCpuPercent: number | null,
  s3Bytes: number | null
): ResourceSampleInput {
  const dataDir = resolveDataDir();
  const memory = readMemoryUsage();
  const disk = readDiskUsage(dataDir);
  const hostMemory = readHostMemory();
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
    hostCpuPercent,
    // os.cpus() reads the host's /proc/cpuinfo, so this is the machine's core
    // count even when a cgroup quota gives this container fewer.
    hostCpuCores: os.cpus().length || null,
    hostMemUsedBytes: hostMemory?.usedBytes ?? null,
    hostMemTotalBytes: hostMemory?.totalBytes ?? null,
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
  hostCpuPercent: number | null;
  hostCpuPeakPercent: number | null;
  hostCpuCores: number | null;
  hostMemUsedBytes: number | null;
  hostMemTotalBytes: number | null;
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
  hostCpuPercent?: number | null;
  hostCpuCores?: number | null;
  hostMemUsedBytes?: number | null;
  hostMemTotalBytes?: number | null;
}

function average(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Newest non-null reading of a field in a time-ordered bucket, else null. */
function latestDefined(
  ordered: BucketableSample[],
  pick: (sample: BucketableSample) => number | null | undefined
): number | null {
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const value = pick(ordered[i]);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

/** Non-null readings of a field across a bucket. */
function definedValues(
  ordered: BucketableSample[],
  pick: (sample: BucketableSample) => number | null | undefined
): number[] {
  const out: number[] = [];
  for (const sample of ordered) {
    const value = pick(sample);
    if (value !== null && value !== undefined) out.push(value);
  }
  return out;
}

/**
 * Aggregate raw samples into fixed-width time buckets, oldest first.
 *
 * Rates (CPU, memory) are averaged — and CPU additionally keeps the bucket's
 * peak, so a 30-minute bucket cannot hide a spike. Levels (storage, limits) use
 * the newest reading in the bucket rather than an average: "how full is the
 * disk" is a point-in-time fact, not something to smooth. s3Bytes is the newest
 * NON-NULL reading, because web nodes never scan the bucket and would otherwise
 * blank out an environment's line; the host fields are treated the same way,
 * since a node that has just restarted has no host CPU delta yet.
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
      const hostCpu = definedValues(ordered, (r) => r.hostCpuPercent);
      return {
        t,
        cpuPercent: Math.round(average(ordered.map((r) => r.cpuPercent)) * 100) / 100,
        cpuPeakPercent: Math.max(...ordered.map((r) => r.cpuPercent)),
        memUsedBytes: Math.round(average(ordered.map((r) => r.memUsedBytes))),
        memLimitBytes: latest.memLimitBytes,
        dbBytes: latest.dbBytes,
        diskTotalBytes: latest.diskTotalBytes,
        diskFreeBytes: latest.diskFreeBytes,
        s3Bytes: latestDefined(ordered, (r) => r.s3Bytes),
        hostCpuPercent: hostCpu.length ? Math.round(average(hostCpu) * 100) / 100 : null,
        hostCpuPeakPercent: hostCpu.length ? Math.max(...hostCpu) : null,
        hostCpuCores: latestDefined(ordered, (r) => r.hostCpuCores),
        hostMemUsedBytes: latestDefined(ordered, (r) => r.hostMemUsedBytes),
        hostMemTotalBytes: latestDefined(ordered, (r) => r.hostMemTotalBytes),
      };
    });
}
