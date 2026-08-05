/**
 * In-container measurement probe. Loaded via NODE_OPTIONS=--require, never
 * imported by the app.
 *
 * Why this exists: src/lib/prisma.ts drives SQLite through better-sqlite3,
 * which is a *synchronous* binding. Prisma's adapter wraps it in promises, but
 * the query itself runs on the calling thread — so request concurrency in this
 * app does not buy database parallelism, it converts into event-loop queueing.
 * That makes event-loop delay the leading indicator for saturation, and it is
 * invisible from outside the process. HTTP latency alone will tell you the
 * system got slow without telling you why.
 *
 * Why a preload instead of an app route: an /api/... endpoint would be a new
 * production surface that ships in the image whether or not anyone is
 * benchmarking. This file is bind-mounted into the container by
 * benchmark/docker/docker-compose.bench.yml (and by the EC2 provisioner), so
 * the application image and source tree are completely untouched.
 *
 * Env:
 *   BENCH_PROBE_PORT  listen port (default 9464)
 *   BENCH_PROBE_HOST  bind address (default 0.0.0.0 — container-internal)
 *   BENCH_DB_PATH     SQLite file to report size/WAL growth for (optional)
 */

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const { monitorEventLoopDelay } = require("node:perf_hooks");

const PORT = Number(process.env.BENCH_PROBE_PORT || 9464);
const HOST = process.env.BENCH_PROBE_HOST || "0.0.0.0";
const DB_PATH = process.env.BENCH_DB_PATH || "";
const NS_PER_MS = 1e6;

// resolution:10 keeps the histogram cheap while still resolving the sub-50ms
// stalls that a handful of synchronous SQLite reads produce.
const histogram = monitorEventLoopDelay({ resolution: 10 });
histogram.enable();

const startedAt = Date.now();
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

/**
 * WAL size is the tell for write-lock pressure: it grows when readers keep a
 * checkpoint from completing, and a WAL that never truncates during a soak is a
 * finding in itself.
 */
function sqliteFiles() {
  if (!DB_PATH) return null;
  return {
    path: DB_PATH,
    dbBytes: fileSize(DB_PATH),
    walBytes: fileSize(`${DB_PATH}-wal`),
    shmBytes: fileSize(`${DB_PATH}-shm`),
  };
}

function snapshot() {
  const memory = process.memoryUsage();
  const now = Date.now();
  const cpu = process.cpuUsage();
  const wallMs = Math.max(1, now - lastCpuAt);
  // Percent of one core, averaged over the interval since the last scrape.
  const cpuPercent =
    ((cpu.user - lastCpu.user + (cpu.system - lastCpu.system)) / 1000 / wallMs) * 100;
  lastCpu = cpu;
  lastCpuAt = now;

  return {
    ok: true,
    pid: process.pid,
    role: process.env.BENCH_PROBE_ROLE || "web",
    atIso: new Date(now).toISOString(),
    uptimeS: Math.round((now - startedAt) / 1000),
    eventLoopDelayMs: {
      min: histogram.min / NS_PER_MS,
      mean: histogram.mean / NS_PER_MS,
      p50: histogram.percentile(50) / NS_PER_MS,
      p90: histogram.percentile(90) / NS_PER_MS,
      p99: histogram.percentile(99) / NS_PER_MS,
      max: histogram.max / NS_PER_MS,
      exceeds: histogram.exceeds,
    },
    cpuPercentOfCore: Math.round(cpuPercent * 10) / 10,
    memory: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
    },
    // A climbing handle count during a soak means sockets or file descriptors
    // are leaking; cheap to read, and there is no other window onto it.
    handles: {
      // eslint-disable-next-line no-underscore-dangle
      active: typeof process._getActiveHandles === "function" ? process._getActiveHandles().length : null,
      requests:
        // eslint-disable-next-line no-underscore-dangle
        typeof process._getActiveRequests === "function" ? process._getActiveRequests().length : null,
    },
    loadAvg: os.loadavg(),
    sqlite: sqliteFiles(),
  };
}

const server = http.createServer((req, res) => {
  const path = (req.url || "/").split("?")[0].replace(/\/+$/, "") || "/";
  const body = (() => {
    if (path === "/reset") {
      // Called between phases so warm-up stalls don't pollute steady-state
      // percentiles — the histogram is cumulative otherwise.
      histogram.reset();
      return { ok: true, reset: true };
    }
    return snapshot();
  })();

  const payload = JSON.stringify(body);
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
});

server.on("error", (error) => {
  // Never take the application down because the probe could not bind (e.g. two
  // processes sharing a port in a single-container setup).
  console.error(`[bench-probe] disabled: ${error.message}`);
});

server.listen(PORT, HOST, () => {
  console.log(`[bench-probe] listening on ${HOST}:${PORT}`);
});

// Do not let the probe's listener keep the process alive on shutdown.
server.unref();
