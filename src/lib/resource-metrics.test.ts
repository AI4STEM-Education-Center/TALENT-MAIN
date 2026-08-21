import { describe, it, expect } from "vitest";
import {
  bucketSamples,
  cpuPercentFromDelta,
  createCpuSampler,
  hostCpuPercentFromDelta,
  isResourceRange,
  parseCgroupCpuMax,
  parseCgroupCpuStat,
  parseInactiveFileBytes,
  parseMemInfoBytes,
  parseProcStatCpu,
  rangeConfig,
  type BucketableSample,
} from "./resource-metrics";

describe("cgroup parsing", () => {
  it("reads usage_usec out of a v2 cpu.stat", () => {
    const stat = ["usage_usec 123456", "user_usec 100000", "system_usec 23456"].join("\n");
    expect(parseCgroupCpuStat(stat)).toBe(123456);
  });

  it("returns null when cpu.stat has no usage line", () => {
    expect(parseCgroupCpuStat("nr_periods 0\nnr_throttled 0")).toBeNull();
  });

  it("turns a cpu.max quota into cores", () => {
    expect(parseCgroupCpuMax("200000 100000")).toBe(2);
    expect(parseCgroupCpuMax("50000 100000")).toBe(0.5);
  });

  it("treats an uncapped or malformed cpu.max as no limit", () => {
    // "max" means the container may use the whole host, so the caller falls
    // back to the host core count rather than pinning to 1.
    expect(parseCgroupCpuMax("max 100000")).toBeNull();
    expect(parseCgroupCpuMax("0 100000")).toBeNull();
    expect(parseCgroupCpuMax("garbage")).toBeNull();
  });

  it("finds inactive_file under either the v2 or the v1 name", () => {
    expect(parseInactiveFileBytes("anon 100\ninactive_file 4096\nslab 8")).toBe(4096);
    expect(parseInactiveFileBytes("total_inactive_file 8192")).toBe(8192);
    expect(parseInactiveFileBytes("anon 100")).toBe(0);
  });
});

describe("host /proc parsing", () => {
  // Docker does not namespace /proc, so a container reading these files is
  // reading the EC2 instance's own counters.
  const PROC_STAT = [
    "cpu  100 20 30 800 50 0 10 0 0 0",
    "cpu0 50 10 15 400 25 0 5 0 0 0",
    "intr 12345",
  ].join("\n");

  it("sums the aggregate cpu line and counts iowait as idle", () => {
    // A core blocked on the EBS volume is not consuming CPU; calling it busy
    // would make disk pressure look like compute pressure.
    expect(parseProcStatCpu(PROC_STAT)).toEqual({ totalJiffies: 1010, idleJiffies: 850 });
  });

  it("returns null when there is no aggregate line to read", () => {
    expect(parseProcStatCpu("cpu0 1 2 3 4 5\nintr 1")).toBeNull();
    expect(parseProcStatCpu("cpu  1 2\n")).toBeNull();
    expect(parseProcStatCpu("")).toBeNull();
  });

  it("reads meminfo in bytes and treats available (not free) as usable", () => {
    // A healthy Linux box spends every spare page on cache, so MemFree is
    // always near zero — using it would report the machine permanently full.
    const meminfo = ["MemTotal:        2028112 kB", "MemFree:           82340 kB", "MemAvailable:     996000 kB"].join("\n");
    expect(parseMemInfoBytes(meminfo)).toEqual({
      usedBytes: (2028112 - 996000) * 1024,
      totalBytes: 2028112 * 1024,
    });
  });

  it("falls back to MemFree on a kernel too old for MemAvailable", () => {
    const meminfo = "MemTotal:        1000 kB\nMemFree:          400 kB";
    expect(parseMemInfoBytes(meminfo)?.usedBytes).toBe(600 * 1024);
  });

  it("returns null for meminfo it cannot make sense of", () => {
    expect(parseMemInfoBytes("")).toBeNull();
    expect(parseMemInfoBytes("MemTotal:  0 kB\nMemFree: 0 kB")).toBeNull();
    expect(parseMemInfoBytes("MemTotal: 1000 kB")).toBeNull();
  });
});

describe("hostCpuPercentFromDelta", () => {
  it("reports the busy share of all cores together", () => {
    expect(hostCpuPercentFromDelta(1000, 750)).toBe(25);
    expect(hostCpuPercentFromDelta(1000, 0)).toBe(100);
  });

  it("reports null rather than 0 when there is nothing to diff", () => {
    // 0 would be a claim that the machine was idle; null says "unknown", which
    // the read model then skips instead of averaging in.
    expect(hostCpuPercentFromDelta(0, 0)).toBeNull();
    expect(hostCpuPercentFromDelta(-10, 5)).toBeNull();
  });
});

describe("cpuPercentFromDelta", () => {
  it("normalises by core count", () => {
    // One core fully busy for one second: 100% of a single-core node, 25% of
    // a four-core one.
    expect(cpuPercentFromDelta(1_000_000, 1000, 1)).toBe(100);
    expect(cpuPercentFromDelta(1_000_000, 1000, 4)).toBe(25);
  });

  it("clamps to 100 and refuses nonsense inputs", () => {
    expect(cpuPercentFromDelta(50_000_000, 1000, 1)).toBe(100);
    expect(cpuPercentFromDelta(1000, 0, 1)).toBe(0);
    expect(cpuPercentFromDelta(1000, 1000, 0)).toBe(0);
    // A counter that went backwards (process restart) reads as idle, not negative.
    expect(cpuPercentFromDelta(-5000, 1000, 1)).toBe(0);
  });
});

describe("createCpuSampler", () => {
  it("reports 0 on the first call, then real deltas", () => {
    let clock = 0;
    const sampler = createCpuSampler(() => clock);
    expect(sampler(1)).toBe(0); // nothing to diff against yet
    clock += 1000;
    expect(sampler(1)).toBeGreaterThanOrEqual(0);
    expect(sampler(1)).toBeLessThanOrEqual(100);
  });
});

describe("ranges", () => {
  it("validates the range parameter", () => {
    expect(isResourceRange("7d")).toBe(true);
    expect(isResourceRange("1y")).toBe(false);
    expect(isResourceRange(null)).toBe(false);
  });

  it("keeps every range under a few hundred chart points", () => {
    for (const range of ["1h", "24h", "7d"] as const) {
      const { windowMs, bucketMs } = rangeConfig(range);
      expect(windowMs / bucketMs).toBeLessThanOrEqual(360);
    }
  });
});

describe("bucketSamples", () => {
  const base = new Date("2026-08-17T00:00:00Z").getTime();
  const sample = (offsetMs: number, over: Partial<BucketableSample> = {}): BucketableSample => ({
    createdAt: new Date(base + offsetMs),
    cpuPercent: 10,
    memUsedBytes: 1000,
    memLimitBytes: 8000,
    dbBytes: 500,
    diskTotalBytes: 100_000,
    diskFreeBytes: 60_000,
    s3Bytes: null,
    ...over,
  });

  it("averages rates and keeps the bucket's peak CPU", () => {
    const points = bucketSamples(
      [sample(0, { cpuPercent: 10 }), sample(60_000, { cpuPercent: 90 })],
      10 * 60_000
    );
    expect(points).toHaveLength(1);
    expect(points[0].cpuPercent).toBe(50);
    // A wide bucket must not be able to hide a spike.
    expect(points[0].cpuPeakPercent).toBe(90);
  });

  it("takes the newest reading for levels, not an average", () => {
    const points = bucketSamples(
      [sample(0, { dbBytes: 100, diskFreeBytes: 90 }), sample(1000, { dbBytes: 300, diskFreeBytes: 50 })],
      60_000
    );
    expect(points[0].dbBytes).toBe(300);
    expect(points[0].diskFreeBytes).toBe(50);
  });

  it("carries the newest non-null s3Bytes so web-node rows do not blank it", () => {
    // Web nodes never scan the bucket, so their samples have s3Bytes null; a
    // naive "latest wins" would erase the worker's figure every other row.
    const points = bucketSamples(
      [sample(0, { s3Bytes: 4096 }), sample(1000, { s3Bytes: null })],
      60_000
    );
    expect(points[0].s3Bytes).toBe(4096);
  });

  it("groups by bucket start and returns them oldest first", () => {
    const points = bucketSamples(
      [sample(20 * 60_000), sample(0), sample(10 * 60_000)],
      10 * 60_000
    );
    expect(points.map((p) => p.t)).toEqual([base, base + 10 * 60_000, base + 20 * 60_000]);
  });

  it("handles an empty input and a zero bucket width", () => {
    expect(bucketSamples([], 60_000)).toEqual([]);
    expect(bucketSamples([sample(0)], 0)).toEqual([]);
  });

  it("averages the host readings it has and ignores the ones it does not", () => {
    // Every node reports the same machine, so averaging returns that agreed
    // figure — but a node that has just restarted has no host CPU delta yet and
    // reports null, which must not be averaged in as zero.
    const points = bucketSamples(
      [
        sample(0, { hostCpuPercent: 40, hostMemUsedBytes: 1000, hostCpuCores: 2 }),
        sample(1000, { hostCpuPercent: null, hostMemUsedBytes: null, hostCpuCores: null }),
        sample(2000, { hostCpuPercent: 60, hostMemUsedBytes: 1200, hostCpuCores: 2 }),
      ],
      60_000
    );
    expect(points[0].hostCpuPercent).toBe(50);
    expect(points[0].hostCpuPeakPercent).toBe(60);
    expect(points[0].hostMemUsedBytes).toBe(1200);
    expect(points[0].hostCpuCores).toBe(2);
  });

  it("reports null host figures when no sample in the bucket had any", () => {
    const points = bucketSamples([sample(0)], 60_000);
    expect(points[0].hostCpuPercent).toBeNull();
    expect(points[0].hostMemTotalBytes).toBeNull();
  });
});
