// Tiny presentation helper shared by the teacher/admin surfaces that display
// persisted AI-generation metrics (model + timing + generated tokens). Kept free
// of server imports so client components can use it directly.

export interface DisplayAiMetrics {
  model?: string | null;
  /** Time to first token, ms. */
  ttftMs?: number | null;
  /** Generation window, ms. Takes precedence over total - TTFT when present. */
  generationMs?: number | null;
  /** Total wall-clock time for the call(s), ms. */
  totalMs?: number | null;
  tokens?: number | null;
  /** true when `tokens` is a streamed-delta estimate (renders a "~" suffix). */
  tokensEstimated?: boolean | null;
}

/**
 * Format a duration for display: seconds with 3 decimals once past one second
 * (e.g. 19438 -> "19.438s"), otherwise whole milliseconds ("240ms").
 */
export function formatMs(ms: number): string {
  return ms > 1000 ? `${(ms / 1000).toFixed(3)}s` : `${Math.round(ms)}ms`;
}

/**
 * Format AI-generation metrics as a single compact line, e.g.
 * "gpt-4o-mini · TTFT 240ms · gen 5.685s · total 25.123s · 512 tokens · 90.1 tok/s".
 *
 * Generation time defaults to total minus TTFT, while multi-call callers can
 * supply their summed generation window explicitly. The token rate is derived
 * from the displayed token count and generation window.
 *
 * Omits any missing field and returns "" when nothing is available (callers
 * should then render nothing).
 */
export function formatAiMetrics({
  model,
  ttftMs,
  generationMs,
  totalMs,
  tokens,
  tokensEstimated,
}: DisplayAiMetrics): string {
  const genMs =
    generationMs != null
      ? generationMs
      : ttftMs != null && totalMs != null
        ? Math.max(0, totalMs - ttftMs)
        : null;
  const tokensPerSec = tokens != null && genMs != null && genMs > 0 ? tokens / (genMs / 1000) : null;

  return [
    model || null,
    ttftMs != null ? `TTFT ${formatMs(ttftMs)}` : null,
    genMs != null ? `gen ${formatMs(genMs)}` : null,
    totalMs != null ? `total ${formatMs(totalMs)}` : null,
    tokens != null ? `${tokens}${tokensEstimated ? "~" : ""} tokens` : null,
    tokensPerSec != null ? `${tokensPerSec.toFixed(1)} tok/s` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
