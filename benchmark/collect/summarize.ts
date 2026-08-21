/**
 * Turn a k6 summary export plus probe snapshots into a readable report.
 *
 * Usage:
 *   tsx benchmark/collect/summarize.ts --summary run/summary.json \
 *       --probes run/probes.json --meta run/meta.json --out run/report.md
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs, str } from "../tools/args";

type Metric = {
  type?: string;
  /** Present in handleSummary's `data` object. */
  values?: Record<string, number>;
  thresholds?: Record<string, boolean | { ok?: boolean }>;
  /** --summary-export puts the statistics FLAT on the metric (see `stats`). */
  [key: string]: unknown;
};

/**
 * Read a metric's statistics, whichever shape they arrived in.
 *
 * k6 has TWO summary shapes and they differ in exactly the way that produces a
 * silently empty report:
 *
 *   --summary-export <file>   statistics are FLAT on the metric object
 *                             { "p(95)": 420, count: 300, thresholds: {...} }
 *   handleSummary(data)       statistics are nested under `.values`
 *                             { values: { "p(95)": 420, count: 300 }, ... }
 *
 * The runners use --summary-export, so a reader that only understood `.values`
 * saw `undefined` for every number — and because the verdict counters were read
 * with `?? 0`, a run with real failures reported "0 unexpected errors" and
 * PASSED. The table still drew, with every cell showing an em dash, which reads
 * as "nothing ran" rather than "the reader is broken". Both shapes are handled
 * now, flat first.
 */
function stats(metric: Metric | undefined): Record<string, number> {
  if (!metric) return {};
  if (metric.values && typeof metric.values === "object") return metric.values;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(metric)) {
    if (typeof value === "number") out[key] = value;
  }
  return out;
}

type K6Summary = {
  metrics?: Record<string, Metric>;
  state?: { testRunDurationMs?: number };
};

/**
 * Read a k6 threshold result.
 *
 * THE POLARITY TRAP. In k6's summary export, a threshold entry's boolean means
 * "was this threshold CROSSED?" — so `true` means the limit was breached, i.e.
 * FAILED. Reading it as "ok" inverts every verdict in the report: every passing
 * run is reported as FAIL and, far worse, every failing run is reported as PASS.
 *
 * Newer k6 versions may instead expose `{ ok: boolean }`. Both shapes are
 * handled, and an unrecognised shape is reported as unknown rather than guessed
 * at — a silently wrong verdict is the whole failure mode being avoided here.
 */
function thresholdFailed(entry: boolean | { ok?: boolean } | undefined): boolean | null {
  if (typeof entry === "boolean") return entry;
  if (entry && typeof entry === "object" && typeof entry.ok === "boolean") return !entry.ok;
  return null;
}

function fmtMs(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${value.toFixed(1)}ms`;
}

function fmtCount(value: number | undefined): string {
  return value === undefined ? "—" : String(Math.round(value));
}

function main() {
  const args = parseArgs();
  const summaryPath = str(args, "summary");
  const outPath = str(args, "out", "");

  const summary: K6Summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const metrics = summary.metrics ?? {};

  const probes = readOptionalJson(args.opts["probes"]);
  const meta = readOptionalJson(args.opts["meta"]) ?? {};

  const lines: string[] = [];
  const push = (line = "") => lines.push(line);

  push(`# Pressure test report`);
  push();
  push(`| | |`);
  push(`|---|---|`);
  for (const [key, value] of Object.entries(meta as Record<string, unknown>)) {
    push(`| ${key} | ${typeof value === "object" ? JSON.stringify(value) : String(value)} |`);
  }
  const durationMs = summary.state?.testRunDurationMs;
  if (durationMs) push(`| run duration | ${(durationMs / 1000 / 60).toFixed(1)} min |`);
  push();

  // ─── Verdict ───────────────────────────────────────────────────────────────
  // Correctness counters first, because a run can sit comfortably inside every
  // latency SLO while silently dropping graded submissions.
  // Missing (not zero) must be distinguishable from genuinely zero: a reader
  // that cannot find the counter has to say so, not silently report a pass.
  const unexpected = stats(metrics.unexpected_errors).count;
  const busy = stats(metrics.sqlite_busy).count;
  const designed = stats(metrics.designed_refusals).count;
  const countersMissing = unexpected === undefined || busy === undefined;

  const breached: string[] = [];
  const unknownPolarity: string[] = [];
  for (const [name, metric] of Object.entries(metrics)) {
    for (const [limit, entry] of Object.entries(metric.thresholds ?? {})) {
      const failed = thresholdFailed(entry);
      if (failed === null) unknownPolarity.push(`${name} ${limit}`);
      else if (failed) breached.push(`${name} ${limit}`);
    }
  }

  const verdict =
    countersMissing || (unexpected ?? 0) > 0 || (busy ?? 0) > 0 || breached.length > 0 ? "FAIL" : "PASS";
  push(`## Verdict: ${verdict}`);
  push();
  if (countersMissing) {
    push(
      `> **The correctness counters were not found in this summary.** That is a reporting failure, ` +
        `not a clean run — reported as FAIL rather than assumed to be zero. Check that the scenario ` +
        `imports \`thresholds()\` from k6/lib/metrics.js.`
    );
    push();
  }
  push(`- unexpected errors: **${fmtCount(unexpected)}** (any non-zero fails the run)`);
  push(
    `- \`sqlite_busy\`: **${fmtCount(busy)}** — a non-zero value means a write waited longer than ` +
      `better-sqlite3's 5s timeout, i.e. a graded submission was LOST, not merely slow`
  );
  push(`- designed refusals: ${fmtCount(designed)} (401/403/409/410/429 — the app behaving correctly, never a failure)`);

  // A run where nearly EVERY request was refused is a broken harness, not a
  // healthy system — but each individual refusal is legitimately "designed", so
  // nothing else here would say so. The first CI run of this harness reported
  // PASS with 6 designed refusals out of 6 requests, because src/proxy.ts was
  // rejecting the host on every request.
  const totalRequests = stats(metrics.http_reqs).count ?? 0;
  if (designed !== undefined && totalRequests > 0 && designed / totalRequests > 0.5) {
    push();
    push(
      // Clamped: a journey can record more steps than http_reqs counts (batched
      // media fetches, redirects), and a ">100%" figure reads as a broken report.
      `> ⚠️ **${Math.min(100, Math.round((designed / totalRequests) * 100))}% of requests were refused.** Individually ` +
        `these are correct responses, but at this proportion suspect the HARNESS rather than the app. ` +
        `The usual cause is a 403 from src/proxy.ts's host allowlist — check \`BENCH_FORWARDED_HOST\`. ` +
        `A 401 on every request instead means the minted sessions are not being accepted (wrong ` +
        `AUTH_SECRET, or the wrong cookie name for the target's NODE_ENV).`
    );
  }
  if (breached.length > 0) {
    push();
    push(`Thresholds breached:`);
    for (const item of breached) push(`- \`${item}\``);
  }
  if (unknownPolarity.length > 0) {
    push();
    push(
      `> Could not interpret ${unknownPolarity.length} threshold result(s) from this k6 version ` +
        `(\`${unknownPolarity.slice(0, 3).join("`, `")}\`). They are EXCLUDED from the verdict rather ` +
        `than assumed to pass — treat this report as incomplete and check summarize.ts against your k6 version.`
    );
  }
  push();

  // ─── Per-step latency ──────────────────────────────────────────────────────
  push(`## Latency by journey step`);
  push();
  push(`| step | count | p50 | p95 | p99 | max |`);
  push(`|---|---:|---:|---:|---:|---:|`);

  const stepRows = Object.entries(metrics)
    .filter(([name]) => name.startsWith("step_duration{step:"))
    .map(([name, metric]) => {
      const step = name.slice("step_duration{step:".length, -1);
      return { step, values: stats(metric) };
    })
    .sort((a, b) => (b.values["p(95)"] ?? 0) - (a.values["p(95)"] ?? 0));

  if (stepRows.length === 0) {
    push(`| _no tagged step metrics found_ | | | | | |`);
  }
  for (const row of stepRows) {
    push(
      `| \`${row.step}\` | ${fmtCount(row.values.count)} | ${fmtMs(row.values.med)} | ` +
        `${fmtMs(row.values["p(95)"])} | ${fmtMs(row.values["p(99)"])} | ${fmtMs(row.values.max)} |`
    );
  }
  push();
  if (stepRows.length === 0) {
    push(
      `> k6 only materialises a tagged submetric when a threshold references it. An empty table ` +
        `usually means the scenario's STEPS list is missing entries — not that those steps never ran. ` +
        `Rows present but every cell empty means the opposite: the metrics are there and this reader ` +
        `could not decode them.`
    );
    push();
  }

  // ─── HTTP + throughput ─────────────────────────────────────────────────────
  const reqs = stats(metrics.http_reqs);
  const duration = stats(metrics.http_req_duration);
  push(`## HTTP`);
  push();
  push(`- requests: ${fmtCount(reqs.count)} (${(reqs.rate ?? 0).toFixed(1)}/s)`);
  push(`- duration p95: ${fmtMs(duration["p(95)"])}, p99: ${fmtMs(duration["p(99)"])}, max: ${fmtMs(duration.max)}`);
  const failed = stats(metrics.http_req_failed).rate;
  if (failed !== undefined) push(`- k6 http_req_failed rate: ${(failed * 100).toFixed(2)}% (includes designed refusals — use the counters above instead)`);
  push();

  // ─── Event loop ────────────────────────────────────────────────────────────
  if (probes) {
    push(`## Event-loop delay (from inside the process)`);
    push();
    push(
      `This is the leading indicator for this architecture and cannot be seen from the ` +
        `load generator. Every Prisma query is a synchronous better-sqlite3 call, so added ` +
        `concurrency becomes event-loop queueing rather than database parallelism.`
    );
    push();
    push(`| node | p50 | p95 | p99 | max | exceeds | RSS | GC max |`);
    push(`|---|---:|---:|---:|---:|---:|---:|---:|`);
    for (const snapshot of asArray(probes)) {
      const delay = snapshot?.eventLoopDelayMs ?? {};
      const role = snapshot?.node?.role ?? "unknown";
      push(
        `| ${role} | ${fmtMs(delay.p50)} | ${fmtMs(delay.p95)} | ${fmtMs(delay.p99)} | ` +
          `${fmtMs(delay.max)} | ${fmtCount(delay.exceeds)} | ${snapshot?.memory?.rssMb ?? "—"}MB | ` +
          `${fmtMs(snapshot?.gc?.maxMs)} |`
      );
    }
    push();
    const anyExceeds = asArray(probes).some((s) => (s?.eventLoopDelayMs?.exceeds ?? 0) > 0);
    if (anyExceeds) {
      push(
        `> \`exceeds\` is non-zero: the loop was blocked longer than the histogram could record, ` +
          `so the percentiles above UNDERSTATE the real delay.`
      );
      push();
    }
  } else {
    push(`## Event-loop delay`);
    push();
    push(
      `Not collected. Without it a latency regression cannot be attributed: a blocked event loop, ` +
        `a slow disk and a CPU-starved container are indistinguishable from outside the process. ` +
        `Run with the probe bind-mounted (see benchmark/instrument/probe.cjs).`
    );
    push();
  }

  const report = lines.join("\n");
  if (outPath) {
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, report);
    console.log(`report -> ${outPath}`);
  }
  console.log(report);

  // Exit code carries the verdict so a runner or CI job can gate on it.
  if (verdict === "FAIL") process.exitCode = 1;
}

function readOptionalJson(value: string | true | undefined): unknown {
  if (typeof value !== "string" || !value) return null;
  if (!fs.existsSync(value)) return null;
  try {
    return JSON.parse(fs.readFileSync(value, "utf8"));
  } catch {
    return null;
  }
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [value];
}

main();
