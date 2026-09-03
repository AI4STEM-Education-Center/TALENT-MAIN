"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle2, Clock3, Gauge, RefreshCw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "./format";
import { IngestionTokens } from "./ingestion-tokens";
import { PressureTrendChart } from "./pressure-trend-chart";

interface PressureResult {
  id: string;
  runId: string;
  createdAt: string;
  environment: string;
  suite: string;
  scenario: string;
  status: string;
  source: string;
  commitSha: string | null;
  branch: string | null;
  durationMs: number;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  requestRate: number | null;
  virtualUsers: number | null;
  errorRate: number | null;
  failures: Array<{ name?: string; detail?: string; count?: number }>;
}

interface ResponseBody {
  results: PressureResult[];
  total: number;
  page: number;
  pageSize: number;
  facets: { suites: string[]; scenarios: string[]; environments: string[] };
}

function formatDuration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatLatency(ms: number | null) {
  if (ms === null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
}

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 rounded-md border border-input bg-background px-3 text-sm"
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function SummaryCards({
  total,
  displayed,
  passRate,
  latest,
}: {
  total: number;
  displayed: number;
  passRate: number;
  latest: PressureResult | null;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm">Matching runs</CardTitle>
          <Activity className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{total}</div>
          <p className="text-xs text-muted-foreground">{displayed} on this page</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm">Page pass rate</CardTitle>
          <CheckCircle2 className="size-4 text-emerald-500" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{passRate}%</div>
          <p className="text-xs text-muted-foreground">For the current filtered page</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm">Latest p95</CardTitle>
          <Gauge className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{formatLatency(latest?.p95Ms ?? null)}</div>
          <p className="text-xs text-muted-foreground">{latest?.scenario ?? "No run yet"}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm">Latest result</CardTitle>
          {latest?.status === "FAIL"
            ? <XCircle className="size-4 text-red-500" />
            : <Clock3 className="size-4 text-muted-foreground" />}
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{latest?.status ?? "—"}</div>
          <p className="text-xs text-muted-foreground">
            {latest ? formatDateTime(latest.createdAt) : "No run yet"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function RunResultRow({ result }: { result: PressureResult }) {
  return (
    <tr className="border-b align-top last:border-0">
      <td className="whitespace-nowrap py-4 pr-4">
        {formatDateTime(result.createdAt)}
        <div className="mt-1 font-mono text-xs text-muted-foreground">{result.runId}</div>
      </td>
      <td className="py-4 pr-4">
        <Badge variant={result.status === "PASS" ? "default" : "destructive"}>{result.status}</Badge>
        {result.failures.length > 0 && (
          <details className="mt-2 max-w-64 text-xs text-destructive">
            <summary className="cursor-pointer">
              {result.failures.length} failure{result.failures.length === 1 ? "" : "s"}
            </summary>
            <ul className="mt-1 list-disc space-y-1 pl-4">
              {result.failures.slice(0, 8).map((failure, index) => (
                <li key={`${result.id}-${index}`}>
                  {failure.name ?? "Check"}
                  {failure.detail ? `: ${failure.detail}` : failure.count ? `: ${failure.count}` : ""}
                </li>
              ))}
            </ul>
          </details>
        )}
      </td>
      <td className="py-4 pr-4">
        <div className="font-medium">{result.suite}</div>
        <div className="text-muted-foreground">{result.scenario}</div>
      </td>
      <td className="py-4 pr-4">
        <Badge variant="outline">{result.environment}</Badge>
        {result.virtualUsers !== null && (
          <div className="mt-1 text-xs text-muted-foreground">{result.virtualUsers} VUs</div>
        )}
      </td>
      <td className="py-4 pr-4 text-right tabular-nums">
        <span className="text-emerald-600">{result.passedChecks}</span> /{" "}
        <span className={result.failedChecks ? "text-red-600" : ""}>{result.failedChecks}</span>
      </td>
      <td className="py-4 pr-4 text-right tabular-nums">
        {formatLatency(result.p95Ms)}
        <div className="text-xs text-muted-foreground">{formatLatency(result.p99Ms)}</div>
      </td>
      <td className="py-4 pr-4 text-right tabular-nums">{formatDuration(result.durationMs)}</td>
      <td className="py-4">
        <div>{result.source}</div>
        {result.commitSha && (
          <div className="mt-1 font-mono text-xs text-muted-foreground">{result.commitSha.slice(0, 8)}</div>
        )}
      </td>
    </tr>
  );
}

function RunHistory({
  data,
  error,
  loading,
  page,
  setPage,
}: {
  data: ResponseBody | null;
  error: string | null;
  loading: boolean;
  page: number;
  setPage: (update: (value: number) => number) => void;
}) {
  const isEmpty = !loading && (data?.results.length ?? 0) === 0;
  const isLastPage = page * (data?.pageSize ?? 25) >= (data?.total ?? 0);
  return (
    <Card>
      <CardHeader><CardTitle>Run history</CardTitle></CardHeader>
      <CardContent>
        {error && (
          <div role="alert" className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="py-3 pr-4">When</th><th className="py-3 pr-4">Result</th>
                <th className="py-3 pr-4">Suite / scenario</th><th className="py-3 pr-4">Target</th>
                <th className="py-3 pr-4 text-right">Checks</th><th className="py-3 pr-4 text-right">p95 / p99</th>
                <th className="py-3 pr-4 text-right">Duration</th><th className="py-3">Source</th>
              </tr>
            </thead>
            <tbody>
              {isEmpty && <tr><td colSpan={8} className="py-12 text-center text-muted-foreground">No results match these filters.</td></tr>}
              {data?.results.map((result) => <RunResultRow key={result.id} result={result} />)}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <Button variant="outline" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page === 1 || loading}>Previous</Button>
          <span className="text-sm text-muted-foreground">Page {page}</span>
          <Button variant="outline" onClick={() => setPage((value) => value + 1)} disabled={loading || isLastPage}>Next</Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function PressureTestsClient() {
  const [data, setData] = useState<ResponseBody | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [days, setDays] = useState("30");
  const [suite, setSuite] = useState("");
  const [scenario, setScenario] = useState("");
  const [status, setStatus] = useState("");
  const [environment, setEnvironment] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ page: String(page), pageSize: "25", days });
    if (suite) params.set("suite", suite);
    if (scenario) params.set("scenario", scenario);
    if (status) params.set("status", status);
    if (environment) params.set("environment", environment);
    try {
      const response = await fetch(`/api/admin/pressure-results?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      setData(await response.json());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load pressure-test history.");
    } finally {
      setLoading(false);
    }
  }, [days, environment, page, scenario, status, suite]);

  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(() => {
    const results = data?.results ?? [];
    const passed = results.filter((result) => result.status === "PASS").length;
    const latest = results[0] ?? null;
    return {
      displayed: results.length,
      passRate: results.length ? Math.round((passed / results.length) * 100) : 0,
      latest,
    };
  }, [data]);

  const resetFilters = () => {
    setPage(1);
    setDays("30");
    setSuite("");
    setScenario("");
    setStatus("");
    setEnvironment("");
  };

  return (
    <div className="space-y-6 p-4 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Pressure Tests</h1>
          <p className="mt-1 text-muted-foreground">Live API checks and isolated EC2 load-test history.</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={`mr-2 size-4 ${loading ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <SummaryCards
        total={data?.total ?? 0}
        displayed={summary.displayed}
        passRate={summary.passRate}
        latest={summary.latest}
      />

      <Card>
        <CardHeader><CardTitle>P95 latency trend</CardTitle></CardHeader>
        <CardContent><PressureTrendChart points={data?.results ?? []} /></CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Filters</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
          <FilterSelect label="Window" value={days} onChange={(value) => { setDays(value); setPage(1); }} options={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "365", label: "1 year" }]} />
          <FilterSelect label="Suite" value={suite} onChange={(value) => { setSuite(value); setPage(1); }} options={[{ value: "", label: "All suites" }, ...(data?.facets.suites ?? []).map((value) => ({ value, label: value }))]} />
          <FilterSelect label="Scenario" value={scenario} onChange={(value) => { setScenario(value); setPage(1); }} options={[{ value: "", label: "All scenarios" }, ...(data?.facets.scenarios ?? []).map((value) => ({ value, label: value }))]} />
          <FilterSelect label="Status" value={status} onChange={(value) => { setStatus(value); setPage(1); }} options={[{ value: "", label: "Any status" }, { value: "PASS", label: "Pass" }, { value: "FAIL", label: "Fail" }]} />
          <FilterSelect label="Target" value={environment} onChange={(value) => { setEnvironment(value); setPage(1); }} options={[{ value: "", label: "All targets" }, ...(data?.facets.environments ?? []).map((value) => ({ value, label: value }))]} />
          <div className="flex items-end"><Button type="button" variant="ghost" onClick={resetFilters}>Reset filters</Button></div>
        </CardContent>
      </Card>

      <RunHistory data={data} error={error} loading={loading} page={page} setPage={setPage} />

      <IngestionTokens />
    </div>
  );
}
