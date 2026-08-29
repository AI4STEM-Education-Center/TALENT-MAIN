/**
 * Pure display formatters for quiz statistics. They live outside `stats-ui.tsx`
 * so that file exports components only — a module mixing components with plain
 * values defeats Fast Refresh's ability to preserve component state.
 */

/** Round a 0-100 score for display. */
export const pct = (v: number): string => `${Math.round(v)}%`;

/** Format a 0-1 rate as a percentage. */
export const ratePct = (v: number): string => `${Math.round(v * 100)}%`;
