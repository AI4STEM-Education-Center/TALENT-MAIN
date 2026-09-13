// Shared streaming-completion helper. Every AI call in the app routes through
// here so we (a) always stream the response and (b) capture the same two
// metrics everywhere: time-to-first-token (TTFT) and the number of generated
// tokens. Cloud providers report their usage on the final chunk (for chat
// completions, when `stream_options.include_usage` is set); local
// OpenAI-compatible servers usually don't, so we fall back to counting streamed
// content deltas and flag the count as estimated.
//
// Two transports sit behind this module — /v1/responses and
// /v1/chat/completions — chosen per provider by `options.surface`. Callers build
// chat-completion-shaped params either way; `ai-responses.ts` translates them
// when the Responses path is taken. Both produce `AiCallMetrics` through the
// same `computeCallMetrics`, so the numbers mean the same thing on both.

import type OpenAI from "openai";
import { computeCallMetrics, type AiCallMetrics } from "./ai-metrics";
import { isResponsesUnsupported, streamResponsesCompletion } from "./ai-responses";
import type { ApiSurface, ResolvedProvider } from "./ai-provider";

// Defined in ai-metrics so both transports (and client components) can share
// it; re-exported here because every caller imports it from this module.
export type { AiCallMetrics };

/**
 * What the streaming layer needs to know about the provider behind a call.
 *
 * The three settings are always derived from the same provider and always
 * applied to the same request, so they travel together — callers that thread
 * transport details down to a helper pass one value instead of three.
 */
export interface AiTransport {
  /** Local servers get no usage opt-in and no SDK-level retries. */
  isLocal: boolean;
  surface: ApiSurface;
  /** Base URL, used to scope what the Responses fallback has learned. */
  surfaceKey: string | null;
}

export function transportFor(
  provider: Pick<ResolvedProvider, "providerType" | "apiSurface" | "baseUrl">
): AiTransport {
  return {
    isLocal: provider.providerType === "local",
    surface: provider.apiSurface,
    surfaceKey: provider.baseUrl,
  };
}

/**
 * The stream options implied by a transport. `extra` overrides them, which is
 * how the admin connection test opts out of retries.
 */
export function streamOptionsFor(
  transport: AiTransport,
  extra: StreamOptions = {}
): StreamOptions {
  return {
    includeUsage: !transport.isLocal,
    requestOptions: { maxRetries: transport.isLocal ? 0 : 3 },
    surface: transport.surface,
    ...(transport.surfaceKey ? { surfaceKey: transport.surfaceKey } : {}),
    ...extra,
  };
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
   * Which endpoint to call. Defaults to "chat_completions" so an unannotated
   * call keeps its old behaviour; every real caller passes the resolved
   * provider's `apiSurface`. A "responses" call that the endpoint does not
   * implement falls back automatically — see `streamChatCompletion`.
   */
  surface?: ApiSurface;
  /**
   * Identifies the endpoint for the fallback memo, so one provider learning
   * that /v1/responses is absent doesn't teach every other provider the same.
   * Defaults to the client's own base URL.
   */
  surfaceKey?: string;
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
 * Run one streaming call over /v1/chat/completions, accumulating the full text
 * while measuring TTFT and the generated-token count.
 */
async function streamViaChatCompletions(
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

  const toolCalls: StreamedToolCall[] = [...toolCallParts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call)
    .filter((call) => call.name !== "");

  return {
    text,
    toolCalls,
    finishReason,
    metrics: computeCallMetrics({
      model: params.model,
      ttftMs,
      totalMs: now() - start,
      usageTokens,
      deltaCount,
    }),
  };
}

/**
 * Endpoints already known not to serve /v1/responses, keyed by base URL.
 *
 * Local servers answer 404 there, and paying that round trip before every call
 * would tax each page of a PDF extraction. The memo is per process, so a server
 * that gains Responses support is picked up on the next restart rather than
 * being written off permanently.
 */
const noResponsesSupport = new Set<string>();

/** Exported for tests — clears what the fallback has learned this process. */
export function resetSurfaceMemo(): void {
  noResponsesSupport.clear();
}

/**
 * Run one streaming model call on whichever endpoint the provider is set to,
 * accumulating the full text while measuring TTFT and the generated-token
 * count. Returns the assembled text + metrics, identically shaped either way.
 *
 * A provider set to "responses" whose endpoint doesn't implement it falls back
 * to /chat/completions and is remembered. The fallback is only safe because the
 * "not found" answer arrives before any event does: once content has streamed,
 * re-running the call would duplicate it in the caller's UI, so a failure after
 * that point is rethrown rather than retried.
 */
export async function streamChatCompletion(
  client: OpenAI,
  params: BaseParams,
  options: StreamOptions = {}
): Promise<StreamedCompletion> {
  const surface = options.surface ?? "chat_completions";
  const key = options.surfaceKey ?? client.baseURL ?? "default";

  if (surface !== "responses" || noResponsesSupport.has(key)) {
    return streamViaChatCompletions(client, params, options);
  }

  let streamed = false;
  try {
    return await streamResponsesCompletion(client, params, {
      ...options,
      onContent: async (text, delta) => {
        streamed = true;
        await options.onContent?.(text, delta);
      },
    });
  } catch (error) {
    if (streamed || !isResponsesUnsupported(error)) throw error;
    console.warn(
      `[AI] ${key} does not serve /v1/responses; using /chat/completions for the rest of this process.`
    );
    noResponsesSupport.add(key);
    return streamViaChatCompletions(client, params, options);
  }
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
