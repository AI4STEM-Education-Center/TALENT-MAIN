"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Cpu,
  Database,
  HardDrive,
  MemoryStick,
  RefreshCw,
  Server,
  ServerCog,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ResourceChart, type ChartSeries } from "./resource-chart";

// ─── API shapes (mirrors /api/admin/resources) ──────────────────────────────

interface ResourcePoint {
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

interface NodeSeries {
  nodeId: string;
  appEnv: string;
  role: string;
  hostname: string;
  cpuCores: number;
  lastSampleAt: number;
  points: ResourcePoint[];
}

interface HostPoint {
  t: number;
  cpuPercent: number | null;
  cpuPeakPercent: number | null;
  memUsedBytes: number | null;
  memTotalBytes: number | null;
  diskTotalBytes: number;
  diskFreeBytes: number;
}

interface HostSeries {
  cpuCores: number | null;
  memTotalBytes: number | null;
  diskTotalBytes: number;
  diskFreeBytes: number;
  lastSampleAt: number;
  points: HostPoint[];
}

interface ResourceResponse {
  range: RangeKey;
  generatedAt: number;
  bucketMs: number;
  sampleIntervalMs: number;
  staleAfterMs: number;
  retentionDays: number;
  localEnv: string;
  nodes: NodeSeries[];
  host: HostSeries | null;
  spool: {
    dir: string;
    shared: boolean;
    files: string[];
    error: string | null;
  };
}

type RangeKey = "1h" | "24h" | "7d";

const RANGES: { key: RangeKey; label: string }[] = [
  { key: "1h", label: "Last hour" },
  { key: "24h", label: "Last 24 hours" },
  { key: "7d", label: "Last 7 days" },
];

// Fixed slot per node — a node keeps its hue no matter which others reported
// in, so "the blue line" always means the same box (see .viz-root in
// globals.css for the palette and why the two modes are separate sets).
const NODES = [
  {
    nodeId: "prod-web",
    label: "Production node",
    env: "prod",
    colorVar: "--viz-series-1",
  },
  {
    nodeId: "prod-worker",
    label: "Production worker",
    env: "prod",
    colorVar: "--viz-series-2",
  },
  {
    nodeId: "dev-web",
    label: "Dev node",
    env: "dev",
    colorVar: "--viz-series-3",
  },
  {
    nodeId: "dev-worker",
    label: "Dev worker",
    env: "dev",
    colorVar: "--viz-series-4",
  },
] as const;

// Storage is a property of the environment, not of a node: prod and dev mount
// different database volumes and own different S3 key prefixes, while the two
// nodes inside one environment share both. Each environment therefore inherits
// the hue of its web node.
const ENVIRONMENTS = [
  { env: "prod", label: "Production", colorVar: "--viz-series-1" },
  { env: "dev", label: "Dev", colorVar: "--viz-series-3" },
] as const;

const REFRESH_MS = 30_000;

/** Above this the disk is worth flagging, well before writes start failing. */
const DISK_WARN_PERCENT = 80;

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatCores(cores: number): string {
  return `${Number.isInteger(cores) ? cores : cores.toFixed(1)} core${cores === 1 ? "" : "s"}`;
}

function formatAge(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function percentOf(part: number, whole: number): number {
  return whole > 0 ? (part / whole) * 100 : 0;
}

// ─── Derived series ─────────────────────────────────────────────────────────

/**
 * The four containers added together, per bucket.
 *
 * CPU is re-based before summing: each node's percentage is a share of ITS OWN
 * allowance, so two nodes at 50% of one core each are 50% of a two-core box,
 * not 100%. Multiplying back out by the node's cores and dividing by the
 * machine's makes the total directly comparable to the host line above it.
 */
function buildContainerTotals(
  nodes: NodeSeries[],
  hostCores: number | null,
): { t: number; cpuPercent: number; memUsedBytes: number }[] {
  const merged = new Map<
    number,
    { cpuPercent: number; memUsedBytes: number }
  >();
  for (const node of nodes) {
    const share = hostCores && hostCores > 0 ? node.cpuCores / hostCores : 1;
    for (const point of node.points) {
      const existing = merged.get(point.t) ?? {
        cpuPercent: 0,
        memUsedBytes: 0,
      };
      existing.cpuPercent += point.cpuPercent * share;
      existing.memUsedBytes += point.memUsedBytes;
      merged.set(point.t, existing);
    }
  }
  return [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, value]) => ({
      t,
      cpuPercent: Math.min(100, Math.round(value.cpuPercent * 100) / 100),
      memUsedBytes: value.memUsedBytes,
    }));
}

/**
 * One environment's storage over time: the SQLite data directory plus the
 * objects under that environment's S3 prefix.
 *
 * Both of an environment's nodes see the same volume, but only the worker
 * scans the bucket (hourly), so s3Bytes arrives on some samples and not
 * others. The last known bucket size is carried forward rather than treated as
 * zero — otherwise the line would saw up and down between the two node's rows.
 */
function buildStorageSeries(nodes: NodeSeries[]): { t: number; v: number }[] {
  const merged = new Map<number, { db: number; s3: number | null }>();
  for (const node of nodes) {
    for (const point of node.points) {
      const existing = merged.get(point.t) ?? { db: 0, s3: null };
      existing.db = Math.max(existing.db, point.dbBytes);
      if (point.s3Bytes !== null)
        existing.s3 = Math.max(existing.s3 ?? 0, point.s3Bytes);
      merged.set(point.t, existing);
    }
  }
  let carriedS3: number | null = null;
  return [...merged.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, value]) => {
      if (value.s3 !== null) carriedS3 = value.s3;
      return { t, v: value.db + (carriedS3 ?? 0) };
    });
}

interface EnvStorage {
  dbBytes: number;
  s3Bytes: number | null;
}

/** Latest storage reading for an environment, or null if it never reported. */
function latestStorage(nodes: NodeSeries[]): EnvStorage | null {
  const points = nodes.flatMap((n) => n.points).sort((a, b) => a.t - b.t);
  const last = points[points.length - 1];
  if (!last) return null;
  return {
    dbBytes: last.dbBytes,
    s3Bytes:
      [...points].reverse().find((p) => p.s3Bytes !== null)?.s3Bytes ?? null,
  };
}

// ─── Pieces ─────────────────────────────────────────────────────────────────

/**
 * Usage bar showing two nested quantities: how much of the whole is in use, and
 * how much of that use is ours. Rendered as one track so the eye compares the
 * two against the same baseline instead of across two bars.
 */
function StackedMeter({
  usedPercent,
  minePercent,
  warn = false,
  label,
}: {
  usedPercent: number;
  minePercent: number;
  warn?: boolean;
  label: string;
}) {
  const used = Math.max(0, Math.min(100, usedPercent));
  const mine = Math.max(0, Math.min(used, minePercent));
  return (
    <div
      role="img"
      aria-label={label}
      className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted flex"
    >
      <div
        className={cn("h-full", warn ? "bg-amber-500" : "bg-primary")}
        style={{ width: `${mine}%` }}
      />
      <div
        className={cn("h-full", warn ? "bg-amber-500/35" : "bg-primary/30")}
        style={{ width: `${used - mine}%` }}
      />
    </div>
  );
}

function TotalMetric({
  icon: Icon,
  label,
  value,
  caption,
  meter,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  caption: string;
  meter: React.ReactNode;
}) {
  return (
    <div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </p>
      <p className="mt-1 text-3xl font-bold tabular-nums leading-none">
        {value}
      </p>
      {meter}
      <p className="mt-1.5 text-[11px] text-muted-foreground">{caption}</p>
    </div>
  );
}

/**
 * The machine, above the containers that run on it.
 *
 * This panel exists because the per-node cards cannot answer "is the box in
 * trouble?". Prod and dev are four containers on one EC2 instance, and the
 * things most likely to fill its disk or its RAM — Docker images, container
 * logs, the OS — are not any of them. Each metric therefore shows the machine
 * first and our share of it second.
 */
function SystemTotalPanel({
  host,
  containerCpuPercent,
  containerMemBytes,
  appDiskBytes,
  staleAfterMs,
  now,
}: {
  host: HostSeries | null;
  containerCpuPercent: number | null;
  containerMemBytes: number | null;
  appDiskBytes: number;
  staleAfterMs: number;
  now: number;
}) {
  const last = host?.points[host.points.length - 1];
  const online = host ? now - host.lastSampleAt < staleAfterMs : false;

  if (!host || !last) {
    return (
      <section className="viz-root border border-border rounded-lg bg-card p-5 mb-6">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <Server className="size-4 text-muted-foreground" />
          Whole machine
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          No host samples in the selected range. Every node reports the
          machine&apos;s own CPU, memory and disk alongside its container
          figures, so this fills in as soon as any one of them has reported
          twice.
        </p>
      </section>
    );
  }

  // CPU and memory come from the newest bucket that actually HAS them, which is
  // not always the newest bucket: a node with no host CPU delta yet (just
  // restarted) or one on a platform without /proc contributes a bucket with
  // null rates, and reading `last` blindly would blank a panel that has a
  // perfectly good reading a minute earlier. Disk is a level every sample
  // carries, so it does come from `last`.
  const reversed = [...host.points].reverse();
  const lastCpu = reversed.find((p) => p.cpuPercent !== null) ?? null;
  const lastMem = reversed.find((p) => p.memUsedBytes !== null) ?? null;

  const memTotal = lastMem?.memTotalBytes ?? host.memTotalBytes ?? 0;
  const memUsed = lastMem?.memUsedBytes ?? 0;
  const cpuPercent = lastCpu?.cpuPercent ?? null;

  // The two sides of each comparison are measured differently — the machine
  // from /proc (memory the kernel could not hand out), a container from its
  // cgroup (resident pages minus reclaimable cache) — so the parts can round
  // to slightly more than the whole. Capping keeps the caption from claiming
  // the containers used more than the machine did, which is never true.
  const containerCpu =
    containerCpuPercent === null
      ? null
      : Math.min(containerCpuPercent, cpuPercent ?? 100);
  const containerMem =
    containerMemBytes === null ? null : Math.min(containerMemBytes, memUsed);

  const diskUsed = Math.max(0, last.diskTotalBytes - last.diskFreeBytes);
  const diskPercent = percentOf(diskUsed, last.diskTotalBytes);
  const diskWarn = diskPercent >= DISK_WARN_PERCENT;

  return (
    <section
      className={cn(
        "viz-root border rounded-lg bg-card p-5 mb-6",
        diskWarn ? "border-amber-500/40" : "border-border",
      )}
    >
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 mb-4">
        <h2 className="text-base font-semibold flex items-center gap-2">
          <Server className="size-4 text-muted-foreground" />
          Whole machine
        </h2>
        <p className="text-xs text-muted-foreground">
          The EC2 instance both deployments share
          {host.cpuCores ? ` · ${formatCores(host.cpuCores)}` : ""}
          {memTotal ? ` · ${formatBytes(memTotal)} RAM` : ""}
          {last.diskTotalBytes
            ? ` · ${formatBytes(last.diskTotalBytes)} disk`
            : ""}
        </p>
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium",
            online
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              online ? "bg-emerald-500" : "bg-muted-foreground",
            )}
          />
          {online ? "Live" : `Last seen ${formatAge(now - host.lastSampleAt)}`}
        </span>
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
        <TotalMetric
          icon={Cpu}
          label="CPU"
          value={cpuPercent === null ? "—" : formatPercent(cpuPercent)}
          caption={
            containerCpu === null
              ? "our containers: not reported"
              : `our containers ${formatPercent(containerCpu)} of the machine`
          }
          meter={
            <StackedMeter
              usedPercent={cpuPercent ?? 0}
              minePercent={containerCpu ?? 0}
              label={`Machine CPU ${formatPercent(cpuPercent ?? 0)} used`}
            />
          }
        />
        <TotalMetric
          icon={MemoryStick}
          label="Memory"
          value={memTotal ? formatPercent(percentOf(memUsed, memTotal)) : "—"}
          caption={`${formatBytes(memUsed)} of ${formatBytes(memTotal)}${
            containerMem === null
              ? ""
              : ` · our containers ${formatBytes(containerMem)}`
          }`}
          meter={
            <StackedMeter
              usedPercent={percentOf(memUsed, memTotal)}
              minePercent={percentOf(containerMem ?? 0, memTotal)}
              label={`Machine memory ${formatBytes(memUsed)} of ${formatBytes(memTotal)} used`}
            />
          }
        />
        <TotalMetric
          icon={HardDrive}
          label="Disk"
          value={formatPercent(diskPercent)}
          caption={`${formatBytes(diskUsed)} of ${formatBytes(
            last.diskTotalBytes,
          )} · our databases ${formatBytes(appDiskBytes)}`}
          meter={
            <StackedMeter
              usedPercent={diskPercent}
              minePercent={percentOf(appDiskBytes, last.diskTotalBytes)}
              warn={diskWarn}
              label={`Machine disk ${formatBytes(diskUsed)} of ${formatBytes(
                last.diskTotalBytes,
              )} used`}
            />
          }
        />
      </div>

      <p className="mt-4 text-[11px] text-muted-foreground">
        The solid part of each bar is this application; the pale part is
        everything else on the box.
      </p>
    </section>
  );
}

function NodeCard({
  label,
  colorVar,
  node,
  staleAfterMs,
  now,
}: {
  label: string;
  colorVar: string;
  node: NodeSeries | undefined;
  staleAfterMs: number;
  now: number;
}) {
  const last = node?.points[node.points.length - 1];
  const online = node ? now - node.lastSampleAt < staleAfterMs : false;
  const memPercent =
    last && last.memLimitBytes > 0
      ? (last.memUsedBytes / last.memLimitBytes) * 100
      : 0;

  return (
    <div className="viz-root border border-border rounded-lg bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <span
          aria-hidden
          className="h-0.5 w-4 rounded-full shrink-0"
          style={{ backgroundColor: `var(${colorVar})` }}
        />
        <p className="text-sm font-medium truncate">{label}</p>
        <span
          className={cn(
            "ml-auto inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium",
            online
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full",
              online ? "bg-emerald-500" : "bg-muted-foreground",
            )}
          />
          {node ? (online ? "Online" : "Stale") : "No data"}
        </span>
      </div>

      {last ? (
        <>
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-[11px] text-muted-foreground">CPU</dt>
              <dd className="text-xl font-bold tabular-nums leading-tight">
                {formatPercent(last.cpuPercent)}
              </dd>
              <p className="text-[11px] text-muted-foreground">
                peak {formatPercent(last.cpuPeakPercent)} ·{" "}
                {formatCores(node?.cpuCores ?? 0)}
              </p>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Memory</dt>
              <dd className="text-xl font-bold tabular-nums leading-tight">
                {formatPercent(memPercent)}
              </dd>
              <p className="text-[11px] text-muted-foreground">
                {formatBytes(last.memUsedBytes)} /{" "}
                {formatBytes(last.memLimitBytes)}
              </p>
            </div>
          </dl>
          <p className="mt-3 text-[11px] text-muted-foreground truncate">
            {node?.hostname} · updated{" "}
            {formatAge(now - (node?.lastSampleAt ?? now))}
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          This node has not reported in the selected range.
        </p>
      )}
    </div>
  );
}

/**
 * Where the disk actually went.
 *
 * The two database volumes are the only part of the root volume this app can
 * measure: the containers run unprivileged and cannot read /var/lib/docker, so
 * images, layers and container logs are visible only as the gap between "used"
 * and what we can account for. Naming that gap — rather than leaving the reader
 * to assume the app filled the disk — is the point of this card.
 */
function DiskBreakdownCard({
  host,
  envBytes,
}: {
  host: HostSeries | null;
  envBytes: { env: string; label: string; colorVar: string; bytes: number }[];
}) {
  const last = host?.points[host.points.length - 1];
  if (!last || last.diskTotalBytes <= 0) {
    return (
      <div className="border border-border rounded-lg bg-card p-4">
        <p className="text-sm font-medium mb-1">Disk breakdown</p>
        <p className="text-xs text-muted-foreground">
          No disk samples in the selected range.
        </p>
      </div>
    );
  }

  const total = last.diskTotalBytes;
  const used = Math.max(0, total - last.diskFreeBytes);
  const accounted = envBytes.reduce((sum, e) => sum + e.bytes, 0);
  const other = Math.max(0, used - accounted);
  const usedPercent = percentOf(used, total);

  const segments = [
    ...envBytes.map((e) => ({
      key: e.env,
      label: `${e.label} database volume`,
      bytes: e.bytes,
      color: `var(${e.colorVar})`,
    })),
    {
      key: "other",
      label: "Operating system, Docker images and logs",
      bytes: other,
      color: "var(--viz-total)",
    },
    {
      key: "free",
      label: "Free",
      bytes: Math.max(0, total - used),
      color: "hsl(var(--muted))",
    },
  ];

  return (
    <div
      className={cn(
        "viz-root border rounded-lg bg-card p-4",
        usedPercent >= DISK_WARN_PERCENT
          ? "border-amber-500/40"
          : "border-border",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
        <p className="text-sm font-medium">Disk breakdown</p>
        <p className="text-xs tabular-nums text-muted-foreground">
          {formatBytes(used)} of {formatBytes(total)} used (
          {formatPercent(usedPercent)})
        </p>
      </div>

      <div
        role="img"
        aria-label={`Disk: ${segments
          .map((s) => `${s.label} ${formatBytes(s.bytes)}`)
          .join(", ")}`}
        className="mt-3 flex h-3 w-full overflow-hidden rounded-full bg-muted"
      >
        {segments.map((segment) => (
          <div
            key={segment.key}
            className="h-full"
            style={{
              width: `${percentOf(segment.bytes, total)}%`,
              backgroundColor: segment.color,
            }}
          />
        ))}
      </div>

      <dl className="mt-3 space-y-1.5 text-xs">
        {segments.map((segment) => (
          <div
            key={segment.key}
            className="flex items-center justify-between gap-2"
          >
            <dt className="flex items-center gap-2 text-muted-foreground min-w-0">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: segment.color }}
              />
              <span className="truncate">{segment.label}</span>
            </dt>
            <dd className="tabular-nums font-medium shrink-0">
              {formatBytes(segment.bytes)}
            </dd>
          </div>
        ))}
      </dl>

      {other > accounted * 4 && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Most of this disk is not application data. The containers cannot see
          inside
          <code className="font-mono mx-1">/var/lib/docker</code>, so breaking
          the grey band down means an SSH session: start with{" "}
          <code className="font-mono">docker system df</code> and{" "}
          <code className="font-mono">sudo du -h --max-depth=1 -x /</code>. The
          README&apos;s &ldquo;Disk on the instance&rdquo; section has the full
          list.
        </p>
      )}
    </div>
  );
}

function StorageCard({
  label,
  colorVar,
  storage,
  isLocal,
}: {
  label: string;
  colorVar: string;
  storage: EnvStorage | null;
  isLocal: boolean;
}) {
  const total = storage ? storage.dbBytes + (storage.s3Bytes ?? 0) : 0;

  return (
    <div className="viz-root border border-border rounded-lg bg-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <span
          aria-hidden
          className="h-0.5 w-4 rounded-full shrink-0"
          style={{ backgroundColor: `var(${colorVar})` }}
        />
        <p className="text-sm font-medium">{label} storage</p>
        {isLocal && (
          <span className="ml-auto rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            This deployment
          </span>
        )}
      </div>

      {storage ? (
        <>
          <p className="text-2xl font-bold tabular-nums leading-tight">
            {formatBytes(total)}
          </p>
          <p className="text-[11px] text-muted-foreground mb-3">
            {label.toLowerCase()} database + {label.toLowerCase()} S3 objects
          </p>
          <dl className="space-y-1.5 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <Database className="size-3.5" /> Database volume
              </dt>
              <dd className="tabular-nums font-medium">
                {formatBytes(storage.dbBytes)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <ServerCog className="size-3.5" /> S3 objects
              </dt>
              <dd className="tabular-nums font-medium">
                {storage.s3Bytes === null
                  ? "Not scanned yet"
                  : formatBytes(storage.s3Bytes)}
              </dd>
            </div>
          </dl>
          <p className="mt-3 text-[11px] text-muted-foreground">
            Only the database volume sits on the instance&apos;s disk; the S3
            objects do not.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          No storage samples for this environment in the selected range.
        </p>
      )}
    </div>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export function ResourcesClient() {
  const [range, setRange] = useState<RangeKey>("24h");
  const [data, setData] = useState<ResourceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Rendered "x ago" labels would otherwise freeze between fetches.
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/resources?range=${range}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setData(await res.json());
      setError(null);
    } catch (err) {
      console.error("Failed to fetch resource metrics", err);
      setError(
        err instanceof Error ? err.message : "Failed to load resource metrics",
      );
    } finally {
      setNow(Date.now());
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- the reset is already inside this function's finally block; detector misfire
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const host = data?.host ?? null;

  const nodesById = useMemo(
    () => new Map(nodes.map((node) => [node.nodeId, node])),
    [nodes],
  );

  const containerTotals = useMemo(
    () => buildContainerTotals(nodes, host?.cpuCores ?? null),
    [nodes, host],
  );
  const latestTotals = containerTotals[containerTotals.length - 1];

  // Only the database volumes live on the instance's disk. S3 is deliberately
  // excluded here even though the storage cards below add it in: mixing the two
  // is what made the old "disk in use" row read as if the bucket were filling
  // the EC2 volume.
  const envDiskBytes = ENVIRONMENTS.map((env) => ({
    env: env.env,
    label: env.label,
    colorVar: env.colorVar,
    bytes:
      latestStorage(nodes.filter((n) => n.appEnv === env.env))?.dbBytes ?? 0,
  }));
  const appDiskBytes = envDiskBytes.reduce((sum, e) => sum + e.bytes, 0);

  const hostCpuPoints = (host?.points ?? []).filter(
    (p) => p.cpuPercent !== null,
  );
  const hostMemPoints = (host?.points ?? []).filter(
    (p) => p.memUsedBytes !== null,
  );

  const cpuSeries: ChartSeries[] = [
    {
      id: "machine",
      label: "Whole machine",
      colorVar: "--viz-total",
      dashed: true,
      points: hostCpuPoints.map((p) => ({ t: p.t, v: p.cpuPercent as number })),
    },
    ...NODES.map((node) => ({
      id: node.nodeId,
      label: node.label,
      colorVar: node.colorVar,
      points: (nodesById.get(node.nodeId)?.points ?? []).map((p) => ({
        t: p.t,
        v: p.cpuPercent,
      })),
    })),
  ];

  const memorySeries: ChartSeries[] = [
    {
      id: "machine",
      label: "Whole machine",
      colorVar: "--viz-total",
      dashed: true,
      points: hostMemPoints.map((p) => ({
        t: p.t,
        v: p.memUsedBytes as number,
      })),
    },
    ...NODES.map((node) => ({
      id: node.nodeId,
      label: node.label,
      colorVar: node.colorVar,
      points: (nodesById.get(node.nodeId)?.points ?? []).map((p) => ({
        t: p.t,
        v: p.memUsedBytes,
      })),
    })),
  ];

  const storageSeries: ChartSeries[] = ENVIRONMENTS.map((env) => ({
    id: env.env,
    label: `${env.label} storage`,
    colorVar: env.colorVar,
    points: buildStorageSeries(nodes.filter((n) => n.appEnv === env.env)),
  }));

  const bucketMs = data?.bucketMs ?? 60_000;
  const spool = data?.spool;
  const reportingEnvs = new Set(nodes.map((n) => n.appEnv));
  const missingEnv =
    data && !reportingEnvs.has(data.localEnv === "prod" ? "dev" : "prod");

  return (
    <div className="p-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            System Resources
          </h1>
          <p className="text-muted-foreground mt-1">
            The EC2 instance as a whole, then the production and dev nodes and
            their workers
            {data ? `, kept for ${data.retentionDays} days` : ""}.
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          <RefreshCw className={cn("size-4 mr-2", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Filters: one row, scoping everything below. */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <div className="inline-flex rounded-lg border border-border p-0.5">
          {RANGES.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setRange(option.key)}
              aria-pressed={range === option.key}
              className={cn(
                "px-3 py-1.5 text-sm rounded-md transition-colors",
                range === option.key
                  ? "bg-primary text-primary-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
        {data && (
          <p className="text-xs text-muted-foreground">
            Sampled every {Math.round(data.sampleIntervalMs / 1000)}s · updated{" "}
            {new Date(data.generatedAt).toLocaleTimeString()}
          </p>
        )}
      </div>

      {error && (
        <div className="mb-6 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <TriangleAlert className="size-4 mt-0.5 shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {/* The prose lives in its own <p>: making the banner itself the flex
          container would turn every text run and <code> into a flex item, which
          lays them out with gaps instead of wrapping them as a sentence. */}
      {spool?.error && (
        <div className="mb-6 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
          <TriangleAlert className="size-4 mt-0.5 shrink-0" />
          <p>
            The metrics spool at{" "}
            <code className="font-mono break-all">{spool.dir}</code> could not
            be read ({spool.error}).
          </p>
        </div>
      )}

      {spool && !spool.error && !spool.shared && (
        <div className="mb-6 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
          <TriangleAlert className="size-4 mt-0.5 shrink-0" />
          <p>
            <code className="font-mono break-all">RESOURCE_SPOOL_DIR</code> is
            not set, so this deployment is writing to its own private spool and
            can only chart its own two nodes. Both compose stacks set it to{" "}
            <code className="font-mono">/app/metrics</code> and attach the
            shared{" "}
            <code className="font-mono break-all">talent-resource-metrics</code>{" "}
            volume — redeploy to pick that up.
          </p>
        </div>
      )}

      {spool?.shared && missingEnv && !spool.error && (
        <div className="mb-6 flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          <TriangleAlert className="size-4 mt-0.5 shrink-0" />
          <p>
            The {data?.localEnv === "prod" ? "dev" : "production"} stack has not
            written to the shared spool in this range — either it is down, or it
            has not been redeployed since the shared volume was introduced.
          </p>
        </div>
      )}

      <SystemTotalPanel
        host={host}
        containerCpuPercent={latestTotals?.cpuPercent ?? null}
        containerMemBytes={latestTotals?.memUsedBytes ?? null}
        appDiskBytes={appDiskBytes}
        staleAfterMs={data?.staleAfterMs ?? 180_000}
        now={now}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
        {NODES.map((node) => (
          <NodeCard
            key={node.nodeId}
            label={node.label}
            colorVar={node.colorVar}
            node={nodesById.get(node.nodeId)}
            staleAfterMs={data?.staleAfterMs ?? 180_000}
            now={now}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 2xl:grid-cols-2 gap-4 mb-6">
        <ResourceChart
          title="CPU usage"
          description="Each node against its own cores, dashed against the whole machine."
          series={cpuSeries}
          format={formatPercent}
          fixedMax={100}
          gapMs={bucketMs}
          stale={loading}
        />
        <ResourceChart
          title="Memory usage"
          description="Resident memory per node, dashed against the whole machine."
          series={memorySeries}
          format={formatBytes}
          axisBase={1024}
          gapMs={bucketMs}
          stale={loading}
        />
      </div>

      <h2 className="text-xl font-semibold tracking-tight mb-1 flex items-center gap-2">
        <HardDrive className="size-5 text-muted-foreground" />
        Storage
      </h2>
      <p className="text-sm text-muted-foreground mb-4">
        Each environment is measured on its own: the dev figures cover the dev
        database volume and the <code className="font-mono text-xs">dev/</code>{" "}
        S3 prefix, production the production volume and{" "}
        <code className="font-mono text-xs">prod/</code>. The breakdown below is
        the instance&apos;s disk, which holds the database volumes but not the
        S3 objects.
      </p>

      <div className="mb-4">
        <DiskBreakdownCard host={host} envBytes={envDiskBytes} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {ENVIRONMENTS.map((env) => (
          <StorageCard
            key={env.env}
            label={env.label}
            colorVar={env.colorVar}
            storage={latestStorage(nodes.filter((n) => n.appEnv === env.env))}
            isLocal={data?.localEnv === env.env}
          />
        ))}
      </div>

      <ResourceChart
        title="Storage used"
        description="Database volume plus S3 objects, per environment."
        series={storageSeries}
        format={formatBytes}
        axisBase={1024}
        gapMs={bucketMs}
        stale={loading}
      />
    </div>
  );
}
