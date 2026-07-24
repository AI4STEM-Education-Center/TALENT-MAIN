// Shared streaming-completion helper. Every AI call in the app routes through
// here so we (a) always stream the response and (b) capture the same two
// metrics everywhere: time-to-first-token (TTFT) and the number of generated
// tokens. Cloud providers report `usage.completion_tokens` on the final chunk
// (when `stream_options.include_usage` is set); local OpenAI-compatible servers
// usually don't, so we fall back to counting streamed content deltas and flag
// the count as estimated.

import type OpenAI from "openai";

export interface AiCallMetrics {
  /** The model id that produced the response. */
  model: string;
  /** Time from request start to the first content token, in ms. null if no content arrived. */
  ttftMs: number | null;
  /**
   * Completion tokens generated. Taken from the provider's `usage` when
   * available; otherwise an estimate from the count of streamed content deltas.
   */
  completionTokens: number;
  /** true when `completionTokens` is a streamed-delta estimate (provider gave no usage). */
  tokensEstimated: boolean;
  /** Total wall-clock time for the call, in ms. */
  totalMs: number;
  /** Mean generation rate over the streaming window, or null when not derivable. */
  tokensPerSec: number | null;
}

export interface StreamedCompletion {
  /** Concatenated assistant content across every chunk. */
  text: string;
  metrics: AiCallMetrics;
}

type BaseParams = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParams,
  "stream" | "stream_options"
>;

export interface StreamOptions {
  /** Forwarded to the SDK call (e.g. `{ maxRetries: 0 }` for local providers). */
  requestOptions?: { maxRetries?: number };
  /**
   * Ask for `stream_options.include_usage` so the provider reports token usage
   * on the final chunk. Safe for hosted OpenAI/Cloudflare; omit for local
   * servers that reject the unknown field.
   */
  includeUsage?: boolean;
  /** Injectable clock (ms). Defaults to Date.now; used by tests for deterministic timing. */
  now?: () => number;
}

/**
 * Run one streaming chat completion, accumulating the full text while measuring
 * TTFT and the generated-token count. Returns the assembled text + metrics.
 */
export async function streamChatCompletion(
  client: OpenAI,
  params: BaseParams,
  options: StreamOptions = {}
): Promise<StreamedCompletion> {
  const now = options.now ?? Date.now;
  const start = now();

  const stream = await client.chat.completions.create(
    {
      ...params,
      stream: true,
      ...(options.includeUsage ? { stream_options: { include_usage: true } } : {}),
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
    options.requestOptions
  );

  let text = "";
  let deltaCount = 0;
  let ttftMs: number | null = null;
  let usageTokens: number | null = null;

  for await (const chunk of stream) {
    // The usage block rides on the final chunk when include_usage is set; some
    // providers also attach a running usage to every chunk — last write wins.
    const usage = (chunk as { usage?: { completion_tokens?: number } | null }).usage;
    if (usage && typeof usage.completion_tokens === "number") {
      usageTokens = usage.completion_tokens;
    }

    const content = chunk.choices?.[0]?.delta?.content;
    if (content) {
      if (ttftMs === null) ttftMs = now() - start;
      text += content;
      deltaCount += 1;
    }
  }

  const totalMs = now() - start;
  const tokensEstimated = usageTokens === null;
  const completionTokens = usageTokens ?? deltaCount;
  const genMs = ttftMs !== null ? totalMs - ttftMs : 0;
  const tokensPerSec =
    completionTokens > 0 && genMs > 0 ? completionTokens / (genMs / 1000) : null;

  return {
    text,
    metrics: { model: params.model, ttftMs, completionTokens, tokensEstimated, totalMs, tokensPerSec },
  };
}

/** Extract the first balanced-looking JSON object from a free-text response. */
export function parseFirstJsonObject<T = unknown>(content: string): T {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found in model response");
  return JSON.parse(match[0]) as T;
}

export interface StreamedJson<T> extends StreamedCompletion {
  value: T;
}

/**
 * Streaming structured-output call. Prefers a strict `json_schema` response
 * format; if the provider rejects `response_format` (some local models do),
 * retries ONCE as a plain streamed completion and parses the JSON out of the
 * text. Returns the parsed value alongside the same TTFT/token metrics.
 * Throws on an empty response (callers decide whether that is fatal).
 */
export async function streamJsonCompletion<T = unknown>(
  client: OpenAI,
  baseParams: Omit<BaseParams, "response_format">,
  jsonSchema: unknown,
  options: StreamOptions = {}
): Promise<StreamedJson<T>> {
  const withSchema: BaseParams = {
    ...baseParams,
    response_format: { type: "json_schema", json_schema: jsonSchema },
  } as BaseParams;

  let result: StreamedCompletion;
  try {
    result = await streamChatCompletion(client, withSchema, options);
  } catch (schemaErr) {
    console.warn(
      "[AI] Schema-constrained streaming call failed; retrying once without response_format:",
      schemaErr instanceof Error ? schemaErr.message : schemaErr
    );
    result = await streamChatCompletion(client, baseParams as BaseParams, options);
  }

  if (!result.text.trim()) throw new Error("Model returned an empty response");

  let value: T;
  try {
    value = JSON.parse(result.text) as T;
  } catch {
    value = parseFirstJsonObject<T>(result.text);
  }

  return { ...result, value };
}

/**
 * Combine per-call metrics from a multi-call job (e.g. one VLM call per page)
 * into a single representative row for display/storage: tokens summed, TTFT
 * averaged across the calls that produced content, and the rate recomputed over
 * the summed generation window. Returns null when there is nothing to report.
 */
export function aggregateMetrics(parts: AiCallMetrics[]): AiCallMetrics | null {
  if (parts.length === 0) return null;

  const completionTokens = parts.reduce((sum, m) => sum + m.completionTokens, 0);
  const ttfts = parts.map((m) => m.ttftMs).filter((t): t is number => t !== null);
  const ttftMs = ttfts.length > 0 ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null;
  const totalMs = parts.reduce((sum, m) => sum + m.totalMs, 0);
  const genMs = parts.reduce((sum, m) => sum + (m.ttftMs !== null ? m.totalMs - m.ttftMs : 0), 0);
  const tokensPerSec = completionTokens > 0 && genMs > 0 ? completionTokens / (genMs / 1000) : null;
  const tokensEstimated = parts.some((m) => m.tokensEstimated);

  return { model: parts[0].model, ttftMs, completionTokens, tokensEstimated, totalMs, tokensPerSec };
}
