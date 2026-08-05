/**
 * Turn a k6 run into a readable summary and a machine-comparable baseline.
 *
 * Reads k6's `--summary-export` JSON plus whatever the samplers in metrics.sh
 * produced, and writes:
 *
 *   summary.json  — flat, stable shape, the input to compare.ts and to a
 *                   committed baseline
 *   summary.md    — the human artifact: per-step percentiles, the error
 *                   taxonomy, and the host the run happened on
 *
 * The host block is not decoration. A latency figure without the instance type
 * and core count behind it cannot be compared to anything, and mixing tier-1
 * laptop numbers with tier-3 EC2 numbers is the most likely way this harness
 * could produce a wrong conclusion.
 */

import fs from "node:fs";
import path from "node:path";
import { parseFlags } from "../tools/args";

type Args = { runDir: string; label: string | undefined; tier: string };

function parseArgs(argv: string[]): Args {
  const flags = parseFlags(argv);
  const runDir = flags.str("run");
  if (!runDir || runDir === "true") {
    throw new Error("usage: summarize.ts --run <resultsDir> [--label name] [--tier local|dev|ec2]");
  }
  return {
    runDir: path.resolve(runDir),
    label: flags.str("label"),
    tier: flags.str("tier", "local")!,
  };
}

const readJson = <T>(filePath: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
};

/**
 * k6 summary-export shape.
 *
 * Two versions in the wild: k6 ≥ 2 puts the statistics directly on the metric
 * object, while older releases nested them under `.values`. `stats()` normalises
 * both so a run exported by either is readable.
 */
type K6Metric = Record<string, unknown> & {
  values?: Record<string, number>;
  thresholds?: Record<string, { ok?: boolean } | boolean>;
};
type K6Summary = {
  metrics?: Record<string, K6Metric>;
  state?: { testRunDurationMs?: number };
  root_group?: { checks?: Record<string, { passes?: number; fails?: number }> };
};

const round = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) ? 0 : Math.round(value * 10) / 10;

/** Statistics for one metric, regardless of which k6 version wrote the file. */
const stats = (metric: K6Metric | undefined): Record<string, number> => {
  if (!metric) return {};
  if (metric.values && typeof metric.values === "object") return metric.values;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(metric)) {
    if (typeof value === "number") out[key] = value;
  }
  return out;
};

/**
 * k6 emits tagged values as submetrics named `metric{tag:value}`. Every step in
 * lib/metrics.js is a tag on one Trend, so this is how per-step numbers come
 * back — and it only works because config.thresholds() declares an entry for
 * every step, which is what makes k6 materialise the submetric at all.
 */
function stepMetrics(metrics: Record<string, K6Metric>) {
  const steps: Record<string, Record<string, number>> = {};
  for (const [name, metric] of Object.entries(metrics)) {
    const match = /^step_duration\{step:([^}]+)\}$/.exec(name);
    if (!match) continue;
    const values = stats(metric);
    // A declared-but-never-exercised step has no samples; reporting it as a row
    // of zeros would imply it was measured and found instant.
    const count = values.count ?? 0;
    if (count === 0 && (values.max ?? 0) === 0) continue;
    steps[match[1]] = {
      count,
      avg: round(values.avg),
      med: round(values.med),
      p90: round(values["p(90)"]),
      p95: round(values["p(95)"]),
      p99: round(values["p(99)"]),
      max: round(values.max),
    };
  }
  return steps;
}

/**
 * Sum a counter across its submetrics. Counters that never fired are absent from
 * the export entirely, which is indistinguishable from zero — and zero is the
 * correct reading.
 */
const counterTotal = (metrics: Record<string, K6Metric>, prefix: string) => {
  let total = 0;
  for (const [name, metric] of Object.entries(metrics)) {
    if (name === prefix || name.startsWith(`${prefix}{`)) {
      total += stats(metric).count ?? 0;
    }
  }
  return total;
};

/**
 * Collect breached thresholds.
 *
 * The polarity here is the whole reason this is a named function with a comment:
 * in k6's export the boolean is "was this threshold crossed?", so `true` means
 * FAILED. Reading it as "ok" inverts every verdict — a passing run reported as a
 * regression and, far worse, a failing run reported as a pass. Older k6 wrote
 * `{ ok: boolean }` instead, where `false` means failed. Both are handled.
 */
function breachedThresholds(metrics: Record<string, K6Metric>): string[] {
  const failures: string[] = [];
  for (const [name, metric] of Object.entries(metrics)) {
    for (const [expression, result] of Object.entries(metric.thresholds ?? {})) {
      const failed =
        typeof result === "object" && result !== null
          ? result.ok === false
          : result === true;
      if (failed) failures.push(`${name}: ${expression}`);
    }
  }
  return failures;
}

/** Last non-null probe sample plus the peak seen, from the JSONL series. */
function probeSeries(filePath: string) {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let peakLoopP99 = 0;
  let peakRssBytes = 0;
  let peakWalBytes = 0;
  let firstWalBytes: number | null = null;
  let samples = 0;

  for (const line of lines) {
    let sample: Record<string, any>;
    try {
      sample = JSON.parse(line);
    } catch {
      continue;
    }
    samples += 1;
    peakLoopP99 = Math.max(peakLoopP99, sample?.eventLoopDelayMs?.p99 ?? 0);
    peakRssBytes = Math.max(peakRssBytes, sample?.memory?.rssBytes ?? 0);
    const wal = sample?.sqlite?.walBytes;
    if (typeof wal === "number") {
      peakWalBytes = Math.max(peakWalBytes, wal);
      firstWalBytes ??= wal;
    }
  }

  return {
    samples,
    peakEventLoopP99Ms: round(peakLoopP99),
    peakRssMiB: round(peakRssBytes / 1024 / 1024),
    // Growth, not absolute size: a WAL that ends far larger than it started is
    // the signature of checkpoints being starved by continuous readers.
    walGrowthMiB: round((peakWalBytes - (firstWalBytes ?? 0)) / 1024 / 1024),
    peakWalMiB: round(peakWalBytes / 1024 / 1024),
  };
}

/** Peak pending job count — is the worker draining or accumulating? */
function queueSeries(filePath: string) {
  if (!fs.existsSync(filePath)) return null;
  let peak = 0;
  let last = 0;
  let samples = 0;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let sample: { pendingJobs?: number | null };
    try {
      sample = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof sample.pendingJobs !== "number") continue;
    samples += 1;
    peak = Math.max(peak, sample.pendingJobs);
    last = sample.pendingJobs;
  }
  return samples > 0 ? { samples, peakPendingJobs: peak, finalPendingJobs: last } : null;
}

const STEP_ORDER = [
  "quiz_start",
  "quiz_submit",
  "result_poll",
  "page_student_dashboard",
  "page_class_view",
  "page_teacher_dashboard",
  "page_teacher_class",
  "quiz_stats",
  "grades_export",
  "questions_poll",
  "notifications",
  "admin_stats",
  "admin_materials",
  "admin_logs",
  "login",
  "login_csrf",
];

function main() {
  const args = parseArgs(process.argv.slice(2));
  const k6 = readJson<K6Summary>(path.join(args.runDir, "k6-summary.json"));
  if (!k6?.metrics) {
    throw new Error(
      `no k6-summary.json in ${args.runDir} — run k6 with --summary-export=<dir>/k6-summary.json`
    );
  }

  const metrics = k6.metrics;
  const steps = stepMetrics(metrics);
  const host = readJson<Record<string, string>>(path.join(args.runDir, "host.json"));
  const dataset = readJson<Record<string, any>>(path.join(args.runDir, "dataset.json"));
  const web = probeSeries(path.join(args.runDir, "probe-web.jsonl"));
  const worker = probeSeries(path.join(args.runDir, "probe-worker.jsonl"));
  const queue = queueSeries(path.join(args.runDir, "queue-depth.jsonl"));

  const failedThresholds = breachedThresholds(metrics);
  const checks = k6.root_group?.checks ?? {};
  const checkResults = Object.entries(checks).map(([name, result]) => ({
    name,
    passes: result.passes ?? 0,
    fails: result.fails ?? 0,
  }));
  const failedChecks = checkResults.filter((check) => check.fails > 0);

  const summary = {
    label: args.label ?? path.basename(args.runDir),
    tier: args.tier,
    atIso: new Date().toISOString(),
    runDurationS: Math.round((k6.state?.testRunDurationMs ?? 0) / 1000),
    host,
    dataset: dataset
      ? { seed: dataset.seed, scale: dataset.scale, counts: dataset.counts }
      : null,
    steps,
    errors: {
      // Kept apart on purpose: `designed` are the app's correct 4xx responses
      // (attempt cap, duplicate submit, login throttle) and must never be read
      // as failures, while `serverErrors` and `sqliteBusy` are real defects.
      // A Rate metric's aggregate is exported as `value`, not `rate`.
      unexpectedRate:
        Math.round((stats(metrics.unexpected_errors).value ?? 0) * 10000) / 10000,
      designed: counterTotal(metrics, "designed_responses"),
      serverErrors: counterTotal(metrics, "server_errors"),
      sqliteBusy: counterTotal(metrics, "sqlite_busy"),
      rateLimited: counterTotal(metrics, "rate_limited"),
      stepFailures: counterTotal(metrics, "step_failures"),
      httpFailRate: Math.round((stats(metrics.http_req_failed).value ?? 0) * 10000) / 10000,
    },
    throughput: {
      httpReqs: stats(metrics.http_reqs).count ?? 0,
      rps: round(stats(metrics.http_reqs).rate),
      iterations: stats(metrics.iterations).count ?? 0,
      peakVus: stats(metrics.vus_max).max ?? stats(metrics.vus).max ?? 0,
    },
    worker: {
      resultReadyP95Ms: round(stats(metrics.result_ready_duration)["p(95)"]),
      resultReadyMaxMs: round(stats(metrics.result_ready_duration).max),
      resultTimeouts: counterTotal(metrics, "result_ready_timeouts"),
      queue,
    },
    recoverySeconds: stats(metrics.recovery_seconds).value ?? null,
    probes: { web, worker },
    checks: checkResults,
    failedThresholds,
    failedChecks: failedChecks.map((check) => check.name),
    // A failed check is as much a failure as a breached threshold: it means a
    // journey did not complete, which invalidates the latency numbers around it.
    verdict: failedThresholds.length === 0 && failedChecks.length === 0 ? "PASS" : "FAIL",
  };

  fs.writeFileSync(
    path.join(args.runDir, "summary.json"),
    JSON.stringify(summary, null, 2)
  );

  // ── Markdown ──
  const lines: string[] = [];
  lines.push(`# Benchmark run — ${summary.label}`);
  lines.push("");
  lines.push(`**Verdict: ${summary.verdict}** · tier \`${summary.tier}\` · ${summary.runDurationS}s`);
  lines.push("");

  if (host) {
    lines.push(
      `Host: \`${host.instanceType ?? "unknown"}\` · ${host.cores ?? "?"} cores · ` +
        `${host.availabilityZone ?? "n/a"} · kernel \`${host.kernel ?? "?"}\``
    );
  }
  if (summary.dataset) {
    const counts = summary.dataset.counts ?? {};
    lines.push(
      `Dataset: seed ${summary.dataset.seed}, scale ${summary.dataset.scale} — ` +
        `${counts.students ?? "?"} students, ${counts.attempts ?? "?"} historical attempts, ` +
        `${counts.answers ?? "?"} answer rows`
    );
  }
  if (args.tier === "local") {
    lines.push("");
    lines.push(
      "> Tier 1 numbers are for **commit-to-commit comparison only**. A dev machine's " +
        "core count and NVMe fsync profile do not predict EC2 capacity — use tier 3 for that."
    );
  }
  lines.push("");

  lines.push("## Latency by step (ms)");
  lines.push("");
  lines.push("| Step | n | p50 | p90 | p95 | p99 | max |");
  lines.push("| --- | --: | --: | --: | --: | --: | --: |");
  const ordered = [
    ...STEP_ORDER.filter((step) => steps[step]),
    ...Object.keys(steps).filter((step) => !STEP_ORDER.includes(step)),
  ];
  for (const step of ordered) {
    const s = steps[step];
    lines.push(
      `| \`${step}\` | ${s.count} | ${s.med} | ${s.p90} | ${s.p95} | ${s.p99} | ${s.max} |`
    );
  }
  lines.push("");

  lines.push("## Throughput");
  lines.push("");
  lines.push(`- ${summary.throughput.httpReqs} requests (${summary.throughput.rps}/s)`);
  lines.push(`- ${summary.throughput.iterations} journeys, peak ${summary.throughput.peakVus} VUs`);
  lines.push("");

  lines.push("## Errors");
  lines.push("");
  lines.push(`- unexpected error rate: **${summary.errors.unexpectedRate}**`);
  lines.push(`- server 5xx: **${summary.errors.serverErrors}**`);
  lines.push(
    `- SQLITE_BUSY / lock timeouts: **${summary.errors.sqliteBusy}** ` +
      `(any non-zero value means graded submissions were at risk)`
  );
  lines.push(
    `- designed 4xx (attempt cap, duplicate submit, throttle): ${summary.errors.designed} — not failures`
  );
  lines.push(`- rate-limited (429): ${summary.errors.rateLimited}`);
  lines.push("");

  lines.push("## Background worker");
  lines.push("");
  lines.push(
    `- submit → AI result readable: p95 **${summary.worker.resultReadyP95Ms}ms**, ` +
      `max ${summary.worker.resultReadyMaxMs}ms`
  );
  lines.push(`- result timeouts: ${summary.worker.resultTimeouts}`);
  if (queue) {
    lines.push(
      `- queue depth: peak ${queue.peakPendingJobs}, final ${queue.finalPendingJobs} ` +
        `(a final depth near the peak means the worker never caught up)`
    );
  }
  if (summary.recoverySeconds !== null) {
    lines.push(`- recovery after spike: **${summary.recoverySeconds}s**`);
  }
  lines.push("");

  lines.push("## Process internals");
  lines.push("");
  for (const [role, series] of [
    ["web", web],
    ["worker", worker],
  ] as const) {
    if (!series) {
      lines.push(`- ${role}: no probe samples (was the probe preloaded via NODE_OPTIONS?)`);
      continue;
    }
    lines.push(
      `- ${role}: event-loop p99 peak **${series.peakEventLoopP99Ms}ms**, ` +
        `RSS peak ${series.peakRssMiB} MiB, WAL growth ${series.walGrowthMiB} MiB ` +
        `(peak ${series.peakWalMiB} MiB)`
    );
  }
  lines.push("");
  lines.push(
    "Event-loop delay is the leading indicator on this stack: better-sqlite3 executes " +
      "every query synchronously on the server's only thread, so the loop queues before " +
      "HTTP latency visibly degrades."
  );
  lines.push("");

  if (failedThresholds.length > 0) {
    lines.push("## Failed thresholds");
    lines.push("");
    for (const failure of failedThresholds) lines.push(`- \`${failure}\``);
    lines.push("");
  }

  if (failedChecks.length > 0) {
    lines.push("## Failed checks");
    lines.push("");
    for (const check of failedChecks) {
      lines.push(`- ${check.name} — ${check.fails} failed / ${check.passes} passed`);
    }
    lines.push("");
    lines.push(
      "A failed check means a journey did not complete, so the latency numbers " +
        "around it describe a partial run."
    );
    lines.push("");
  }

  fs.writeFileSync(path.join(args.runDir, "summary.md"), `${lines.join("\n")}\n`);

  console.log(`${summary.verdict} — ${args.runDir}/summary.md`);
  if (failedThresholds.length > 0) {
    console.log(`  ${failedThresholds.length} failed threshold(s)`);
  }
}

try {
  main();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
