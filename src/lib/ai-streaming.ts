// Shared streaming-completion helper. Every AI call in the app routes through
// here so we (a) always stream the response and (b) capture the same two
// metrics everywhere: time-to-first-token (TTFT) and the number of generated
// tokens. Cloud providers report `usage.completion_tokens` on the final chunk
// (when `stream_options.include_usage` is set); local OpenAI-compatible servers
// usually don't, so we fall back to counting streamed content deltas and flag
// the count as estimated.

import type OpenAI from "openai";
import { isStreamedGenerationWindow } from "./ai-metrics";

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

/** One tool call the model asked for, reassembled from its streamed deltas. */
export interface StreamedToolCall {
  id: string;
  name: string;
  /** Raw JSON-encoded arguments exactly as the model emitted them. */
  arguments: string;
}

export interface StreamedCompletion {
  /** Concatenated assistant content across every chunk. */
  text: string;
  /**
   * Tool calls the model requested, in index order. Always empty unless the
   * caller passed `tools` in the params. Text and tool calls are not exclusive:
   * some models narrate before calling.
   */
  toolCalls: StreamedToolCall[];
  /** The provider's `finish_reason` for the choice, when it reported one. */
  finishReason: string | null;
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
  /**
   * Receives the accumulated text after each content delta. Callers can use
   * this to forward partial output to their own persistence/transport layer.
   * Awaited intentionally so a caller can apply backpressure (for example,
   * while writing a throttled checkpoint).
   */
  onContent?: (text: string, delta: string) => void | Promise<void>;
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
  let finishReason: string | null = null;
  // Tool-call deltas arrive fragmented and out of order across chunks; the
  // per-choice `index` is the only stable key, so accumulate by it and flatten
  // in index order at the end.
  const toolCallParts = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const chunk of stream) {
    // The usage block rides on the final chunk when include_usage is set; some
    // providers also attach a running usage to every chunk — last write wins.
    const usage = (chunk as { usage?: { completion_tokens?: number } | null }).usage;
    if (usage && typeof usage.completion_tokens === "number") {
      usageTokens = usage.completion_tokens;
    }

    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;

    for (const part of choice?.delta?.tool_calls ?? []) {
      const existing = toolCallParts.get(part.index) ?? { id: "", name: "", arguments: "" };
      if (part.id) existing.id = part.id;
      if (part.function?.name) existing.name += part.function.name;
      if (part.function?.arguments) existing.arguments += part.function.arguments;
      toolCallParts.set(part.index, existing);
    }

    const content = choice?.delta?.content;
    if (content) {
      if (ttftMs === null) ttftMs = now() - start;
      text += content;
      deltaCount += 1;
      await options.onContent?.(text, content);
    }
  }

  const totalMs = now() - start;
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

  const toolCalls: StreamedToolCall[] = [...toolCallParts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call)
    .filter((call) => call.name !== "");

  return {
    text,
    toolCalls,
    finishReason,
    metrics: {
      model: params.model,
      ttftMs,
      completionTokens,
      tokensEstimated,
      totalMs,
      generationMs,
      tokensPerSec,
    },
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
 *
 * The summed generation window only survives if every call that produced
 * content actually streamed — one buffered call would make the sum understate
 * the job by however long that call spent generating unobserved.
 */
export function aggregateMetrics(parts: AiCallMetrics[]): AiCallMetrics | null {
  if (parts.length === 0) return null;

  const completionTokens = parts.reduce((sum, m) => sum + m.completionTokens, 0);
  const ttfts = parts.map((m) => m.ttftMs).filter((t): t is number => t !== null);
  const ttftMs = ttfts.length > 0 ? Math.round(ttfts.reduce((a, b) => a + b, 0) / ttfts.length) : null;
  const totalMs = parts.reduce((sum, m) => sum + m.totalMs, 0);
  // Calls that produced no content have no window to contribute and shouldn't
  // disqualify the sum; a contentful call with an unobservable window does.
  const contentful = parts.filter((m) => m.ttftMs !== null);
  const generationMs =
    contentful.length > 0 && contentful.every((m) => m.generationMs !== null)
      ? contentful.reduce((sum, m) => sum + (m.generationMs ?? 0), 0)
      : null;
  const rateWindowMs = generationMs ?? totalMs;
  const tokensPerSec =
    completionTokens > 0 && rateWindowMs > 0 ? completionTokens / (rateWindowMs / 1000) : null;
  const tokensEstimated = parts.some((m) => m.tokensEstimated);

  return {
    model: parts[0].model,
    ttftMs,
    completionTokens,
    tokensEstimated,
    totalMs,
    generationMs,
    tokensPerSec,
  };
}
