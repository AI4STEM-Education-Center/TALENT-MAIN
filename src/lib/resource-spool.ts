import fs from "node:fs";
import path from "node:path";
import { resolveDataDir, type ResourceSampleInput } from "./resource-metrics";

// Shared on-host store for the admin resource monitor.
//
// WHY NOT THE DATABASE. Prod and dev are separate deployments with separate
// SQLite files, so a sample written by dev is invisible to prod and vice versa.
// The first version of this feature closed that gap with an authenticated
// HTTPS call between the two public sites (RESOURCE_MONITOR_PEER_URL +
// RESOURCE_MONITOR_TOKEN). That worked, but it only worked once both
// deployments were configured — and until they were, each site charted two of
// the four nodes and showed the other two as "No data".
//
// The pivot: both stacks are containers on ONE EC2 instance, and they already
// bind-mount sibling directories of ~/app/data. So instead of asking one
// deployment to phone the other, every node appends its samples to a directory
// bind-mounted into all four containers, and every deployment reads the whole
// directory. Both environments therefore appear on both sites with no shared
// secret, no public round trip, no host-header rules, and no configuration to
// forget — and a stopped deployment keeps contributing its history, because the
// files outlive its containers.
//
// FORMAT. One newline-delimited-JSON file per node, appended a line at a time
// and compacted hourly to the retention window. NDJSON rather than a database
// because there is exactly one writer per file and the reader only ever wants
// "everything since T": an O_APPEND write of a sub-4KiB line is atomic on
// Linux, so no locking is needed even while another container reads.

export const SPOOL_FILE_SUFFIX = ".ndjson";

/**
 * Directory the four nodes share.
 *
 * Set explicitly by both compose files. The fallback deliberately sits NEXT TO
 * the environment's data directory rather than inside it — inside, the spool's
 * own bytes would land in `dbBytes` and the storage chart would chart itself —
 * and it is per-environment, so an unmounted deployment degrades to charting
 * only its own two nodes instead of failing.
 */
export function resolveSpoolDir(): string {
  const configured = process.env.RESOURCE_SPOOL_DIR?.trim();
  if (configured) return configured;
  return path.join(path.dirname(resolveDataDir()), "resource-metrics");
}

/** True when the spool is a path both deployments were pointed at. */
export function isSharedSpool(): boolean {
  return !!process.env.RESOURCE_SPOOL_DIR?.trim();
}

// ─── Record shape ───────────────────────────────────────────────────────────
// Keys are abbreviated because they are repeated on all ~10k lines per node;
// spelled out, a week of samples for four nodes is several MiB of key names
// alone. `v` is a format version so a future reader can recognise (and skip)
// lines it does not understand rather than mis-parsing them.

const RECORD_VERSION = 1;

interface SpoolRecord {
  v: number;
  t: number;
  id: string;
  e: string;
  r: string;
  h: string;
  c: number;
  k: number;
  mu: number;
  ml: number;
  db: number;
  dt: number;
  df: number;
  s3: number | null;
  hc: number | null;
  hk: number | null;
  hmu: number | null;
  hmt: number | null;
}

export interface SpooledSample {
  nodeId: string;
  appEnv: string;
  role: string;
  hostname: string;
  createdAt: Date;
  cpuPercent: number;
  cpuCores: number;
  memUsedBytes: number;
  memLimitBytes: number;
  dbBytes: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  s3Bytes: number | null;
  hostCpuPercent: number | null;
  hostCpuCores: number | null;
  hostMemUsedBytes: number | null;
  hostMemTotalBytes: number | null;
}

export function encodeSample(sample: ResourceSampleInput, at: number): string {
  const record: SpoolRecord = {
    v: RECORD_VERSION,
    t: at,
    id: sample.nodeId,
    e: sample.appEnv,
    r: sample.role,
    h: sample.hostname,
    c: sample.cpuPercent,
    k: sample.cpuCores,
    mu: Math.round(sample.memUsedBytes),
    ml: Math.round(sample.memLimitBytes),
    db: Math.round(sample.dbBytes),
    dt: Math.round(sample.diskTotalBytes),
    df: Math.round(sample.diskFreeBytes),
    s3: sample.s3Bytes === null ? null : Math.round(sample.s3Bytes),
    hc: sample.hostCpuPercent,
    hk: sample.hostCpuCores,
    hmu:
      sample.hostMemUsedBytes === null
        ? null
        : Math.round(sample.hostMemUsedBytes),
    hmt:
      sample.hostMemTotalBytes === null
        ? null
        : Math.round(sample.hostMemTotalBytes),
  };
  return `${JSON.stringify(record)}\n`;
}

/**
 * Parse one spool line, or null if it is unusable.
 *
 * Tolerant by design: a line half-written when the box lost power, or written
 * by a future version, must cost that one sample and not the whole file.
 */
export function decodeSample(line: string): SpooledSample | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let record: Partial<SpoolRecord>;
  try {
    record = JSON.parse(trimmed) as Partial<SpoolRecord>;
  } catch {
    return null;
  }
  if (record.v !== RECORD_VERSION) return null;
  const { t, id } = record;
  if (
    typeof t !== "number" ||
    !Number.isFinite(t) ||
    typeof id !== "string" ||
    !id
  )
    return null;

  const num = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const nullable = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;

  return {
    nodeId: id,
    appEnv: typeof record.e === "string" ? record.e : "dev",
    role: typeof record.r === "string" ? record.r : "web",
    hostname: typeof record.h === "string" ? record.h : "",
    createdAt: new Date(t),
    cpuPercent: num(record.c),
    cpuCores: num(record.k),
    memUsedBytes: num(record.mu),
    memLimitBytes: num(record.ml),
    dbBytes: num(record.db),
    diskTotalBytes: num(record.dt),
    diskFreeBytes: num(record.df),
    s3Bytes: nullable(record.s3),
    hostCpuPercent: nullable(record.hc),
    hostCpuCores: nullable(record.hk),
    hostMemUsedBytes: nullable(record.hmu),
    hostMemTotalBytes: nullable(record.hmt),
  };
}

// ─── Writing ────────────────────────────────────────────────────────────────

/** Compact after this many appends — an hour at the default sample interval. */
const COMPACT_EVERY_APPENDS = 60;

function spoolFile(dir: string, nodeId: string): string {
  // nodeId is built from APP_ENV and a literal role in resolveNodeIdentity, but
  // it reaches the filesystem, so refuse anything that is not the shape we
  // build rather than trusting that it always will be.
  if (!/^[a-z0-9-]+$/i.test(nodeId))
    throw new Error(`Unsafe node id: ${nodeId}`);
  return path.join(dir, `${nodeId}${SPOOL_FILE_SUFFIX}`);
}

/**
 * Append-and-compact writer for one node's file.
 *
 * Compaction rewrites the file to the retention window through a temp file and
 * a rename, so a reader in another container sees either the old file or the
 * new one and never a truncated one. It runs on the first tick too, which is
 * what bounds the file after a restart that skipped the usual hourly pass.
 */
export function createSpoolWriter(nodeId: string, retentionMs: number) {
  const dir = resolveSpoolDir();
  const file = spoolFile(dir, nodeId);
  let appendsSinceCompact = COMPACT_EVERY_APPENDS;

  return {
    file,
    write(sample: ResourceSampleInput, at: number = Date.now()): void {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, encodeSample(sample, at));
      appendsSinceCompact += 1;
      if (appendsSinceCompact >= COMPACT_EVERY_APPENDS) {
        appendsSinceCompact = 0;
        compactSpoolFile(file, at - retentionMs);
      }
    },
  };
}

/** Drop lines older than `cutoffMs` from one node's file. */
export function compactSpoolFile(file: string, cutoffMs: number): number {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return 0;
  }
  const lines = raw.split("\n");
  const kept: string[] = [];
  let dropped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const sample = decodeSample(line);
    if (sample && sample.createdAt.getTime() >= cutoffMs) kept.push(line);
    else dropped += 1;
  }
  if (dropped === 0) return 0;

  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, kept.length ? `${kept.join("\n")}\n` : "");
  fs.renameSync(tmp, file);
  return dropped;
}

// ─── Reading ────────────────────────────────────────────────────────────────

export interface SpoolReadResult {
  samples: SpooledSample[];
  /** Node files found, whether or not they had samples in the window. */
  files: string[];
  error: string | null;
}

/**
 * Every node's samples at or after `sinceMs`, oldest first.
 *
 * The whole file is read and filtered rather than seeking to an offset: a
 * node's week of samples is a couple of MiB, the callers memoize the result for
 * at least a sample interval, and "read it all, drop what is old" has no
 * partial-line edge cases to get wrong. A file that cannot be read is skipped —
 * one unreadable node must not blank out the other three.
 */
export function readSpool(sinceMs: number): SpoolReadResult {
  const dir = resolveSpoolDir();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch (err: unknown) {
    // Nothing has sampled yet (or the mount is missing): an empty report, not
    // a failure — the page still renders and says so.
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      samples: [],
      files: [],
      error:
        code === "ENOENT"
          ? null
          : err instanceof Error
            ? err.message
            : String(err),
    };
  }

  const samples: SpooledSample[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(SPOOL_FILE_SUFFIX)) continue;
    files.push(entry);
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, entry), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      const sample = decodeSample(line);
      if (sample && sample.createdAt.getTime() >= sinceMs) samples.push(sample);
    }
  }

  samples.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return { samples, files: files.sort(), error: null };
}
