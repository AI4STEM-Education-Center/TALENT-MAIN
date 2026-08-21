/**
 * Compare two runs and decide whether the difference is a regression.
 *
 * WHY A TOOL RATHER THAN EYEBALLING TWO REPORTS. Load numbers are noisy, and
 * humans comparing two tables reliably do both of the wrong things: they call a
 * 6% move a regression, and they miss a 3x move on a step they weren't looking
 * at. A threshold plus full coverage of every shared step fixes both.
 *
 * TIER MIXING IS REFUSED. Comparing a local run against an EC2 clone run is
 * meaningless — different CPU, different dataset, different network — but the
 * two reports look identical in shape, so it is an easy and very confident
 * mistake to make. Cross-tier comparison is therefore rejected outright.
 *
 * Usage:
 *   tsx benchmark/collect/compare.ts --baseline before/summary.json \
 *       --candidate after/summary.json [--tolerance 0.20] \
 *       [--baseline-meta before/meta.json --candidate-meta after/meta.json]
 */

import fs from "node:fs";
import { parseArgs, str, num } from "../tools/args";

type Values = Record<string, number>;

/**
 * Read a metric's statistics from either k6 summary shape.
 *
 * --summary-export puts them FLAT on the metric; handleSummary nests them under
 * `.values`. Understanding only the nested shape made every number `undefined`,
 * which here would mean "no regression detected" on every comparison — a
 * silently useless tool. See the longer note in collect/summarize.ts.
 */
function stats(metric: any): Values {
  if (!metric) return {};
  if (metric.values && typeof metric.values === "object") return metric.values;
  const out: Values = {};
  for (const [key, value] of Object.entries(metric)) {
    if (typeof value === "number") out[key] = value as number;
  }
  return out;
}

function stepMetrics(summary: any): Record<string, Values> {
  const out: Record<string, Values> = {};
  for (const [name, metric] of Object.entries<any>(summary.metrics ?? {})) {
    if (!name.startsWith("step_duration{step:")) continue;
    out[name.slice("step_duration{step:".length, -1)] = stats(metric);
  }
  return out;
}

function counter(summary: any, name: string): number {
  return stats(summary?.metrics?.[name]).count ?? 0;
}

function main() {
  const args = parseArgs();
  const baseline = JSON.parse(fs.readFileSync(str(args, "baseline"), "utf8"));
  const candidate = JSON.parse(fs.readFileSync(str(args, "candidate"), "utf8"));
  const tolerance = num(args, "tolerance", 0.2);

  // ── Tier guard ──
  const baseMeta = readMeta(args.opts["baseline-meta"]);
  const candMeta = readMeta(args.opts["candidate-meta"]);
  if (baseMeta?.tier && candMeta?.tier && baseMeta.tier !== candMeta.tier) {
    console.error(
      `compare: REFUSING to compare tier "${baseMeta.tier}" against tier "${candMeta.tier}".\n` +
        `  Different tiers run on different hardware against different datasets, so the delta ` +
        `describes the environment, not the code. Compare like with like.`
    );
    process.exit(2);
  }
  if (baseMeta?.scenario && candMeta?.scenario && baseMeta.scenario !== candMeta.scenario) {
    console.error(
      `compare: REFUSING to compare scenario "${baseMeta.scenario}" against "${candMeta.scenario}" — ` +
        `different load shapes are not comparable.`
    );
    process.exit(2);
  }

  const before = stepMetrics(baseline);
  const after = stepMetrics(candidate);

  const steps = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();

  console.log(`Comparing ${steps.length} step(s), tolerance ±${(tolerance * 100).toFixed(0)}% on p95\n`);
  console.log("| step | baseline p95 | candidate p95 | change | verdict |");
  console.log("|---|---:|---:|---:|---|");

  const regressions: string[] = [];
  const missing: string[] = [];

  for (const step of steps) {
    const b = before[step]?.["p(95)"];
    const c = after[step]?.["p(95)"];

    // A step present in one run and absent from the other is reported, not
    // skipped: it usually means the journey stopped reaching that step, which is
    // a behaviour change hiding as a missing row.
    if (b === undefined || c === undefined) {
      missing.push(step);
      console.log(
        `| \`${step}\` | ${b === undefined ? "absent" : b.toFixed(0) + "ms"} | ` +
          `${c === undefined ? "absent" : c.toFixed(0) + "ms"} | — | ⚠️ coverage differs |`
      );
      continue;
    }

    const change = b === 0 ? 0 : (c - b) / b;
    const regressed = change > tolerance;
    if (regressed) regressions.push(`${step}: ${b.toFixed(0)}ms -> ${c.toFixed(0)}ms (+${(change * 100).toFixed(0)}%)`);
    const arrow = change > 0 ? "+" : "";
    console.log(
      `| \`${step}\` | ${b.toFixed(0)}ms | ${c.toFixed(0)}ms | ${arrow}${(change * 100).toFixed(1)}% | ` +
        `${regressed ? "❌ REGRESSION" : change < -tolerance ? "✅ faster" : "ok"} |`
    );
  }

  // ── Correctness deltas ──
  // Checked separately and with ZERO tolerance. A run that got 10% faster while
  // starting to drop writes is not an improvement, and a percentage-based
  // comparison would never surface that.
  console.log();
  const correctness: string[] = [];
  for (const name of ["unexpected_errors", "sqlite_busy"]) {
    const b = counter(baseline, name);
    const c = counter(candidate, name);
    console.log(`${name}: ${b} -> ${c}`);
    if (c > b) correctness.push(`${name} rose from ${b} to ${c}`);
  }

  console.log();
  if (missing.length > 0) {
    console.log(`⚠️  ${missing.length} step(s) appear in only one run: ${missing.join(", ")}`);
  }
  if (correctness.length > 0) {
    console.log("❌ CORRECTNESS REGRESSION:");
    for (const item of correctness) console.log(`   - ${item}`);
  }
  if (regressions.length > 0) {
    console.log("❌ PERFORMANCE REGRESSION:");
    for (const item of regressions) console.log(`   - ${item}`);
  }
  if (regressions.length === 0 && correctness.length === 0) {
    console.log("✅ no regression beyond tolerance");
  }

  if (regressions.length > 0 || correctness.length > 0) process.exitCode = 1;
}

function readMeta(value: string | true | undefined): any {
  if (typeof value !== "string" || !value || !fs.existsSync(value)) return null;
  try {
    return JSON.parse(fs.readFileSync(value, "utf8"));
  } catch {
    return null;
  }
}

main();
