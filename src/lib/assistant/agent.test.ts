import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/ai-provider", () => ({
  resolveProvider: vi.fn(),
  createOpenAIClient: vi.fn(),
}));

import { runAssistantTurn, toolParameterSchema } from "./agent";
import { defaultSettings } from "./config";
import { listSkills } from "./skills";
import { resolveProvider, createOpenAIClient } from "@/lib/ai-provider";
import type { AssistantStreamEvent, AssistantToolContext } from "./types";

const mockResolve = vi.mocked(resolveProvider);
const mockClient = vi.mocked(createOpenAIClient);

const provider = {
  providerType: "openai" as const,
  baseUrl: null,
  apiKey: "k",
  model: "gpt-test",
  serviceTier: null,
  cfAigByokAlias: null,
  timeoutMs: 1000,
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

async function run(rounds: Round[], overrides: Partial<ReturnType<typeof defaultSettings>> = {}) {
  const { client, calls } = fakeClient(rounds);
  mockResolve.mockResolvedValue(provider);
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
    expect(events.at(-1)).toMatchObject({ type: "done", model: "openai/gpt-test", tokens: 7 });
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
