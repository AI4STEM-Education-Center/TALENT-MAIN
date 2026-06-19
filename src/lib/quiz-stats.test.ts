import { describe, it, expect } from "vitest";
import {
  mean,
  median,
  min,
  max,
  stdDev,
  passRate,
  averageAttemptsPerStudent,
  scoreDistribution,
  PASS_THRESHOLD,
} from "./quiz-stats";

describe("mean / median / min / max", () => {
  it("computes the mean", () => {
    expect(mean([10, 20, 30])).toBe(20);
    expect(mean([5])).toBe(5);
  });
  it("returns 0 for an empty list", () => {
    expect(mean([])).toBe(0);
    expect(median([])).toBe(0);
    expect(min([])).toBe(0);
    expect(max([])).toBe(0);
  });
  it("computes the median for odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2); // sorted: 1,2,3
    expect(median([1, 2, 3, 4])).toBe(2.5); // avg of 2 and 3
  });
  it("computes min and max", () => {
    expect(min([7, 2, 9])).toBe(2);
    expect(max([7, 2, 9])).toBe(9);
  });
});

describe("stdDev", () => {
  it("is 0 for identical values", () => {
    expect(stdDev([5, 5, 5])).toBe(0);
  });
  it("computes population standard deviation", () => {
    // values 2,4,4,4,5,5,7,9 → mean 5, popn variance 4, stddev 2
    expect(stdDev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });
  it("returns 0 for an empty list", () => {
    expect(stdDev([])).toBe(0);
  });
});

describe("passRate", () => {
  it("counts values at or above the threshold", () => {
    expect(passRate([60, 59, 100, 0])).toBe(0.5); // 60 and 100 pass
  });
  it("uses PASS_THRESHOLD (60) by default", () => {
    expect(PASS_THRESHOLD).toBe(60);
    expect(passRate([60])).toBe(1);
    expect(passRate([59])).toBe(0);
  });
  it("honors a custom threshold", () => {
    expect(passRate([70, 80, 90], 85)).toBeCloseTo(1 / 3);
  });
  it("returns 0 for an empty list", () => {
    expect(passRate([])).toBe(0);
  });
});

describe("averageAttemptsPerStudent", () => {
  it("averages the per-student attempt counts (avg retakes)", () => {
    expect(averageAttemptsPerStudent([1, 2, 3])).toBe(2);
    expect(averageAttemptsPerStudent([])).toBe(0);
  });
});

describe("scoreDistribution", () => {
  it("buckets into five 20-point bands", () => {
    const dist = scoreDistribution([0, 19, 20, 40, 59, 60, 79, 80, 100]);
    const counts = dist.map((b) => b.count);
    // 0-20: {0,19}=2 ; 20-40: {20}=1 ; 40-60: {40,59}=2 ; 60-80: {60,79}=2 ; 80-100: {80,100}=2
    expect(counts).toEqual([2, 1, 2, 2, 2]);
  });
  it("puts exactly 100 in the top band", () => {
    const dist = scoreDistribution([100]);
    expect(dist[4].count).toBe(1);
    expect(dist[4].label).toBe("80–100");
  });
  it("clamps out-of-range values into the nearest band", () => {
    const dist = scoreDistribution([-5, 150]);
    expect(dist[0].count).toBe(1); // -5 → 0-20
    expect(dist[4].count).toBe(1); // 150 → 80-100
  });
  it("returns all-zero buckets for an empty list", () => {
    expect(scoreDistribution([]).every((b) => b.count === 0)).toBe(true);
  });
});
