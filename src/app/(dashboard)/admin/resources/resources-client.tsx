"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Cpu, Database, HardDrive, MemoryStick, RefreshCw, ServerCog, TriangleAlert } from "lucide-react";
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

interface ResourceResponse {
  range: RangeKey;
  generatedAt: number;
  bucketMs: number;
  sampleIntervalMs: number;
  staleAfterMs: number;
  retentionDays: number;
  localEnv: string;
  peer: { configured: boolean; ok: boolean; url: string | null; error: string | null };
  nodes: NodeSeries[];
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
  { nodeId: "prod-web", label: "Production node", env: "prod", colorVar: "--viz-series-1" },
  { nodeId: "prod-worker", label: "Production worker", env: "prod", colorVar: "--viz-series-2" },
  { nodeId: "dev-web", label: "Dev node", env: "dev", colorVar: "--viz-series-3" },
  { nodeId: "dev-worker", label: "Dev worker", env: "dev", colorVar: "--viz-series-4" },
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

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
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

// ─── Derived series ─────────────────────────────────────────────────────────

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
      if (point.s3Bytes !== null) existing.s3 = Math.max(existing.s3 ?? 0, point.s3Bytes);
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
  diskTotalBytes: number;
  diskFreeBytes: number;
}

/** Latest storage reading for an environment, or null if it never reported. */
function latestStorage(nodes: NodeSeries[]): EnvStorage | null {
  const points = nodes.flatMap((n) => n.points).sort((a, b) => a.t - b.t);
  const last = points[points.length - 1];
  if (!last) return null;
  return {
    dbBytes: last.dbBytes,
    s3Bytes: [...points].reverse().find((p) => p.s3Bytes !== null)?.s3Bytes ?? null,
    diskTotalBytes: last.diskTotalBytes,
    diskFreeBytes: last.diskFreeBytes,
  };
}

// ─── Cards ──────────────────────────────────────────────────────────────────

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
  const memPercent = last && last.memLimitBytes > 0 ? (last.memUsedBytes / last.memLimitBytes) * 100 : 0;

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
              : "bg-muted text-muted-foreground"
          )}
        >
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", online ? "bg-emerald-500" : "bg-muted-foreground")}
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
                peak {formatPercent(last.cpuPeakPercent)} · {formatCores(node?.cpuCores ?? 0)}
              </p>
            </div>
            <div>
              <dt className="text-[11px] text-muted-foreground">Memory</dt>
              <dd className="text-xl font-bold tabular-nums leading-tight">
                {formatPercent(memPercent)}
              </dd>
              <p className="text-[11px] text-muted-foreground">
                {formatBytes(last.memUsedBytes)} / {formatBytes(last.memLimitBytes)}
              </p>
            </div>
          </dl>
          <p className="mt-3 text-[11px] text-muted-foreground truncate">
            {node?.hostname} · updated {formatAge(now - (node?.lastSampleAt ?? now))}
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
  const diskUsed = storage ? storage.diskTotalBytes - storage.diskFreeBytes : 0;
  const diskPercent = storage && storage.diskTotalBytes > 0 ? (diskUsed / storage.diskTotalBytes) * 100 : 0;

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
          <p className="text-2xl font-bold tabular-nums leading-tight">{formatBytes(total)}</p>
          <p className="text-[11px] text-muted-foreground mb-3">
            {label.toLowerCase()} database + {label.toLowerCase()} S3 objects
          </p>
          <dl className="space-y-1.5 text-xs">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <Database className="size-3.5" /> Database volume
              </dt>
              <dd className="tabular-nums font-medium">{formatBytes(storage.dbBytes)}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <HardDrive className="size-3.5" /> S3 objects
              </dt>
              <dd className="tabular-nums font-medium">
                {storage.s3Bytes === null ? "Not scanned yet" : formatBytes(storage.s3Bytes)}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground flex items-center gap-1.5">
                <ServerCog className="size-3.5" /> Disk in use
              </dt>
              <dd className="tabular-nums font-medium">
                {formatBytes(diskUsed)} / {formatBytes(storage.diskTotalBytes)} ({formatPercent(diskPercent)})
              </dd>
            </div>
          </dl>
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
      const res = await fetch(`/api/admin/resources?range=${range}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      setData(await res.json());
      setError(null);
    } catch (err) {
      console.error("Failed to fetch resource metrics", err);
      setError(err instanceof Error ? err.message : "Failed to load resource metrics");
    } finally {
      setNow(Date.now());
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  const nodesById = useMemo(
    () => new Map((data?.nodes ?? []).map((node) => [node.nodeId, node])),
    [data]
  );

  const cpuSeries: ChartSeries[] = NODES.map((node) => ({
    id: node.nodeId,
    label: node.label,
    colorVar: node.colorVar,
    points: (nodesById.get(node.nodeId)?.points ?? []).map((p) => ({ t: p.t, v: p.cpuPercent })),
  }));

  const memorySeries: ChartSeries[] = NODES.map((node) => ({
    id: node.nodeId,
    label: node.label,
    colorVar: node.colorVar,
    points: (nodesById.get(node.nodeId)?.points ?? []).map((p) => ({ t: p.t, v: p.memUsedBytes })),
  }));

  const storageSeries: ChartSeries[] = ENVIRONMENTS.map((env) => ({
    id: env.env,
    label: `${env.label} storage`,
    colorVar: env.colorVar,
    points: buildStorageSeries((data?.nodes ?? []).filter((n) => n.appEnv === env.env)),
  }));

  const bucketMs = data?.bucketMs ?? 60_000;
  const peer = data?.peer;

  return (
    <div className="p-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-6 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">System Resources</h1>
          <p className="text-muted-foreground mt-1">
            CPU, memory, and storage for the production and dev nodes and their workers
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
                  : "text-muted-foreground hover:text-foreground"
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
      {peer && !peer.ok && (
        <div className="mb-6 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
          <TriangleAlert className="size-4 mt-0.5 shrink-0" />
          {peer.configured ? (
            <p>
              The {data?.localEnv === "prod" ? "dev" : "production"} deployment could not be reached
              ({peer.error ?? "unknown error"}), so only this deployment&apos;s nodes are shown.
            </p>
          ) : (
            <p>
              Only this deployment&apos;s nodes are shown. Set{" "}
              <code className="font-mono break-all">RESOURCE_MONITOR_PEER_URL</code> and{" "}
              <code className="font-mono break-all">RESOURCE_MONITOR_TOKEN</code> on both
              deployments to chart all four nodes together.
            </p>
          )}
        </div>
      )}

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
          description="Share of each node's available cores, averaged per bucket."
          series={cpuSeries}
          format={formatPercent}
          fixedMax={100}
          gapMs={bucketMs}
          stale={loading}
        />
        <ResourceChart
          title="Memory usage"
          description="Resident memory per node, excluding reclaimable page cache."
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
        Each environment is measured on its own: the dev figures cover the dev database volume and
        the <code className="font-mono text-xs">dev/</code> S3 prefix, production the production
        volume and <code className="font-mono text-xs">prod/</code>.
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
        {ENVIRONMENTS.map((env) => (
          <StorageCard
            key={env.env}
            label={env.label}
            colorVar={env.colorVar}
            storage={latestStorage((data?.nodes ?? []).filter((n) => n.appEnv === env.env))}
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
