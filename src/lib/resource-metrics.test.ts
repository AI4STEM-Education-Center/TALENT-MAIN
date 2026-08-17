import { describe, it, expect } from "vitest";
import {
  bucketSamples,
  cpuPercentFromDelta,
  createCpuSampler,
  isResourceRange,
  parseCgroupCpuMax,
  parseCgroupCpuStat,
  parseInactiveFileBytes,
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
});
