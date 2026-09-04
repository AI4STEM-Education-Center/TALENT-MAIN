// Pure quiz-statistics helpers for the teacher analytics pages. No DB / Next /
// LLM imports, so this is unit-testable like the other `src/lib/*` pure
// modules. The stats API routes feed these arrays of numbers/attempt records;
// the rendering is done entirely with built-in UI (stat cards, CSS bars).

/** Score at or above this percentage counts as a pass. Mirrors the student UI. */
export const PASS_THRESHOLD = 60;

/** Arithmetic mean, or 0 for an empty list. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Median, or 0 for an empty list. Averages the middle pair for even counts. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Minimum, or 0 for an empty list. */
export function min(values: number[]): number {
  return values.length === 0 ? 0 : Math.min(...values);
}

/** Maximum, or 0 for an empty list. */
export function max(values: number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

/** Population standard deviation, or 0 for an empty list. */
export function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const m = mean(values);
  const variance = mean(values.map((v) => (v - m) ** 2));
  return Math.sqrt(variance);
}

/** Fraction (0-1) of values at or above PASS_THRESHOLD, or 0 for an empty list. */
export function passRate(
  values: number[],
  threshold: number = PASS_THRESHOLD,
): number {
  if (values.length === 0) return 0;
  return values.filter((v) => v >= threshold).length / values.length;
}

/**
 * Average attempts per student ("avg retakes"). `attemptCounts` is one entry per
 * student = how many completed attempts that student made. Returns 0 when empty.
 */
export function averageAttemptsPerStudent(attemptCounts: number[]): number {
  return mean(attemptCounts);
}

/** A single score-distribution bucket: an inclusive label + count. */
export type DistributionBucket = {
  label: string;
  min: number;
  max: number;
  count: number;
};

/**
 * Bucket scores into five 20-point bands (0-20, 20-40, 40-60, 60-80, 80-100).
 * Bands are lower-inclusive / upper-exclusive except the top band, which
 * includes 100. A value outside 0-100 is clamped into the nearest band.
 */
export function scoreDistribution(values: number[]): DistributionBucket[] {
  const buckets: DistributionBucket[] = [
    { label: "0–20", min: 0, max: 20, count: 0 },
    { label: "20–40", min: 20, max: 40, count: 0 },
    { label: "40–60", min: 40, max: 60, count: 0 },
    { label: "60–80", min: 60, max: 80, count: 0 },
    { label: "80–100", min: 80, max: 100, count: 0 },
  ];
  for (const v of values) {
    const clamped = Math.min(Math.max(v, 0), 100);
    // 80-100 is the catch-all top band (includes exactly 100).
    const index = clamped >= 80 ? 4 : Math.floor(clamped / 20);
    buckets[index].count += 1;
  }
  return buckets;
}
