// Tiny presentation helper shared by the teacher/admin surfaces that display
// persisted AI-generation metrics (model + TTFT + generated tokens). Kept free
// of server imports so client components can use it directly.

export interface DisplayAiMetrics {
  model?: string | null;
  ttftMs?: number | null;
  tokens?: number | null;
}

/**
 * Format AI-generation metrics as a single compact line, e.g.
 * "gpt-4o-mini · TTFT 240ms · 512 tokens". Omits any missing field and returns
 * "" when nothing is available (callers should then render nothing).
 */
export function formatAiMetrics({ model, ttftMs, tokens }: DisplayAiMetrics): string {
  return [
    model || null,
    ttftMs != null ? `TTFT ${ttftMs}ms` : null,
    tokens != null ? `${tokens} tokens` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
