// The assistant's tool-calling loop.
//
// One turn = repeated streaming chat completions until the model stops asking
// for tools (or the configured round budget runs out), with every tool call
// dispatched to a hand-written handler from the skill registry. The model never
// gets to run code or compose a query: it picks a tool name, the arguments are
// validated by that tool's zod schema, and the handler decides what to read.
//
// Output is pushed to the caller through `emit` as it happens, so the API route
// can forward it as NDJSON without buffering the answer.

import type OpenAI from "openai";
import { z } from "zod";
import {
  resolveProvider,
  createOpenAIClient,
  thinkingParams,
  type ThinkingParams,
} from "@/lib/ai-provider";
import {
  streamChatCompletion,
  streamOptionsFor,
  transportFor,
  aggregateMetrics,
  type AiCallMetrics,
  type StreamedToolCall,
} from "@/lib/ai-streaming";
import { logSystemEvent } from "@/lib/system-log";
import { buildUserContent, type DecodedAttachment } from "./attachments";
import type { ReplayedAttachment } from "./attachment-store";
import { buildSystemPrompt } from "./prompt";
import { resolveSkills } from "./skills";
import type { AssistantSettings } from "./config";
import {
  AUDIENCE_USE_CASE,
  type AssistantStreamEvent,
  type AssistantTool,
  type AssistantToolContext,
  type AssistantTurn,
} from "./types";

/** Cap on the model's reply length per round. Generous for a chat answer. */
const MAX_REPLY_TOKENS = 1_500;

/** Longest single user message accepted, in characters. */
export const MAX_MESSAGE_CHARS = 4_000;

/** Longest tool result handed back to the model, in characters. */
const MAX_TOOL_RESULT_CHARS = 24_000;

export type AssistantTurnInput = {
  settings: AssistantSettings;
  ctx: AssistantToolContext;
  /** Prior transcript, oldest first. Trimmed to `settings.maxHistoryMessages`. */
  history: AssistantTurn[];
  message: string;
  attachments: DecodedAttachment[];
  /**
   * Server-side notes prepended to the user turn — currently the attachments
   * that were dropped. Told to the model so it can mention them rather than
   * silently answering as if the file had been read.
   */
  notices: string[];
  /**
   * Re-reads the attachments a prior turn referenced by id, so an image can
   * still be discussed several turns later. Injected rather than imported so the
   * loop stays storage-free (and testable without a bucket); omitted, history
   * replays as text plus filenames.
   */
  loadHistoryAttachments?: (
    ids: string[],
    limit: number,
  ) => Promise<ReplayedAttachment[]>;
  emit: (event: AssistantStreamEvent) => void | Promise<void>;
  /** Aborted when the client disconnects; stops the loop between rounds. */
  signal?: AbortSignal;
};

export type AssistantTurnResult = {
  text: string;
  metrics: AiCallMetrics | null;
  toolCallCount: number;
};

type ChatMessages = OpenAI.Chat.Completions.ChatCompletionMessageParam[];

/**
 * The JSON Schema advertised for a tool, derived from its zod schema so the
 * advertised contract and the runtime validation can never drift. `$schema` is
 * stripped: OpenAI accepts it but several local servers reject unknown keys.
 */
export function toolParameterSchema(
  tool: AssistantTool,
): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input, {
    target: "draft-7",
    io: "input",
  }) as Record<string, unknown>;
  delete schema.$schema;
  // An empty zod object emits no `properties`; providers expect the key present.
  if (!schema.properties) schema.properties = {};
  return schema;
}

function toolDefinitions(
  tools: Map<string, AssistantTool>,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return [...tools.values()].map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toolParameterSchema(tool),
    },
  }));
}

/** Serialize a tool result for the model, truncating rather than blowing the context. */
function serializeResult(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify({
      error: "Tool returned a value that could not be serialized.",
    });
  }
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return JSON.stringify({
    truncated: true,
    note: `Result was too large and was cut off at ${MAX_TOOL_RESULT_CHARS} characters. Narrow the request with more specific filters.`,
    partial: text.slice(0, MAX_TOOL_RESULT_CHARS),
  });
}

/**
 * True for the provider's "pick one" 400: several hosted reasoning models take
 * `reasoning_effort` or function tools on /v1/chat/completions, but not both,
 * and answer with a 400 pointing at /v1/responses. The assistant is the only
 * caller in the app that sends tools, so a thinking level pinned on its use
 * case in AI Config fails every turn rather than degrading — which is why the
 * turn drops the field and retries instead of surfacing the error.
 */
function rejectsToolsWithThinking(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ((error as { status?: unknown }).status !== 400) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /reasoning_effort/i.test(message) && /tool/i.test(message);
}

/**
 * Run one tool call. Every failure path — unknown name, unparseable arguments,
 * schema violation, handler throw — becomes an error *result* rather than an
 * exception, so the model can see what went wrong and correct itself instead of
 * the turn dying.
 */
async function runToolCall(
  call: StreamedToolCall,
  tools: Map<string, AssistantTool>,
  ctx: AssistantToolContext,
): Promise<{ content: string; ok: boolean }> {
  const tool = tools.get(call.name);
  if (!tool) {
    return {
      ok: false,
      content: JSON.stringify({
        error: `Unknown tool "${call.name}". Available tools: ${[...tools.keys()].join(", ")}.`,
      }),
    };
  }

  let rawArgs: unknown;
  try {
    rawArgs = call.arguments.trim() ? JSON.parse(call.arguments) : {};
  } catch {
    return {
      ok: false,
      content: JSON.stringify({
        error: "Arguments were not valid JSON. Send a JSON object.",
      }),
    };
  }

  const parsed = tool.input.safeParse(rawArgs);
  if (!parsed.success) {
    return {
      ok: false,
      content: JSON.stringify({
        error: "Arguments did not match the tool's schema.",
        issues: parsed.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      }),
    };
  }

  try {
    return {
      ok: true,
      content: serializeResult(await tool.handler(parsed.data, ctx)),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void logSystemEvent({
      category: "API",
      type: "ASSISTANT_TOOL_FAILED",
      severity: "ERROR",
      message: `Assistant tool "${call.name}" failed: ${message}`,
      userId: ctx.userId,
      metadata: { audience: ctx.audience, tool: call.name },
    });
    // The message is ours (thrown by our own handlers), not a raw driver error.
    return { ok: false, content: JSON.stringify({ error: message }) };
  }
}

/**
 * Map the client-supplied transcript into API messages, newest `limit` turns
 * only, re-attaching stored files where the loader can find them.
 *
 * `attachmentBudget` caps how many files the WHOLE replay may carry, and the
 * newest turns claim it first. Without that ceiling every turn in a long
 * conversation would re-send every image it ever contained, so the cost of the
 * next question would climb with the length of the chat; with it, replaying
 * history never costs more than sending those files once.
 */
async function historyMessages(
  history: AssistantTurn[],
  limit: number,
  attachmentBudget: number,
  load?: (ids: string[], limit: number) => Promise<ReplayedAttachment[]>,
): Promise<ChatMessages> {
  const turns = history.slice(-limit);

  const replayIds: string[] = [];
  if (load && attachmentBudget > 0) {
    // Newest first, so the budget goes to the files most likely being discussed.
    for (
      let i = turns.length - 1;
      i >= 0 && replayIds.length < attachmentBudget;
      i -= 1
    ) {
      const turn = turns[i];
      if (turn.role !== "user") continue;
      for (const id of turn.attachmentIds ?? []) {
        if (replayIds.length >= attachmentBudget) break;
        replayIds.push(id);
      }
    }
  }

  const replayed =
    replayIds.length > 0 && load ? await load(replayIds, attachmentBudget) : [];
  const byId = new Map(
    replayed.map((attachment) => [attachment.id, attachment]),
  );

  return turns.map((turn) => {
    // Filenames are listed even for files that came back, so the model can tell
    // which image belongs to which turn — and so a file that expired or failed
    // to load still reads as "they attached something" rather than vanishing.
    const labels = turn.attachmentNames?.length
      ? `\n[attached: ${turn.attachmentNames.join(", ")}]`
      : "";
    const text = `${turn.content}${labels}`.slice(0, MAX_MESSAGE_CHARS + 200);

    const attachments = (turn.attachmentIds ?? [])
      .map((id) => byId.get(id))
      .filter(
        (attachment): attachment is ReplayedAttachment =>
          attachment !== undefined,
      );

    if (turn.role === "user" && attachments.length > 0) {
      return {
        role: "user",
        content: buildUserContent(text, attachments) as never,
      };
    }
    return { role: turn.role, content: text };
  });
}

/**
 * Run one assistant turn to completion. Resolves with the final text; the
 * incremental deltas and tool activity have already gone out through `emit`.
 * Returns null-ish results rather than throwing for the expected failures
 * (no provider configured, no reply) — the caller reports those to the user.
 */
export async function runAssistantTurn(
  input: AssistantTurnInput,
): Promise<AssistantTurnResult> {
  const { settings, ctx, emit, signal } = input;

  const provider = await resolveProvider(AUDIENCE_USE_CASE[ctx.audience]);
  if (!provider) {
    await emit({
      type: "error",
      message:
        "This assistant has no AI model assigned yet. An administrator needs to set one in AI Config.",
    });
    return { text: "", metrics: null, toolCallCount: 0 };
  }

  const { skills, tools } = resolveSkills(
    ctx.audience,
    settings.enabledSkills,
    settings.disabledTools,
  );
  const client = await createOpenAIClient(provider);
  // The endpoint the admin picked for this provider, plus the local-server
  // exceptions — the same value every other engine streams through. Building it
  // by hand here is what used to pin the assistant to /chat/completions, where a
  // reasoning model refuses to take function tools at all.
  const transport = transportFor(provider);
  const isLocal = transport.isLocal;

  const userText = [
    ...input.notices.map((notice) => `[system note: ${notice}]`),
    input.message,
  ]
    .filter(Boolean)
    .join("\n");

  const messages: ChatMessages = [
    {
      role: "system",
      content: buildSystemPrompt(
        ctx.audience,
        skills,
        [...tools.keys()],
        settings.extraInstructions,
      ),
    },
    ...(await historyMessages(
      input.history,
      settings.maxHistoryMessages,
      settings.maxAttachments,
      input.loadHistoryAttachments,
    )),
    {
      role: "user",
      content: buildUserContent(userText, input.attachments) as never,
    },
  ];

  const definitions = toolDefinitions(tools);
  const parts: AiCallMetrics[] = [];
  let finalText = "";
  let toolCallCount = 0;

  // No-op unless the assigned model has a thinking level pinned on the use case
  // in AI config; applies to hosted and local assistants alike. Cleared for the
  // rest of the turn if the provider refuses it alongside tools.
  let thinking = thinkingParams(provider);

  // One extra round beyond maxToolCalls, with tools withheld, guarantees the
  // user gets prose even if the model would have kept calling tools forever.
  for (let round = 0; round <= settings.maxToolCalls; round += 1) {
    if (signal?.aborted) break;

    const offerTools = definitions.length > 0 && round < settings.maxToolCalls;

    const runRound = (effort: ThinkingParams) =>
      streamChatCompletion(
        client,
        {
          model: provider.model,
          messages,
          ...(offerTools
            ? { tools: definitions, tool_choice: "auto" as const }
            : {}),
          max_completion_tokens: !isLocal ? MAX_REPLY_TOKENS : undefined,
          max_tokens: isLocal ? MAX_REPLY_TOKENS : undefined,
          service_tier:
            !isLocal &&
            provider.serviceTier &&
            ["auto", "default", "flex"].includes(provider.serviceTier)
              ? (provider.serviceTier as "auto" | "default" | "flex")
              : undefined,
          ...effort,
        },
        streamOptionsFor(transport, {
          onContent: async (_text, delta) => {
            await emit({ type: "delta", text: delta });
          },
        }),
      );

    let result;
    try {
      result = await runRound(thinking);
    } catch (error) {
      // The 400 lands before the stream opens, so nothing has been emitted yet
      // and the round is safe to replay without the thinking level.
      if (
        !offerTools ||
        !thinking.reasoning_effort ||
        !rejectsToolsWithThinking(error)
      ) {
        throw error;
      }
      void logSystemEvent({
        category: "API",
        type: "ASSISTANT_THINKING_LEVEL_DROPPED",
        severity: "WARNING",
        message: `${provider.model} rejects reasoning_effort alongside tools; answering without it.`,
        userId: ctx.userId,
        metadata: {
          audience: ctx.audience,
          model: provider.model,
          thinkingLevel: thinking.reasoning_effort,
        },
      });
      thinking = {};
      result = await runRound(thinking);
    }

    parts.push(result.metrics);
    finalText += result.text;

    if (result.toolCalls.length === 0) break;

    messages.push({
      role: "assistant",
      content: result.text || null,
      tool_calls: result.toolCalls.map((call) => ({
        // Some providers omit the id on the first delta; the model only needs it
        // to match our tool message back, so a synthesized one is fine.
        id: call.id || `call_${round}_${call.name}`,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    for (const call of result.toolCalls) {
      const label = tools.get(call.name)?.activityLabel ?? call.name;
      await emit({ type: "tool", name: call.name, label, status: "running" });
      const outcome = await runToolCall(call, tools, ctx);
      toolCallCount += 1;
      await emit({
        type: "tool",
        name: call.name,
        label,
        status: outcome.ok ? "done" : "error",
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id || `call_${round}_${call.name}`,
        content: outcome.content,
      });
    }

    // A round that produced narration alongside its tool calls has already
    // streamed that text; separate it from the next round's prose.
    if (result.text) finalText += "\n\n";
  }

  const metrics = aggregateMetrics(parts);

  if (!finalText.trim()) {
    await emit({
      type: "error",
      message:
        "The model returned an empty response. Try rephrasing your question.",
    });
  } else {
    await emit({
      type: "done",
      model: provider.model,
      provider: provider.providerType,
      serviceTier: provider.serviceTier,
      // What the turn actually ran with, not what was configured.
      thinkingLevel: thinking.reasoning_effort ?? null,
      ttftMs: metrics?.ttftMs ?? null,
      generationMs: metrics?.generationMs ?? null,
      totalMs: metrics?.totalMs ?? null,
      tokens: metrics?.completionTokens ?? 0,
      tokensEstimated: metrics?.tokensEstimated ?? true,
    });
  }

  return { text: finalText, metrics, toolCallCount };
}
