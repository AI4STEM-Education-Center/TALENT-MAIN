// Tiny presentation helper shared by the teacher/admin surfaces that display
// persisted AI-generation metrics (model + provider + timing + generated
// tokens). Kept free of server imports so client components can use it directly.

/**
 * Metrics for one streamed model call. Produced identically by both transports
 * (/v1/responses and /v1/chat/completions) via `computeCallMetrics`, so a
 * provider switching endpoints does not change what any of these numbers mean.
 */
export interface AiCallMetrics {
  /** The model id that produced the response. */
  model: string;
  /** Time from request start to the first content token, in ms. null if no content arrived. */
  ttftMs: number | null;
  /**
   * Completion tokens generated. Taken from the provider's reported usage when
   * available; otherwise an estimate from the count of streamed content deltas.
   */
  completionTokens: number;
  /** true when `completionTokens` is a streamed-delta estimate (provider gave no usage). */
  tokensEstimated: boolean;
  /** Total wall-clock time for the call, in ms. */
  totalMs: number;
  /**
   * The window the content streamed over, in ms — null when the response wasn't
   * delivered incrementally (a buffering gateway flushes every delta at once,
   * making that window a transport artifact rather than generation time). See
   * `isStreamedGenerationWindow`.
   */
  generationMs: number | null;
  /**
   * Mean generation rate, over `generationMs` when we observed one and over the
   * whole call when we didn't. null when no tokens were generated.
   */
  tokensPerSec: number | null;
}

/**
 * Derive the metrics for one streamed call from what the stream reported.
 *
 * Shared by both transports on purpose: TTFT is "time until the first visible
 * content token" and the token count is "whatever usage the provider reported,
 * else how many content deltas we saw" under either endpoint, so keeping the
 * arithmetic in one place is what lets a provider move between them without
 * shifting its numbers.
 */
export function computeCallMetrics(observed: {
  model: string;
  /** ms from request start to the first content delta; null if none arrived. */
  ttftMs: number | null;
  /** ms of wall clock for the whole call. */
  totalMs: number;
  /** Provider-reported output tokens, or null when it reported none. */
  usageTokens: number | null;
  /** Content deltas seen, used as the token estimate when usage is absent. */
  deltaCount: number;
}): AiCallMetrics {
  const { model, ttftMs, totalMs, usageTokens, deltaCount } = observed;
  const tokensEstimated = usageTokens === null;
  const completionTokens = usageTokens ?? deltaCount;
  // The post-TTFT window is only the generation window if the content really
  // arrived across it; a gateway that buffered the upstream stream flushes it
  // in a few ms, and dividing the token count by that yields nonsense rates.
  const streamedMs = ttftMs !== null ? Math.max(0, totalMs - ttftMs) : 0;
  const generationMs = isStreamedGenerationWindow(streamedMs, totalMs) ? streamedMs : null;
  const rateWindowMs = generationMs ?? totalMs;
  const tokensPerSec =
    completionTokens > 0 && rateWindowMs > 0 ? completionTokens / (rateWindowMs / 1000) : null;

  return { model, ttftMs, completionTokens, tokensEstimated, totalMs, generationMs, tokensPerSec };
}

export interface DisplayAiMetrics {
  model?: string | null;
  /**
   * Provider the call went through ("openai" | "local" | "cloudflare"), stored
   * separately from the model because a gateway's model id carries its own
   * vendor prefix (Cloudflare serves "openai/gpt-5.5"), so the model string
   * alone can't say who served it. null on rows written before this was
   * persisted — those keep rendering their model string exactly as before.
   */
  provider?: string | null;
  /** Service tier this model is assigned in AI config ("flex" | "auto" | "default"). */
  serviceTier?: string | null;
  /**
   * Reasoning effort the call was made with, when the model has one pinned in
   * AI config. null/absent means no `reasoning_effort` was sent at all.
   */
  thinkingLevel?: string | null;
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
 * Smallest share of a call's wall-clock time the post-TTFT window has to cover
 * before we treat it as the model's generation window.
 *
 * A response only has an observable generation window if its content actually
 * arrived over time. Cloudflare's AI Gateway buffers the upstream SSE stream
 * and hands us every delta at once, so the post-TTFT window measures the flush
 * (tens of ms) while the tokens were really produced during the wait we
 * recorded as TTFT — and for reasoning models `completion_tokens` includes
 * reasoning tokens emitted before any content delta at all. Dividing the whole
 * token count by that sliver is what reported 222 tokens at 6937 tok/s.
 *
 * The two cases separate cleanly rather than needing a tuned threshold: a
 * genuinely streamed call spends nearly all of itself streaming (a 755s
 * extraction streamed for 735s, 97%), a buffered one well under 1%.
 */
export const MIN_GENERATION_SHARE = 0.1;

/**
 * True when `genMs` is a large enough share of the whole call to be the model's
 * generation window rather than a transport flush. See MIN_GENERATION_SHARE.
 */
export function isStreamedGenerationWindow(genMs: number, totalMs: number): boolean {
  return genMs > 0 && genMs >= totalMs * MIN_GENERATION_SHARE;
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
 * "gpt-4o-mini · via openai · tier flex · TTFT 240ms · gen 5.685s · total 25.123s · 512 tokens · 90.1 tok/s".
 *
 * Generation time defaults to total minus TTFT, while multi-call callers can
 * supply their summed generation window explicitly. Either way it is only shown
 * when the response actually streamed over that window (see
 * MIN_GENERATION_SHARE); when it didn't, "gen" is omitted rather than reporting
 * a transport artifact, and the rate falls back to the whole call — the only
 * window we can honestly attribute the tokens to.
 *
 * Omits any missing field and returns "" when nothing is available (callers
 * should then render nothing).
 */
export function formatAiMetrics({
  model,
  provider,
  serviceTier,
  thinkingLevel,
  ttftMs,
  generationMs,
  totalMs,
  tokens,
  tokensEstimated,
}: DisplayAiMetrics): string {
  const window =
    generationMs != null
      ? generationMs
      : ttftMs != null && totalMs != null
        ? Math.max(0, totalMs - ttftMs)
        : null;
  // Without a total there is nothing to weigh the window against, so trust it
  // (legacy rows that stored only a generation window).
  const genMs =
    window == null
      ? null
      : totalMs == null || isStreamedGenerationWindow(window, totalMs)
        ? window
        : null;
  const rateWindowMs = genMs ?? totalMs;
  const tokensPerSec =
    tokens != null && rateWindowMs != null && rateWindowMs > 0
      ? tokens / (rateWindowMs / 1000)
      : null;

  return [
    model || null,
    provider ? `via ${provider}` : null,
    serviceTier ? `tier ${serviceTier}` : null,
    thinkingLevel ? `think ${thinkingLevel}` : null,
    ttftMs != null ? `TTFT ${formatMs(ttftMs)}` : null,
    genMs != null ? `gen ${formatMs(genMs)}` : null,
    totalMs != null ? `total ${formatMs(totalMs)}` : null,
    tokens != null ? `${tokens}${tokensEstimated ? "~" : ""} tokens` : null,
    tokensPerSec != null ? `${tokensPerSec.toFixed(1)} tok/s` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
