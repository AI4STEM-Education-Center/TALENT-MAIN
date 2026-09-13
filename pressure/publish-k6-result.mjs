#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { publishResult, saveResult } from "./lib/results.mjs";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
}

function stats(metric) {
  if (!metric || typeof metric !== "object") return {};
  return metric.values && typeof metric.values === "object"
    ? metric.values
    : metric;
}

const summaryPath = argument("summary");
const metaPath = argument("meta");
const outputPath = argument("out");
if (!summaryPath || !metaPath || !outputPath) {
  throw new Error(
    "Usage: publish-k6-result.mjs --summary summary.json --meta meta.json --out result.json",
  );
}

const summary = readJson(summaryPath);
const meta = readJson(metaPath);
const metrics = summary.metrics ?? {};
const duration = stats(metrics.http_req_duration);
const requests = stats(metrics.http_reqs);
const failed = stats(metrics.http_req_failed);
const unexpected = stats(metrics.unexpected_errors).count;
const busy = stats(metrics.sqlite_busy).count;
const thresholdFailures = [];
for (const [metricName, metric] of Object.entries(metrics)) {
  for (const [threshold, state] of Object.entries(metric.thresholds ?? {})) {
    const didFail =
      typeof state === "boolean" ? state === false : state?.ok === false;
    if (didFail) thresholdFailures.push(`${metricName} ${threshold}`);
  }
}

// react-doctor-disable-next-line react-doctor/no-impure-call-at-module-scope -- one-shot result normalizer uses current time only as fallback for legacy artifacts without timestamps
const startedAt =
  meta.startedAt ??
  new Date(Date.now() - (summary.state?.testRunDurationMs ?? 0)).toISOString();
// react-doctor-disable-next-line react-doctor/no-impure-call-at-module-scope -- one-shot result normalizer uses current time only as fallback for legacy artifacts without timestamps
const finishedAt = meta.finishedAt ?? new Date().toISOString();
const failures = [
  ...(unexpected > 0 ? [{ name: "unexpected_errors", count: unexpected }] : []),
  ...(busy > 0 ? [{ name: "sqlite_busy", count: busy }] : []),
  ...thresholdFailures.map((name) => ({ name })),
];
const failedChecks = Math.round(
  (unexpected ?? 0) + (busy ?? 0) + thresholdFailures.length,
);
const result = {
  schemaVersion: 1,
  runId: meta.runId ?? meta.label,
  startedAt,
  finishedAt,
  environment: "ec2-clone",
  suite: "pressure",
  scenario: meta.scenario ?? "unknown",
  status:
    failures.length === 0 && unexpected !== undefined && busy !== undefined
      ? "PASS"
      : "FAIL",
  source: "local-aws-cli",
  commitSha: process.env.GIT_SHA || null,
  branch: process.env.GIT_BRANCH || null,
  targetUrl: null,
  durationMs: Math.max(0, Math.round(summary.state?.testRunDurationMs ?? 0)),
  totalChecks: Math.round(requests.count ?? 0),
  passedChecks: Math.max(0, Math.round((requests.count ?? 0) - failedChecks)),
  failedChecks,
  latency: {
    p50Ms: duration.med ?? null,
    p95Ms: duration["p(95)"] ?? null,
    p99Ms: duration["p(99)"] ?? null,
    maxMs: duration.max ?? null,
  },
  requestRate: requests.rate ?? null,
  virtualUsers: Number(meta.studentTarget ?? meta.cohort ?? 0) || null,
  errorRate: failed.rate ?? null,
  metadata: meta,
  metrics: {
    requests: requests.count ?? null,
    unexpectedErrors: unexpected ?? null,
    sqliteBusy: busy ?? null,
    designedRefusals: stats(metrics.designed_refusals).count ?? 0,
  },
  failures,
};

const saved = saveResult(result, outputPath);
console.log(`Normalized pressure result -> ${saved}`);
await publishResult(result);
if (result.status === "FAIL") process.exitCode = 1;
