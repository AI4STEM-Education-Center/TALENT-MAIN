"use client";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  OctagonAlert,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SystemLog {
  id: string;
  createdAt: string;
  category: string;
  type: string;
  severity: string;
  message: string;
  userId: string | null;
  ip: string | null;
  metadata: string | null;
}

interface LogsResponse {
  logs: SystemLog[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    errors24h: number;
    warnings24h: number;
    failedLogins24h: number;
    lastUsage: SystemLog | null;
  };
}

const CATEGORIES = [
  "AUTH",
  "API",
  "WORKER",
  "USAGE",
  "SYSTEM",
  "GUARDRAIL",
] as const;
const SEVERITIES = ["INFO", "WARNING", "ERROR"] as const;
const ALL = "ALL";

function severityBadge(severity: string) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        severity === "ERROR" && "bg-red-500/10 text-red-600 dark:text-red-400",
        severity === "WARNING" &&
          "bg-amber-500/10 text-amber-600 dark:text-amber-400",
        severity === "INFO" && "bg-muted text-muted-foreground",
      )}
    >
      {severity}
    </span>
  );
}

function prettyMetadata(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    return JSON.stringify(JSON.parse(metadata), null, 2);
  } catch {
    return metadata;
  }
}

function SummaryCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="border border-border rounded-lg bg-card p-4 flex items-start gap-3">
      <div className="size-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-bold leading-tight">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
        {detail && (
          <p className="text-xs text-muted-foreground/70 truncate">{detail}</p>
        )}
      </div>
    </div>
  );
}

export default function AdminLogsPage() {
  const [data, setData] = useState<LogsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [category, setCategory] = useState<string>(ALL);
  const [severity, setSeverity] = useState<string>(ALL);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState(""); // debounced copy of `search`
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page) });
      if (category !== ALL) params.set("category", category);
      if (severity !== ALL) params.set("severity", severity);
      if (query) params.set("q", query);
      const res = await fetch(`/api/admin/logs?${params}`);
      if (res.ok) setData(await res.json());
    } catch (err) {
      console.error("Failed to fetch system logs", err);
    } finally {
      setLoading(false);
    }
  }, [page, category, severity, query]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const logs = data?.logs ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 50;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const summary = data?.summary;
  const usageMeta = (() => {
    if (!summary?.lastUsage?.metadata) return null;
    try {
      return JSON.parse(summary.lastUsage.metadata) as {
        requests?: number;
        uniqueIps?: number;
      };
    } catch {
      return null;
    }
  })();

  return (
    <div className="p-8">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">System Logs</h1>
          <p className="text-muted-foreground mt-1">
            Persistent operation log: logins, errors, worker jobs, and traffic
            samples.
          </p>
        </div>
        <Button variant="outline" onClick={fetchLogs} disabled={loading}>
          <RefreshCw className={cn("size-4 mr-2", loading && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <SummaryCard
          icon={<OctagonAlert className="size-4 text-red-500" />}
          label="Errors (24h)"
          value={String(summary?.errors24h ?? "–")}
        />
        <SummaryCard
          icon={<AlertTriangle className="size-4 text-amber-500" />}
          label="Warnings (24h)"
          value={String(summary?.warnings24h ?? "–")}
        />
        <SummaryCard
          icon={<ShieldAlert className="size-4 text-purple-500" />}
          label="Failed logins (24h)"
          value={String(summary?.failedLogins24h ?? "–")}
        />
        <SummaryCard
          icon={<Activity className="size-4 text-blue-500" />}
          label="Latest traffic sample"
          value={
            usageMeta
              ? `${usageMeta.requests ?? 0} req / ${usageMeta.uniqueIps ?? 0} IPs`
              : "–"
          }
          detail={
            summary?.lastUsage
              ? // react-doctor-disable-next-line react-doctor/no-locale-format-in-render -- summary arrives from a client fetch, so this branch renders nothing during SSR and cannot mismatch
                new Date(summary.lastUsage.createdAt).toLocaleString()
              : "No samples yet"
          }
        />
      </div>

      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            placeholder="Search message, type, or IP…"
            className="pl-9"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <Select
          value={category}
          onValueChange={(v) => {
            setCategory(v);
            setPage(1);
          }}
        >
          <SelectTrigger
            className="w-full sm:w-44"
            aria-label="Filter by category"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All categories</SelectItem>
            {CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={severity}
          onValueChange={(v) => {
            setSeverity(v);
            setPage(1);
          }}
        >
          <SelectTrigger
            className="w-full sm:w-44"
            aria-label="Filter by severity"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All severities</SelectItem>
            {SEVERITIES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="border border-border rounded-lg bg-card overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs text-muted-foreground uppercase bg-muted/50 border-b border-border">
            <tr>
              <th className="px-4 py-3 font-medium whitespace-nowrap">Time</th>
              <th className="px-4 py-3 font-medium">Severity</th>
              <th className="px-4 py-3 font-medium">Category</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium w-full">Message</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap">IP</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && !data ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-6 py-8 text-center text-muted-foreground"
                >
                  Loading logs…
                </td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-6 py-8 text-center text-muted-foreground"
                >
                  {total === 0 && !query && category === ALL && severity === ALL
                    ? "No log entries yet. Events appear here as the system runs."
                    : "No log entries match the current filters."}
                </td>
              </tr>
            ) : (
              logs.map((log) => {
                const expanded = expandedId === log.id;
                const detail = prettyMetadata(log.metadata);
                return (
                  <LogRow
                    key={log.id}
                    log={log}
                    expanded={expanded}
                    detail={detail}
                    onToggle={() => setExpandedId(expanded ? null : log.id)}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between mt-4 text-sm text-muted-foreground">
        <span>
          {total > 0
            ? `Showing ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`
            : "0 entries"}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || loading}
          >
            <ChevronLeft className="size-4 mr-1" /> Previous
          </Button>
          <span>
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || loading}
          >
            Next <ChevronRight className="size-4 ml-1" />
          </Button>
        </div>
      </div>
    </div>
  );
}

function LogRow({
  log,
  expanded,
  detail,
  onToggle,
}: {
  log: SystemLog;
  expanded: boolean;
  detail: string | null;
  onToggle: () => void;
}) {
  const hasDetail = !!(detail || log.userId);
  const detailId = `log-detail-${log.id}`;
  return (
    <>
      {/* Clicking the row is a mouse-only shortcut. The real toggle is the button
          in the last cell, which carries the accessible name and the expanded
          state, so keyboard users are not routed through the <tr> — turning a
          table row into a pseudo-button would cost table semantics. */}
      {/* react-doctor-disable-next-line react-doctor/click-events-have-key-events -- keyboard parity is provided by the button in the final cell, not by this row */}
      <tr
        className={cn(
          "hover:bg-muted/50 transition-colors",
          hasDetail && "cursor-pointer",
        )}
        onClick={hasDetail ? onToggle : undefined}
      >
        <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">
          {/* react-doctor-disable-next-line react-doctor/no-locale-format-in-render -- logs arrive from a client fetch, so no rows render during SSR and cannot mismatch */}
          {new Date(log.createdAt).toLocaleString()}
        </td>
        <td className="px-4 py-3">{severityBadge(log.severity)}</td>
        <td className="px-4 py-3 text-muted-foreground">{log.category}</td>
        <td className="px-4 py-3 whitespace-nowrap font-mono text-xs">
          {log.type}
        </td>
        <td className="px-4 py-3 min-w-64">{log.message}</td>
        <td className="px-4 py-3 whitespace-nowrap font-mono text-xs text-muted-foreground">
          {log.ip ?? ""}
        </td>
        <td className="px-4 py-3 text-right">
          {hasDetail && (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={detailId}
              aria-label={expanded ? "Hide log detail" : "Show log detail"}
              // The row also toggles, so stop the click here from bubbling into
              // it and immediately toggling back.
              onClick={(event) => {
                event.stopPropagation();
                onToggle();
              }}
              className="inline-flex items-center justify-center rounded p-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <ChevronDown
                className={cn(
                  "size-4 text-muted-foreground transition-transform",
                  expanded && "rotate-180",
                )}
              />
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr id={detailId} className="bg-muted/30">
          <td colSpan={7} className="px-6 py-4">
            {log.userId && (
              <p className="text-xs mb-2">
                <span className="text-muted-foreground">User ID:</span>{" "}
                <span className="font-mono">{log.userId}</span>
              </p>
            )}
            {detail && (
              <pre className="text-xs font-mono bg-muted/50 border border-border rounded-md p-3 overflow-x-auto whitespace-pre-wrap">
                {detail}
              </pre>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
