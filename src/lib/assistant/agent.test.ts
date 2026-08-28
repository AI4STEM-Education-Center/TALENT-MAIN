import { describe, it, expect, beforeEach, vi } from "vitest";

// Only the DB/network-backed entry points are stubbed; the pure helpers (e.g.
// thinkingParams) stay real so the request-shaping assertions below exercise
// the same code the app runs.
vi.mock("@/lib/ai-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-provider")>()),
  resolveProvider: vi.fn(),
  createOpenAIClient: vi.fn(),
}));

import { runAssistantTurn, toolParameterSchema } from "./agent";
import { defaultSettings } from "./config";
import { listSkills } from "./skills";
import { resolveProvider, createOpenAIClient } from "@/lib/ai-provider";
import { resetSurfaceMemo } from "@/lib/ai-streaming";
import type { ResolvedProvider } from "@/lib/ai-provider";
import type { AssistantStreamEvent, AssistantToolContext } from "./types";

const mockResolve = vi.mocked(resolveProvider);
const mockClient = vi.mocked(createOpenAIClient);

const provider: ResolvedProvider = {
  providerType: "openai",
  baseUrl: null,
  apiKey: "k",
  model: "gpt-test",
  serviceTier: null,
  thinkingLevel: null,
  cfAigByokAlias: null,
  timeoutMs: 1000,
  apiSurface: "chat_completions",
};

const studentCtx: AssistantToolContext = {
  userId: "user-1",
  audience: "student",
  studentId: "student-1",
  teacherId: null,
};

/** A streamed round: text deltas, then optional tool calls. */
type Round = { text?: string; toolCalls?: Array<{ name: string; args: string }> };

function chunksFor(round: Round) {
  const chunks: unknown[] = [];
  for (const char of round.text ?? "") {
    chunks.push({ choices: [{ delta: { content: char } }] });
  }
  (round.toolCalls ?? []).forEach((call, index) => {
    chunks.push({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index,
                id: `call-${index}`,
                function: { name: call.name, arguments: call.args },
              },
            ],
          },
        },
      ],
    });
  });
  chunks.push({
    choices: [{ delta: {}, finish_reason: round.toolCalls?.length ? "tool_calls" : "stop" }],
    usage: { completion_tokens: 7 },
  });
  return chunks;
}

/** Fake OpenAI client that plays back one scripted round per call. */
function fakeClient(rounds: Round[]) {
  const calls: Array<Record<string, unknown>> = [];
  let index = 0;
  const client = {
    chat: {
      completions: {
        create: vi.fn(async (params: Record<string, unknown>) => {
          calls.push(params);
          const round = rounds[Math.min(index, rounds.length - 1)];
          index += 1;
          return {
            async *[Symbol.asyncIterator]() {
              for (const chunk of chunksFor(round)) yield chunk;
            },
          };
        }),
      },
    },
  };
  return { client, calls };
}

async function run(
  rounds: Round[],
  overrides: Partial<ReturnType<typeof defaultSettings>> = {},
  providerOverrides: Partial<typeof provider> = {}
) {
  const { client, calls } = fakeClient(rounds);
  mockResolve.mockResolvedValue({ ...provider, ...providerOverrides });
  mockClient.mockResolvedValue(client as never);

  const events: AssistantStreamEvent[] = [];
  const result = await runAssistantTurn({
    settings: { ...defaultSettings("student"), ...overrides },
    ctx: studentCtx,
    history: [],
    message: "how did I do?",
    attachments: [],
    notices: [],
    emit: (event) => {
      events.push(event);
    },
  });
  return { result, events, calls };
}

beforeEach(() => {
  mockResolve.mockReset();
  mockClient.mockReset();
  // The Responses fallback is memoised per base URL across calls.
  resetSurfaceMemo();
});

describe("runAssistantTurn — API surface", () => {
  it("streams through the endpoint the provider is set to, not always /chat/completions", async () => {
    // Reasoning models refuse function tools on /chat/completions, so an
    // assistant hard-wired to that surface cannot answer at all once a thinking
    // level is pinned — which is why the surface has to come from the provider.
    const create = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: "response.output_text.delta", delta: "hello" };
        yield { type: "response.completed", response: { usage: { output_tokens: 3 } } };
      },
    }));
    mockResolve.mockResolvedValue({ ...provider, apiSurface: "responses" });
    // A Responses-only client: no `chat` at all, so falling back would throw.
    mockClient.mockResolvedValue({ responses: { create } } as never);

    const result = await runAssistantTurn({
      settings: defaultSettings("student"),
      ctx: studentCtx,
      history: [],
      message: "how did I do?",
      attachments: [],
      notices: [],
      emit: () => {},
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.text).toBe("hello");
  });
});

describe("runAssistantTurn — provider resolution", () => {
  it("reports a missing assignment instead of throwing", async () => {
    mockResolve.mockResolvedValue(null);
    const events: AssistantStreamEvent[] = [];
    const result = await runAssistantTurn({
      settings: defaultSettings("student"),
      ctx: studentCtx,
      history: [],
      message: "hi",
      attachments: [],
      notices: [],
      emit: (event) => {
        events.push(event);
      },
    });
    expect(result.text).toBe("");
    expect(events).toEqual([
      { type: "error", message: expect.stringContaining("no AI model assigned") },
    ]);
  });

  it("resolves the student assistant's own use case", async () => {
    await run([{ text: "hello" }]);
    expect(mockResolve).toHaveBeenCalledWith("student_assistant");
  });

  it("omits reasoning_effort entirely when the model has no thinking level", async () => {
    const { calls } = await run([{ text: "hello" }]);
    expect(calls[0]).not.toHaveProperty("reasoning_effort");
  });

  it("sends the model's thinking level as reasoning_effort when one is set", async () => {
    const { calls } = await run([{ text: "hello" }], {}, { thinkingLevel: "high" });
    expect(calls[0].reasoning_effort).toBe("high");
  });

  it("sends the thinking level for local providers too", async () => {
    const { calls } = await run(
      [{ text: "hello" }],
      {},
      { providerType: "local" as const, baseUrl: "http://localhost:1234/v1", thinkingLevel: "low" }
    );
    expect(calls[0].reasoning_effort).toBe("low");
  });
});

describe("runAssistantTurn — plain answer", () => {
  it("streams each delta and finishes with a done event", async () => {
    const { result, events } = await run([{ text: "hi!" }]);
    expect(result.text).toBe("hi!");
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text)).toEqual([
      "h",
      "i",
      "!",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      model: "gpt-test",
      provider: "openai",
      serviceTier: null,
      thinkingLevel: null,
      tokens: 7,
    });
  });

  it("stops after one round when the model asks for no tools", async () => {
    const { calls } = await run([{ text: "hi" }]);
    expect(calls).toHaveLength(1);
  });

  it("reports an empty model response as an error rather than an empty bubble", async () => {
    const { events } = await run([{ text: "" }]);
    expect(events).toEqual([{ type: "error", message: expect.stringContaining("empty response") }]);
  });
});

describe("runAssistantTurn — tool calls", () => {
  it("advertises the enabled skill's tools and dispatches one", async () => {
    const { result, events, calls } = await run([
      { toolCalls: [{ name: "search_quiz_results", args: "{}" }] },
      { text: "You have no results yet." },
    ]);

    const advertised = (calls[0].tools as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name
    );
    expect(advertised).toContain("search_quiz_results");

    expect(events.filter((e) => e.type === "tool")).toEqual([
      { type: "tool", name: "search_quiz_results", label: "Searching your quiz results", status: "running" },
      { type: "tool", name: "search_quiz_results", label: "Searching your quiz results", status: "done" },
    ]);
    expect(result.toolCallCount).toBe(1);
    expect(result.text).toBe("You have no results yet.");
  });

  it("feeds the tool result back as a tool message on the next round", async () => {
    const { calls } = await run([
      { toolCalls: [{ name: "search_quiz_results", args: "{}" }] },
      { text: "done" },
    ]);
    const second = calls[1].messages as Array<{ role: string; content: unknown }>;
    expect(second.at(-1)).toMatchObject({ role: "tool" });
    expect(String(second.at(-1)?.content)).toContain("totalMatches");
  });

  it("returns an error result — not a thrown turn — for an unknown tool name", async () => {
    const { events, calls } = await run([
      { toolCalls: [{ name: "run_shell", args: "{}" }] },
      { text: "I can't do that." },
    ]);
    expect(events).toContainEqual({
      type: "tool",
      name: "run_shell",
      label: "run_shell",
      status: "error",
    });
    const second = calls[1].messages as Array<{ role: string; content: string }>;
    expect(second.at(-1)?.content).toContain("Unknown tool");
  });

  it("rejects arguments that violate the tool's schema and tells the model why", async () => {
    const { calls } = await run([
      { toolCalls: [{ name: "search_quiz_results", args: '{"limit": 5000}' }] },
      { text: "retrying" },
    ]);
    const second = calls[1].messages as Array<{ role: string; content: string }>;
    expect(second.at(-1)?.content).toContain("did not match the tool's schema");
  });

  it("rejects unparseable arguments", async () => {
    const { calls } = await run([
      { toolCalls: [{ name: "search_quiz_results", args: "{not json" }] },
      { text: "retrying" },
    ]);
    const second = calls[1].messages as Array<{ role: string; content: string }>;
    expect(second.at(-1)?.content).toContain("not valid JSON");
  });
});

describe("runAssistantTurn — loop bounds", () => {
  it("withholds tools on the final round so a looping model still answers", async () => {
    // Every scripted round asks for the same tool; the last call must offer none.
    const { calls } = await run(
      [{ text: "thinking", toolCalls: [{ name: "search_quiz_results", args: "{}" }] }],
      { maxToolCalls: 2 }
    );
    expect(calls).toHaveLength(3);
    expect(calls[0].tools).toBeDefined();
    expect(calls[1].tools).toBeDefined();
    expect(calls[2].tools).toBeUndefined();
  });

  it("offers no tools at all when every skill is disabled", async () => {
    const { calls } = await run([{ text: "hi" }], { enabledSkills: [] });
    expect(calls[0].tools).toBeUndefined();
  });

  it("never advertises a tool the admin switched off", async () => {
    const { calls } = await run([{ text: "hi" }], {
      disabledTools: ["get_quiz_result_detail"],
    });
    const advertised = (calls[0].tools as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name
    );
    expect(advertised).toContain("search_quiz_results");
    expect(advertised).not.toContain("get_quiz_result_detail");
  });

  it("refuses to run a disabled tool even if the model asks for it by name", async () => {
    const { calls } = await run(
      [
        { toolCalls: [{ name: "get_quiz_result_detail", args: '{"resultId":"x"}' }] },
        { text: "I can't look that up." },
      ],
      { disabledTools: ["get_quiz_result_detail"] }
    );
    const second = calls[1].messages as Array<{ role: string; content: string }>;
    expect(second.at(-1)?.content).toContain("Unknown tool");
  });
});

describe("runAssistantTurn — replaying stored attachments", () => {
  /** Run one turn with a given history and attachment loader, returning the messages sent. */
  async function runWithHistory(
    history: Parameters<typeof runAssistantTurn>[0]["history"],
    load: Parameters<typeof runAssistantTurn>[0]["loadHistoryAttachments"],
    overrides: Partial<ReturnType<typeof defaultSettings>> = {}
  ) {
    const { client } = fakeClient([{ text: "ok" }]);
    mockResolve.mockResolvedValue(provider);
    mockClient.mockResolvedValue(client as never);
    await runAssistantTurn({
      settings: { ...defaultSettings("student"), ...overrides },
      ctx: studentCtx,
      history,
      message: "and this one?",
      attachments: [],
      notices: [],
      loadHistoryAttachments: load,
      emit: () => {},
    });
    return client.chat.completions.create.mock.calls[0][0].messages as Array<{
      role: string;
      content: unknown;
    }>;
  }

  const stored = (id: string) => ({
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    dataBase64: "AAAA",
    kind: "image" as const,
    bytes: 3,
  });

  it("re-attaches a prior turn's image as content parts", async () => {
    const messages = await runWithHistory(
      [
        { role: "user", content: "what is this?", attachmentNames: ["a.png"], attachmentIds: ["a"] },
        { role: "assistant", content: "a graph" },
      ],
      async (ids) => ids.map(stored)
    );
    const replayed = messages[1].content as Array<{ type: string }>;
    expect(Array.isArray(replayed)).toBe(true);
    expect(replayed.some((part) => part.type === "image_url")).toBe(true);
  });

  it("falls back to filenames when the file is gone", async () => {
    const messages = await runWithHistory(
      [{ role: "user", content: "what is this?", attachmentNames: ["a.png"], attachmentIds: ["a"] }],
      async () => []
    );
    expect(typeof messages[1].content).toBe("string");
    expect(messages[1].content).toContain("[attached: a.png]");
  });

  it("caps the whole replay at the per-message attachment limit, newest first", async () => {
    const requested: string[][] = [];
    await runWithHistory(
      [
        { role: "user", content: "one", attachmentIds: ["old-1", "old-2"] },
        { role: "user", content: "two", attachmentIds: ["new-1", "new-2"] },
      ],
      async (ids) => {
        requested.push(ids);
        return ids.map(stored);
      },
      { maxAttachments: 2 }
    );
    // Only two ids are even asked for, and they are the newest turn's.
    expect(requested).toEqual([["new-1", "new-2"]]);
  });

  it("does not load anything when attachments are switched off for the audience", async () => {
    const load = vi.fn(async () => []);
    await runWithHistory(
      [{ role: "user", content: "one", attachmentIds: ["a"] }],
      load,
      { maxAttachments: 0 }
    );
    expect(load).not.toHaveBeenCalled();
  });

  it("ignores attachment ids on an assistant turn", async () => {
    const load = vi.fn(async () => []);
    await runWithHistory(
      [{ role: "assistant", content: "here", attachmentIds: ["a"] }],
      load
    );
    expect(load).not.toHaveBeenCalled();
  });
});

describe("runAssistantTurn — prompt assembly", () => {
  it("puts the system prompt first and the user turn last", async () => {
    const { calls } = await run([{ text: "hi" }]);
    const messages = calls[0].messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages.at(-1)).toMatchObject({ role: "user", content: "how did I do?" });
  });

  it("prefixes rejected-attachment notices to the user turn", async () => {
    const { client } = fakeClient([{ text: "ok" }]);
    mockResolve.mockResolvedValue(provider);
    mockClient.mockResolvedValue(client as never);
    await runAssistantTurn({
      settings: defaultSettings("student"),
      ctx: studentCtx,
      history: [],
      message: "read this",
      attachments: [],
      notices: ['the attachment "a.pdf" was not read: unsupported file type'],
      emit: () => {},
    });
    const messages = client.chat.completions.create.mock.calls[0][0].messages as Array<{
      content: string;
    }>;
    expect(messages.at(-1)?.content).toContain("[system note:");
    expect(messages.at(-1)?.content).toContain("read this");
  });

  it("trims replayed history to the configured window", async () => {
    const { client } = fakeClient([{ text: "ok" }]);
    mockResolve.mockResolvedValue(provider);
    mockClient.mockResolvedValue(client as never);
    await runAssistantTurn({
      settings: { ...defaultSettings("student"), maxHistoryMessages: 2 },
      ctx: studentCtx,
      history: [
        { role: "user", content: "oldest" },
        { role: "assistant", content: "middle" },
        { role: "user", content: "newest" },
      ],
      message: "now",
      attachments: [],
      notices: [],
      emit: () => {},
    });
    const messages = client.chat.completions.create.mock.calls[0][0].messages as Array<{
      content: string;
    }>;
    // system + 2 history turns + the new user turn.
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.content)).not.toContain("oldest");
  });
});

describe("runAssistantTurn — thinking level vs tools", () => {
  /** A client whose first `create` rejects the way the provider does. */
  function clientRejectingOnce(error: unknown, round: Round) {
    const calls: Array<Record<string, unknown>> = [];
    let first = true;
    const client = {
      chat: {
        completions: {
          create: vi.fn(async (params: Record<string, unknown>) => {
            calls.push(params);
            if (first) {
              first = false;
              throw error;
            }
            return {
              async *[Symbol.asyncIterator]() {
                for (const chunk of chunksFor(round)) yield chunk;
              },
            };
          }),
        },
      },
    };
    return { client, calls };
  }

  async function runWith(client: unknown) {
    mockResolve.mockResolvedValue({ ...provider, thinkingLevel: "high" });
    mockClient.mockResolvedValue(client as never);
    const events: AssistantStreamEvent[] = [];
    const result = await runAssistantTurn({
      settings: defaultSettings("student"),
      ctx: studentCtx,
      history: [],
      message: "how did I do?",
      attachments: [],
      notices: [],
      emit: (event) => {
        events.push(event);
      },
    });
    return { result, events };
  }

  const rejection = Object.assign(
    new Error(
      "400 Function tools with reasoning_effort are not supported for gpt-test in " +
        "/v1/chat/completions. To use function tools, use /v1/responses or set " +
        "reasoning_effort to 'none'."
    ),
    { status: 400 }
  );

  it("retries without reasoning_effort when the provider refuses it alongside tools", async () => {
    // The real symptom this covers: every assistant turn 400'd because the
    // admin pinned a thinking level on a model that only takes one of the two.
    const { client, calls } = clientRejectingOnce(rejection, { text: "you did well" });
    const { result, events } = await runWith(client);

    expect(calls).toHaveLength(2);
    expect(calls[0].reasoning_effort).toBe("high");
    expect(calls[0]).toHaveProperty("tools");
    expect(calls[1]).not.toHaveProperty("reasoning_effort");
    expect(calls[1]).toHaveProperty("tools");
    expect(result.text).toBe("you did well");
    expect(events.some((event) => event.type === "error")).toBe(false);
  });

  it("reports the level the turn actually ran with, not the configured one", async () => {
    const { client } = clientRejectingOnce(rejection, { text: "ok" });
    const { events } = await runWith(client);
    const done = events.find((event) => event.type === "done");
    expect(done).toMatchObject({ thinkingLevel: null });
  });

  it("does not swallow unrelated provider failures", async () => {
    const { client, calls } = clientRejectingOnce(
      Object.assign(new Error("400 context_length_exceeded"), { status: 400 }),
      { text: "unreachable" }
    );
    await expect(runWith(client)).rejects.toThrow("context_length_exceeded");
    expect(calls).toHaveLength(1);
  });

  it("does not retry when no thinking level is pinned", async () => {
    const { client, calls } = clientRejectingOnce(rejection, { text: "unreachable" });
    mockResolve.mockResolvedValue({ ...provider, thinkingLevel: null });
    mockClient.mockResolvedValue(client as never);
    await expect(
      runAssistantTurn({
        settings: defaultSettings("student"),
        ctx: studentCtx,
        history: [],
        message: "how did I do?",
        attachments: [],
        notices: [],
        emit: () => {},
      })
    ).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });
});

describe("toolParameterSchema", () => {
  const searchTool = listSkills("student")
    .flatMap((skill) => skill.tools)
    .find((tool) => tool.name === "search_quiz_results")!;

  it("derives an object schema from the tool's zod input", () => {
    const schema = toolParameterSchema(searchTool);
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties as object)).toContain("quizName");
  });

  it("strips $schema, which some local servers reject", () => {
    expect(toolParameterSchema(searchTool).$schema).toBeUndefined();
  });

  it("always emits a properties object, even for a no-argument tool", () => {
    const listTool = listSkills("teacher")
      .flatMap((skill) => skill.tools)
      .find((tool) => tool.name === "list_classes")!;
    expect(toolParameterSchema(listTool).properties).toEqual({});
  });
});
