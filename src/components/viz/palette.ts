/**
 * Shared vocabulary for the chart components.
 *
 * The colour values themselves live in `.viz-root` in globals.css — this module
 * only names the slots, so a component asks for "series 2" or "the band this
 * rate falls in" and never writes a hex. The categorical slots are assigned in
 * fixed order and never cycled: a series keeps its hue no matter how many other
 * series are on screen, and a filter that removes one must not repaint the rest.
 *
 * The palette is validated (colourblind separation, lightness band, contrast)
 * against every design direction's card surface in both modes. On light
 * surfaces three of the five slots fall below 3:1, which is allowed only with
 * "relief": a visible label or a table view. Every component here ships one.
 */

/** Categorical slots, in the order they must be assigned. */
export const SERIES_VARS = [
  "--viz-series-1",
  "--viz-series-2",
  "--viz-series-3",
  "--viz-series-4",
  "--viz-series-5",
] as const;

/** The colour for a series index, in assignment order. */
export function seriesColor(index: number): string {
  return `var(${SERIES_VARS[index % SERIES_VARS.length]})`;
}

/**
 * How a 0–1 rate reads. Status colours are reserved and never double as a
 * categorical slot; each band carries a word as well as a hue, because on a
 * light surface `warning` is deliberately below 3:1 and must never be the only
 * thing saying "this went badly".
 */
export type ScoreBand = {
  id: "strong" | "developing" | "weak";
  label: string;
  color: string;
};

export const SCORE_BANDS: Record<ScoreBand["id"], ScoreBand> = {
  strong: { id: "strong", label: "Strong", color: "var(--viz-good)" },
  developing: { id: "developing", label: "Developing", color: "var(--viz-warning)" },
  weak: { id: "weak", label: "Needs work", color: "var(--viz-critical)" },
};

/** Thresholds match the ones the teacher stats already used (0.75 / 0.5). */
export function scoreBand(rate: number): ScoreBand {
  if (rate >= 0.75) return SCORE_BANDS.strong;
  if (rate >= 0.5) return SCORE_BANDS.developing;
  return SCORE_BANDS.weak;
}

/** Sequential ramp for magnitude. Index 0 is nearest the surface. */
export const SEQUENTIAL_VARS = [
  "--viz-seq-100",
  "--viz-seq-250",
  "--viz-seq-400",
  "--viz-seq-550",
  "--viz-seq-700",
] as const;

/**
 * A step of the sequential ramp for a 0–1 magnitude. `ordinal` starts at step
 * 250 instead of 100 — discrete ordered marks must stay visible against the
 * surface, where a continuous heatmap's lightest step is allowed to recede.
 */
export function sequentialColor(magnitude: number, ordinal = false): string {
  const floor = ordinal ? 1 : 0;
  const span = SEQUENTIAL_VARS.length - 1 - floor;
  const step = floor + Math.round(Math.min(Math.max(magnitude, 0), 1) * span);
  return `var(${SEQUENTIAL_VARS[step]})`;
}
