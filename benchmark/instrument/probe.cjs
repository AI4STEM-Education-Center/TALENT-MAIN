/**
 * Event-loop delay probe, loaded into the app process via
 * `NODE_OPTIONS=--require /app/benchmark-probe.cjs`.
 *
 * WHY THIS EXISTS. Event-loop delay is the leading indicator for this
 * architecture and it is INVISIBLE from outside the process. Every Prisma query
 * runs through better-sqlite3, a synchronous native binding (src/lib/prisma.ts),
 * so request concurrency turns into event-loop queueing rather than database
 * parallelism. bcryptjs (pure JS, cost 12) and CloudFront's RSA URL signing add
 * more synchronous CPU on the same thread. From the load generator all of that
 * looks like "requests got slower" with no way to tell a blocked loop apart from
 * a slow network, a slow disk, or a CPU-starved container.
 *
 * WHY A PRELOAD RATHER THAN AN ENDPOINT. An earlier design added an
 * `/api/_perf` route to the app. That is a permanent new production surface —
 * one more authenticated-or-not endpoint to reason about — added purely for
 * benchmarking. Loading this file with --require gets the same data and ships
 * NOTHING in the production image: the file is bind-mounted only for a benchmark
 * run, so the app's attack surface is unchanged and there is no dead code left
 * behind afterwards.
 *
 * It listens on its own port, bound to loopback by default, and serves:
 *   GET /probe   -> JSON snapshot of the histogram plus process counters
 *   POST /reset  -> zero the histogram (called between scenario phases)
 *
 * CommonJS (.cjs) because --require cannot load an ES module.
 */

"use strict";

const http = require("node:http");
const { monitorEventLoopDelay, PerformanceObserver, constants } = require("node:perf_hooks");
const v8 = require("node:v8");

const PORT = Number(process.env.BENCH_PROBE_PORT || 9099);
const HOST = process.env.BENCH_PROBE_HOST || "127.0.0.1";
// 10ms resolution: fine enough to see a stall that matters, coarse enough that
// the histogram's own sampling is not a measurable cost on the loop it measures.
const RESOLUTION_MS = Number(process.env.BENCH_PROBE_RESOLUTION_MS || 10);

const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
histogram.enable();

let startedAt = Date.now();

// ─── GC accounting ───────────────────────────────────────────────────────────
// Worth separating out because this deployment gives Node a large memory
// footprint per process (a 64 MiB SQLite page cache plus a 256 MiB mmap window,
// four containers, no memory limits in either compose file). A long
// mark-sweep pause and a blocked event loop look identical in request latency,
// and the fix for each is completely different.
const gc = { count: 0, totalMs: 0, maxMs: 0, byKind: {} };
const GC_KIND_NAMES = {
  [constants.NODE_PERFORMANCE_GC_MINOR]: "minor",
  [constants.NODE_PERFORMANCE_GC_MAJOR]: "major",
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL]: "incremental",
  [constants.NODE_PERFORMANCE_GC_WEAKCB]: "weakcb",
};

try {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      gc.count++;
      gc.totalMs += entry.duration;
      if (entry.duration > gc.maxMs) gc.maxMs = entry.duration;
      const kind = GC_KIND_NAMES[entry.detail && entry.detail.kind] || "other";
      gc.byKind[kind] = (gc.byKind[kind] || 0) + 1;
    }
  });
  observer.observe({ entryTypes: ["gc"] });
} catch (err) {
  // GC entries are best-effort; never take the app down for a probe.
  console.error(`[probe] GC observer unavailable: ${err && err.message}`);
}

function nsToMs(value) {
  // The histogram reports nanoseconds. Rounding to 0.01ms keeps the JSON small
  // without losing anything meaningful at a 10ms resolution.
  return Math.round((value / 1e6) * 100) / 100;
}

function snapshot() {
  const memory = process.memoryUsage();
  const heap = v8.getHeapStatistics();
  return {
    // Identify WHICH process answered. All four containers can run the probe,
    // and a snapshot with no provenance is unattributable in a report.
    node: {
      appEnv: process.env.APP_ENV || null,
      // Parenthesised deliberately: `a || b ? c : d` groups as `(a || b) ? c : d`,
      // so the unparenthesised version reported EVERY process as "worker" the
      // moment BENCH_PROBE_ROLE was set at all — which made the report attribute
      // the web tier's event-loop delay to the worker. The env var is the
      // authoritative answer; the argv sniff is only a fallback for a process
      // started without it.
      role:
        process.env.BENCH_PROBE_ROLE ||
        ((process.argv[1] || "").includes("worker") ? "worker" : "web"),
      pid: process.pid,
      nodeVersion: process.version,
    },
    windowMs: Date.now() - startedAt,
    eventLoopDelayMs: {
      min: nsToMs(histogram.min),
      mean: nsToMs(histogram.mean),
      p50: nsToMs(histogram.percentile(50)),
      p90: nsToMs(histogram.percentile(90)),
      p95: nsToMs(histogram.percentile(95)),
      p99: nsToMs(histogram.percentile(99)),
      max: nsToMs(histogram.max),
      // `exceeds` counts how many samples the histogram had to drop; a non-zero
      // value means the loop was blocked longer than the histogram could record,
      // so the percentiles above are an UNDERSTATEMENT.
      exceeds: histogram.exceeds,
      resolutionMs: RESOLUTION_MS,
    },
    gc: {
      count: gc.count,
      totalMs: Math.round(gc.totalMs * 100) / 100,
      maxMs: Math.round(gc.maxMs * 100) / 100,
      byKind: gc.byKind,
    },
    memory: {
      rssMb: Math.round(memory.rss / 1048576),
      heapUsedMb: Math.round(memory.heapUsed / 1048576),
      heapTotalMb: Math.round(memory.heapTotal / 1048576),
      externalMb: Math.round(memory.external / 1048576),
      // ArrayBuffers are where better-sqlite3's buffers and the S3/PDF paths
      // live, so this moving independently of the heap is a useful signal.
      arrayBuffersMb: Math.round(memory.arrayBuffers / 1048576),
      heapLimitMb: Math.round(heap.heap_size_limit / 1048576),
    },
    cpuUsage: process.cpuUsage(),
    uptimeSec: Math.round(process.uptime()),
  };
}

const server = http.createServer((req, res) => {
  const url = req.url || "/";
  if (req.method === "POST" && url.startsWith("/reset")) {
    histogram.reset();
    gc.count = 0;
    gc.totalMs = 0;
    gc.maxMs = 0;
    for (const key of Object.keys(gc.byKind)) delete gc.byKind[key];
    startedAt = Date.now();
    res.writeHead(204).end();
    return;
  }
  if (url.startsWith("/probe")) {
    const body = JSON.stringify(snapshot());
    res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  res.writeHead(404).end();
});

// unref() so the probe's listening socket can never be the reason the app
// process refuses to exit — a benchmark tool must not change shutdown behaviour.
server.listen(PORT, HOST, () => {
  console.log(`[probe] event-loop probe on http://${HOST}:${PORT}/probe (resolution ${RESOLUTION_MS}ms)`);
});
server.unref();

server.on("error", (err) => {
  // A port clash must not crash the app. Two containers sharing a network
  // namespace is the common case; the second one simply has no probe.
  console.error(`[probe] disabled: ${err && err.message}`);
});
