/**
 * Compare two runs and decide whether the newer one is a regression.
 *
 * This is what makes tier 1 useful. Absolute latencies from a laptop are not
 * portable, but the *delta* between two commits measured on the same machine
 * with the same dataset is — so CI can gate on this without pretending to know
 * production capacity.
 *
 * Two guards against false verdicts:
 *
 *   - Tier mismatch is refused outright. Comparing a laptop run to an EC2 run
 *     produces a confident, meaningless number.
 *   - A step needs a minimum sample count and a minimum absolute change before
 *     a percentage difference counts. At n=6, a p95 is mostly noise, and a 25%
 *     regression on a 4ms endpoint is not a finding.
 *
 * Usage:
 *   compare.ts --baseline benchmark/baseline/local.json \
 *              --candidate benchmark/results/<run>/summary.json \
 *              [--threshold 20] [--min-samples 30] [--min-delta-ms 25]
 */

import fs from "node:fs";
import path from "node:path";
import { parseFlags } from "../tools/args";

type StepStats = {
  count: number;
  avg: number;
  med: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
};

type Summary = {
  label: string;
  tier: string;
  atIso: string;
  host?: Record<string, string> | null;
  dataset?: { seed?: number; scale?: number } | null;
  steps: Record<string, StepStats>;
  errors: {
    unexpectedRate: number;
    serverErrors: number;
    sqliteBusy: number;
  };
  throughput: { rps: number; peakVus: number };
  probes?: { web?: { peakEventLoopP99Ms: number } | null };
};

type Args = {
  baseline: string;
  candidate: string;
  thresholdPercent: number;
  minSamples: number;
  minDeltaMs: number;
  updateBaseline: boolean;
};

function parseArgs(argv: string[]): Args {
  const flags = parseFlags(argv);
  const baseline = flags.str("baseline");
  const candidate = flags.str("candidate");
  if (!baseline || !candidate || baseline === "true" || candidate === "true") {
    throw new Error(
      "usage: compare.ts --baseline <summary.json> --candidate <summary.json> " +
        "[--threshold 20] [--min-samples 30] [--min-delta-ms 25] [--update-baseline]"
    );
  }
  return {
    baseline: path.resolve(baseline),
    candidate: path.resolve(candidate),
    thresholdPercent: flags.int("threshold", 20),
    minSamples: flags.int("min-samples", 30),
    minDeltaMs: flags.int("min-delta-ms", 25),
    updateBaseline: flags.bool("update-baseline"),
  };
}

const load = (filePath: string): Summary => {
  if (!fs.existsSync(filePath)) throw new Error(`no summary at ${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Summary;
};

const percentChange = (before: number, after: number) =>
  before === 0 ? (after === 0 ? 0 : 100) : ((after - before) / before) * 100;

type Row = {
  step: string;
  baselineP95: number;
  candidateP95: number;
  deltaMs: number;
  deltaPercent: number;
  samples: number;
  verdict: "regression" | "improvement" | "unchanged" | "insufficient-data" | "new" | "missing";
};

function compareSteps(args: Args, baseline: Summary, candidate: Summary): Row[] {
  const stepNames = [
    ...new Set([...Object.keys(baseline.steps), ...Object.keys(candidate.steps)]),
  ].sort();

  return stepNames.map((step) => {
    const before = baseline.steps[step];
    const after = candidate.steps[step];

    if (!before && after) {
      return {
        step,
        baselineP95: 0,
        candidateP95: after.p95,
        deltaMs: 0,
        deltaPercent: 0,
        samples: after.count,
        verdict: "new" as const,
      };
    }
    if (before && !after) {
      return {
        step,
        baselineP95: before.p95,
        candidateP95: 0,
        deltaMs: 0,
        deltaPercent: 0,
        samples: 0,
        // A step that vanished is a harness or routing change, not a win.
        verdict: "missing" as const,
      };
    }

    const deltaMs = after.p95 - before.p95;
    const deltaPercent = percentChange(before.p95, after.p95);
    const samples = Math.min(before.count, after.count);

    let verdict: Row["verdict"];
    if (samples < args.minSamples) {
      verdict = "insufficient-data";
    } else if (deltaPercent > args.thresholdPercent && deltaMs > args.minDeltaMs) {
      verdict = "regression";
    } else if (deltaPercent < -args.thresholdPercent && -deltaMs > args.minDeltaMs) {
      verdict = "improvement";
    } else {
      verdict = "unchanged";
    }

    return {
      step,
      baselineP95: before.p95,
      candidateP95: after.p95,
      deltaMs: Math.round(deltaMs * 10) / 10,
      deltaPercent: Math.round(deltaPercent * 10) / 10,
      samples,
      verdict,
    };
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseline = load(args.baseline);
  const candidate = load(args.candidate);

  if (baseline.tier !== candidate.tier) {
    throw new Error(
      `refusing to compare tier "${baseline.tier}" against tier "${candidate.tier}". ` +
        `Different tiers run on different hardware through different network paths; ` +
        `the delta would be meaningless.`
    );
  }
  if (
    baseline.dataset?.seed !== undefined &&
    candidate.dataset?.seed !== undefined &&
    (baseline.dataset.seed !== candidate.dataset.seed ||
      baseline.dataset.scale !== candidate.dataset.scale)
  ) {
    console.warn(
      `WARNING: dataset differs (baseline seed ${baseline.dataset.seed}/scale ${baseline.dataset.scale} ` +
        `vs candidate ${candidate.dataset.seed}/${candidate.dataset.scale}). ` +
        `Latency differences may be dataset size, not code.`
    );
  }
  if (baseline.host?.instanceType && candidate.host?.instanceType) {
    if (baseline.host.instanceType !== candidate.host.instanceType) {
      console.warn(
        `WARNING: host differs (${baseline.host.instanceType} vs ${candidate.host.instanceType}).`
      );
    }
  }

  const rows = compareSteps(args, baseline, candidate);
  const regressions = rows.filter((row) => row.verdict === "regression");
  const improvements = rows.filter((row) => row.verdict === "improvement");

  // Correctness regressions are absolute — no percentage threshold applies. A
  // run that introduces a lock timeout or a 5xx has failed regardless of how
  // good its latency looks.
  const correctness: string[] = [];
  if (candidate.errors.sqliteBusy > baseline.errors.sqliteBusy) {
    correctness.push(
      `SQLITE_BUSY / lock timeouts rose ${baseline.errors.sqliteBusy} → ${candidate.errors.sqliteBusy}`
    );
  }
  if (candidate.errors.serverErrors > baseline.errors.serverErrors) {
    correctness.push(
      `server 5xx rose ${baseline.errors.serverErrors} → ${candidate.errors.serverErrors}`
    );
  }

  const lines: string[] = [];
  lines.push(`# Benchmark comparison — tier \`${candidate.tier}\``);
  lines.push("");
  lines.push(`- baseline: \`${baseline.label}\` (${baseline.atIso})`);
  lines.push(`- candidate: \`${candidate.label}\` (${candidate.atIso})`);
  lines.push(
    `- gate: p95 regression > ${args.thresholdPercent}% AND > ${args.minDeltaMs}ms, ` +
      `with at least ${args.minSamples} samples`
  );
  lines.push("");
  lines.push("| Step | baseline p95 | candidate p95 | Δ ms | Δ % | n | |");
  lines.push("| --- | --: | --: | --: | --: | --: | --- |");

  const icon: Record<Row["verdict"], string> = {
    regression: "🔴 regression",
    improvement: "🟢 improvement",
    unchanged: "· unchanged",
    "insufficient-data": "· low n",
    new: "＋ new",
    missing: "⚠ missing",
  };
  const ms = (value: number) => Math.round(value * 10) / 10;
  for (const row of rows) {
    lines.push(
      `| \`${row.step}\` | ${ms(row.baselineP95)} | ${ms(row.candidateP95)} | ` +
        `${row.deltaMs > 0 ? "+" : ""}${row.deltaMs} | ${row.deltaPercent > 0 ? "+" : ""}${row.deltaPercent}% | ` +
        `${row.samples} | ${icon[row.verdict]} |`
    );
  }
  lines.push("");

  const loopBefore = baseline.probes?.web?.peakEventLoopP99Ms;
  const loopAfter = candidate.probes?.web?.peakEventLoopP99Ms;
  if (typeof loopBefore === "number" && typeof loopAfter === "number") {
    lines.push(
      `Event-loop p99 peak: ${loopBefore}ms → ${loopAfter}ms ` +
        `(${percentChange(loopBefore, loopAfter) > 0 ? "+" : ""}${Math.round(percentChange(loopBefore, loopAfter))}%)`
    );
    lines.push("");
  }

  if (correctness.length > 0) {
    lines.push("## Correctness regressions");
    lines.push("");
    for (const item of correctness) lines.push(`- 🔴 ${item}`);
    lines.push("");
  }

  const failed = regressions.length > 0 || correctness.length > 0;
  lines.push(
    failed
      ? `**FAIL** — ${regressions.length} latency regression(s), ${correctness.length} correctness regression(s)`
      : `**PASS** — no regressions past the gate (${improvements.length} improvement(s))`
  );
  lines.push("");

  const report = lines.join("\n");
  console.log(report);

  const outPath = path.join(path.dirname(args.candidate), "comparison.md");
  fs.writeFileSync(outPath, `${report}\n`);

  if (args.updateBaseline && !failed) {
    // Only promote a passing run: writing a regressed run to the baseline would
    // silently ratchet the budget upward and hide the regression forever.
    fs.copyFileSync(args.candidate, args.baseline);
    console.log(`baseline updated → ${args.baseline}`);
  }

  process.exit(failed ? 1 : 0);
}

try {
  main();
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
