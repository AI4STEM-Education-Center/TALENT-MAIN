// The /v1/responses transport.
//
// Everything in the app builds chat-completion-shaped requests (`messages`,
// `tools[].function`, `image_url` parts) because that is the shape every
// OpenAI-compatible server understands. This module translates that shape into
// OpenAI's item-based Responses API and reads its typed event stream back into
// the same `StreamedCompletion` the chat-completions path returns, so callers
// never learn which endpoint answered.
//
// Only the request features this codebase actually sends are translated. An
// unsupported field is better as a loud gap here than a silently dropped
// parameter, so `toResponsesRequest` throws rather than guessing.

import type OpenAI from "openai";
import { computeCallMetrics } from "./ai-metrics";
// Type-only: the runtime dependency runs the other way (ai-streaming imports
// this module), so importing these as types keeps the cycle off the runtime.
import type { StreamedCompletion, StreamedToolCall, StreamOptions } from "./ai-streaming";

type ChatParams = Omit<
  OpenAI.Chat.Completions.ChatCompletionCreateParams,
  "stream" | "stream_options"
>;

type ResponsesParams = OpenAI.Responses.ResponseCreateParams;

/** A content part in the chat-completions shape we translate from. */
type ChatPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

/**
 * Chat-completions content is either a plain string or an array of parts.
 * Normalizing to parts first keeps the per-role translation below single-path.
 */
function toParts(content: unknown): ChatPart[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content as ChatPart[];
}

/** Translate user/system content parts into Responses input parts. */
function toInputContent(parts: ChatPart[]): OpenAI.Responses.ResponseInputContent[] {
  return parts.map((part) => {
    if (part.type === "image_url") {
      // Responses flattens the nested { image_url: { url } } object into a
      // plain string field, and requires `detail` rather than defaulting it.
      const detail = part.image_url.detail;
      return {
        type: "input_image",
        image_url: part.image_url.url,
        detail:
          detail === "low" || detail === "high" || detail === "original" ? detail : "auto",
      } satisfies OpenAI.Responses.ResponseInputImage;
    }
    return { type: "input_text", text: part.text };
  });
}

/**
 * Split `messages` into the Responses `instructions` string and `input` items.
 *
 * System/developer turns become `instructions` — Responses has no system role.
 * Assistant tool calls and their results become standalone `function_call` /
 * `function_call_output` items rather than fields hanging off a message, which
 * is the structural difference between the two APIs.
 */
export function toResponsesInput(messages: ChatParams["messages"]): {
  instructions: string | null;
  input: OpenAI.Responses.ResponseInput;
} {
  const instructions: string[] = [];
  const input: OpenAI.Responses.ResponseInput = [];

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      const text = toParts(message.content)
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      if (text) instructions.push(text);
      continue;
    }

    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      });
      continue;
    }

    if (message.role === "assistant") {
      const text = toParts(message.content)
        .map((part) => (part.type === "text" ? part.text : ""))
        .join("");
      // Narration that came alongside tool calls is kept, and precedes them so
      // the transcript reads in the order the model produced it. It goes in as
      // a plain-string message rather than an output_text item: the item form
      // is what the server *returns*, and carries an id and status that a
      // client-held transcript has no way to supply.
      if (text) input.push({ role: "assistant", content: text });
      for (const call of message.tool_calls ?? []) {
        if (call.type !== "function") continue;
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        });
      }
      continue;
    }

    if (message.role === "user") {
      input.push({ role: "user", content: toInputContent(toParts(message.content)) });
      continue;
    }

    throw new Error(`Unsupported message role for the Responses API: "${message.role}"`);
  }

  return { instructions: instructions.length > 0 ? instructions.join("\n\n") : null, input };
}

/** Translate `tools` from the nested chat-completions form to the flat one. */
function toResponsesTools(tools: ChatParams["tools"]): OpenAI.Responses.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => {
    if (tool.type !== "function") {
      throw new Error(`Unsupported tool type for the Responses API: "${tool.type}"`);
    }
    return {
      type: "function",
      name: tool.function.name,
      description: tool.function.description ?? null,
      parameters: (tool.function.parameters ?? {}) as Record<string, unknown>,
      // Chat completions defaults to non-strict; keep that rather than
      // tightening validation as a side effect of changing transport.
      strict: tool.function.strict ?? false,
    } satisfies OpenAI.Responses.FunctionTool;
  });
}

/** Translate `response_format: json_schema` into the `text.format` equivalent. */
function toResponsesText(
  responseFormat: ChatParams["response_format"]
): ResponsesParams["text"] | undefined {
  if (!responseFormat || responseFormat.type !== "json_schema") return undefined;
  const schema = responseFormat.json_schema as {
    name?: string;
    schema?: Record<string, unknown>;
    strict?: boolean | null;
    description?: string;
  };
  // A schema with no `schema` body is the "just give me JSON" case; Responses
  // spells that json_object, same as chat completions did.
  if (!schema?.schema) return { format: { type: "json_object" } };
  return {
    format: {
      type: "json_schema",
      name: schema.name ?? "response",
      schema: schema.schema,
      strict: schema.strict ?? false,
      ...(schema.description ? { description: schema.description } : {}),
    },
  };
}

/**
 * Translate a chat-completions request into its Responses equivalent.
 *
 * `store` is pinned false: this app has no use for server-side retention yet
 * (nothing passes `previous_response_id`), and student work should not sit in
 * OpenAI's storage as a side effect of a transport change.
 */
export function toResponsesRequest(params: ChatParams): ResponsesParams {
  const { instructions, input } = toResponsesInput(params.messages);

  const maxOutputTokens =
    params.max_completion_tokens ?? (params.max_tokens as number | null | undefined) ?? undefined;

  const toolChoice = params.tool_choice;
  if (toolChoice != null && typeof toolChoice !== "string") {
    throw new Error("Only string tool_choice values are supported on the Responses API");
  }

  return {
    model: params.model,
    input,
    ...(instructions ? { instructions } : {}),
    ...(maxOutputTokens != null ? { max_output_tokens: maxOutputTokens } : {}),
    ...(params.tools ? { tools: toResponsesTools(params.tools) } : {}),
    ...(toolChoice ? { tool_choice: toolChoice as ResponsesParams["tool_choice"] } : {}),
    ...(params.response_format ? { text: toResponsesText(params.response_format) } : {}),
    // reasoning_effort is a flat field on chat completions and a nested object
    // here — and unlike there, it is legal alongside function tools.
    ...(params.reasoning_effort ? { reasoning: { effort: params.reasoning_effort } } : {}),
    ...(params.service_tier ? { service_tier: params.service_tier as ResponsesParams["service_tier"] } : {}),
    store: false,
  };
}

/** Words an error uses to name the endpoint rather than the request body. */
const NAMES_THE_ENDPOINT = /\b(endpoint|path|route|url)\b/i;

/** Words an error uses to say a thing isn't there or isn't served. */
const CALLS_IT_ABSENT =
  /\b(unsupported|unknown|invalid)\b|\bnot\s+(supported|found|implemented|available)\b|\bdoes\s+not\s+exist\b/i;

/**
 * True when an error says this endpoint doesn't serve /v1/responses at all —
 * the signal to fall back to /chat/completions.
 *
 * A 404/405/501 is the plain case: the route is absent, which is how llama.cpp
 * and Ollama answer. Gateways that route before they authenticate use 400
 * instead — Cloudflare's compat endpoint answers
 * "Compatibility endpoint: responses is not supported." — so a 400 counts only
 * when it names the *endpoint* AND calls it absent. Requiring both halves is
 * what keeps a 400 about the request itself (a bad tool schema, a parameter the
 * model won't take) surfacing instead of silently re-running on the other
 * transport and hiding the real bug.
 *
 * A provider whose refusal is phrased some third way is not left broken: an
 * admin can pin "chat_completions" on it in AI Config.
 */
export function isResponsesUnsupported(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  if (status === 404 || status === 405 || status === 501) return true;
  if (status !== 400) return false;
  const message = error instanceof Error ? error.message : String(error);
  return NAMES_THE_ENDPOINT.test(message) && CALLS_IT_ABSENT.test(message);
}

/**
 * Run one streamed Responses call, returning the same shape the
 * chat-completions path returns.
 *
 * TTFT is the first `response.output_text.delta` — the first *visible* token,
 * matching the other transport exactly. Reasoning deltas are intentionally not
 * counted as content: they arrive before any answer text, and treating them as
 * first-token would report a TTFT the user never experienced.
 */
export async function streamResponsesCompletion(
  client: OpenAI,
  params: ChatParams,
  options: StreamOptions = {}
): Promise<StreamedCompletion> {
  const now = options.now ?? Date.now;
  const start = now();

  const stream = await client.responses.create(
    { ...toResponsesRequest(params), stream: true },
    options.requestOptions
  );

  let text = "";
  let deltaCount = 0;
  let ttftMs: number | null = null;
  let usageTokens: number | null = null;
  let incomplete = false;
  // Function calls arrive as items announced up front and filled in by argument
  // deltas; `output_index` is the stable key across both kinds of event.
  const calls = new Map<number, { id: string; name: string; arguments: string }>();

  for await (const event of stream) {
    switch (event.type) {
      case "response.output_text.delta": {
        if (!event.delta) break;
        if (ttftMs === null) ttftMs = now() - start;
        text += event.delta;
        deltaCount += 1;
        await options.onContent?.(text, event.delta);
        break;
      }

      case "response.output_item.added": {
        if (event.item.type === "function_call") {
          calls.set(event.output_index, {
            id: event.item.call_id,
            name: event.item.name,
            arguments: event.item.arguments ?? "",
          });
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const existing = calls.get(event.output_index);
        if (existing) existing.arguments += event.delta;
        break;
      }

      case "response.function_call_arguments.done": {
        // The terminal event carries the complete arguments string; prefer it
        // over our accumulation so a dropped delta can't corrupt the JSON.
        const existing = calls.get(event.output_index);
        if (existing && typeof event.arguments === "string") {
          existing.arguments = event.arguments;
        }
        break;
      }

      case "response.completed":
      case "response.incomplete": {
        const usage = event.response.usage;
        if (usage && typeof usage.output_tokens === "number") usageTokens = usage.output_tokens;
        if (event.type === "response.incomplete") incomplete = true;
        break;
      }

      case "response.failed": {
        const error = event.response.error;
        throw new Error(error?.message ?? "The Responses API reported a failed response");
      }

      case "error": {
        throw new Error(event.message ?? "The Responses API returned a stream error");
      }

      default:
        break;
    }
  }

  const toolCalls: StreamedToolCall[] = [...calls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, call]) => call)
    .filter((call) => call.name !== "");

  // Chat completions reports one of stop/length/tool_calls; map onto that so
  // callers reading `finishReason` see one vocabulary regardless of transport.
  const finishReason = toolCalls.length > 0 ? "tool_calls" : incomplete ? "length" : "stop";

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
