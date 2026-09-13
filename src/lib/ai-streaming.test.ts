import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import {
  streamChatCompletion,
  streamJsonCompletion,
  parseFirstJsonObject,
  aggregateMetrics,
  type AiCallMetrics,
} from "./ai-streaming";

type ToolCallDelta = {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
};

type Chunk = {
  choices?: {
    delta?: { content?: string; tool_calls?: ToolCallDelta[] };
    finish_reason?: string;
  }[];
  usage?: { completion_tokens?: number } | null;
};

function streamOf(chunks: Chunk[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

/** Deterministic clock: returns each value in turn, then sticks on the last. */
function clock(values: number[]) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function contentChunk(content: string): Chunk {
  return { choices: [{ delta: { content } }] };
}

describe("streamChatCompletion", () => {
  it("accumulates text and uses provider usage for the token count", async () => {
    const create = vi.fn(async () =>
      streamOf([
        contentChunk("Hello "),
        contentChunk("world"),
        { choices: [{ delta: {} }], usage: { completion_tokens: 7 } },
      ]),
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    // now() is called at start, on first content delta, and at the end.
    const { text, metrics } = await streamChatCompletion(
      client,
      { model: "gpt-x", messages: [] },
      { now: clock([100, 150, 400]) },
    );

    expect(text).toBe("Hello world");
    expect(metrics.model).toBe("gpt-x");
    expect(metrics.ttftMs).toBe(50);
    expect(metrics.totalMs).toBe(300);
    expect(metrics.completionTokens).toBe(7);
    expect(metrics.tokensEstimated).toBe(false);
    // The content streamed over 250 of the call's 300ms, so that window stands
    // as the generation window: 7 / 0.25s = 28 tok/s.
    expect(metrics.generationMs).toBe(250);
    expect(metrics.tokensPerSec).toBeCloseTo(28);
  });

  it("reports no generation window when the content arrived in one flush", async () => {
    const create = vi.fn(async () =>
      streamOf([
        contentChunk("a"),
        contentChunk("b"),
        { choices: [{ delta: {} }], usage: { completion_tokens: 222 } },
      ]),
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    // A buffering gateway: first delta at 6805ms, stream done 32ms later. Those
    // 222 tokens were produced during the wait, not the flush.
    const { metrics } = await streamChatCompletion(
      client,
      { model: "openai/gpt-5.5", messages: [] },
      { now: clock([0, 6805, 6837]) },
    );

    expect(metrics.ttftMs).toBe(6805);
    expect(metrics.totalMs).toBe(6837);
    expect(metrics.generationMs).toBeNull();
    // Rate over the whole call (32.5 tok/s), not 6937 tok/s over the flush.
    expect(metrics.tokensPerSec).toBeCloseTo(222 / 6.837, 2);
  });

  it("estimates token count from streamed deltas when the provider omits usage", async () => {
    const create = vi.fn(async () =>
      streamOf([contentChunk("a"), contentChunk("b"), contentChunk("c")]),
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const { metrics } = await streamChatCompletion(
      client,
      { model: "local", messages: [] },
      { now: clock([0, 10, 60]) },
    );

    expect(metrics.completionTokens).toBe(3);
    expect(metrics.tokensEstimated).toBe(true);
  });

  it("forwards accumulated text as each content delta arrives", async () => {
    const create = vi.fn(async () =>
      streamOf([contentChunk("First"), contentChunk(" response")]),
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const updates: Array<[string, string]> = [];

    await streamChatCompletion(
      client,
      { model: "m", messages: [] },
      {
        now: clock([0, 1, 2]),
        onContent: (text, delta) => {
          updates.push([text, delta]);
        },
      },
    );

    expect(updates).toEqual([
      ["First", "First"],
      ["First response", " response"],
    ]);
  });

  it("requests usage and forwards request options only when asked", async () => {
    const create = vi.fn(async () => streamOf([contentChunk("x")]));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    await streamChatCompletion(
      client,
      { model: "m", messages: [] },
      {
        includeUsage: true,
        requestOptions: { maxRetries: 0 },
        now: clock([0, 1, 2]),
      },
    );

    const [params, reqOpts] = create.mock.calls[0] as unknown as [any, any];
    expect(params.stream).toBe(true);
    expect(params.stream_options).toEqual({ include_usage: true });
    expect(reqOpts).toEqual({ maxRetries: 0 });
  });

  it("omits stream_options when includeUsage is not set", async () => {
    const create = vi.fn(async () => streamOf([contentChunk("x")]));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    await streamChatCompletion(
      client,
      { model: "m", messages: [] },
      { now: clock([0, 1, 2]) },
    );

    expect((create.mock.calls[0] as any[])[0].stream_options).toBeUndefined();
  });

  it("reports null TTFT and rate when no content arrives", async () => {
    const create = vi.fn(async () =>
      streamOf([{ choices: [{ delta: {} }], usage: { completion_tokens: 0 } }]),
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const { text, metrics } = await streamChatCompletion(
      client,
      { model: "m", messages: [] },
      { now: clock([0, 5]) },
    );

    expect(text).toBe("");
    expect(metrics.ttftMs).toBeNull();
    expect(metrics.tokensPerSec).toBeNull();
  });
});

describe("streamChatCompletion — tool calls", () => {
  const clientFor = (chunks: Chunk[]) =>
    ({
      chat: { completions: { create: vi.fn(async () => streamOf(chunks)) } },
    }) as unknown as OpenAI;

  it("returns no tool calls for an ordinary completion", async () => {
    const result = await streamChatCompletion(clientFor([contentChunk("hi")]), {
      model: "gpt-x",
      messages: [],
    });
    expect(result.toolCalls).toEqual([]);
  });

  it("reassembles a name and arguments fragmented across chunks", async () => {
    // Providers stream the name in one delta and the JSON arguments in pieces.
    const result = await streamChatCompletion(
      clientFor([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "c1", function: { name: "search" } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: '{"a"' } }],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: ":1}" } }],
              },
            },
          ],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
      { model: "gpt-x", messages: [] },
    );
    expect(result.toolCalls).toEqual([
      { id: "c1", name: "search", arguments: '{"a":1}' },
    ]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("keeps parallel calls separate and orders them by index", async () => {
    const result = await streamChatCompletion(
      clientFor([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 1, id: "b", function: { name: "second" } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "a", function: { name: "first" } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 1, function: { arguments: "{}" } }],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: "{}" } }],
              },
            },
          ],
        },
      ]),
      { model: "gpt-x", messages: [] },
    );
    expect(result.toolCalls.map((call) => call.name)).toEqual([
      "first",
      "second",
    ]);
  });

  it("drops a slot that never received a name", async () => {
    // A trailing empty delta must not become a nameless call the dispatcher
    // would then look up and fail on.
    const result = await streamChatCompletion(
      clientFor([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "c1", function: { name: "search" } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 1, function: { arguments: "" } }],
              },
            },
          ],
        },
      ]),
      { model: "gpt-x", messages: [] },
    );
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("search");
  });

  it("carries text and tool calls together when a model narrates before calling", async () => {
    const result = await streamChatCompletion(
      clientFor([
        contentChunk("Let me check. "),
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "c1",
                    function: { name: "search", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
      ]),
      { model: "gpt-x", messages: [] },
    );
    expect(result.text).toBe("Let me check. ");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("tolerates a provider that omits the tool-call id", async () => {
    const result = await streamChatCompletion(
      clientFor([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { name: "search", arguments: "{}" } },
                ],
              },
            },
          ],
        },
      ]),
      { model: "gpt-x", messages: [] },
    );
    expect(result.toolCalls[0]).toEqual({
      id: "",
      name: "search",
      arguments: "{}",
    });
  });
});

describe("streamJsonCompletion", () => {
  it("parses streamed JSON and returns metrics", async () => {
    const create = vi.fn(async () =>
      streamOf([contentChunk('{"needed":'), contentChunk("true}")]),
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const { value, metrics } = await streamJsonCompletion<{ needed: boolean }>(
      client,
      { model: "m", messages: [] },
      { name: "s", schema: {}, strict: true },
      { now: clock([0, 2, 12]) },
    );

    expect(value).toEqual({ needed: true });
    expect(metrics.completionTokens).toBe(2);
    expect((create.mock.calls[0] as any[])[0].response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "s", schema: {}, strict: true },
    });
  });

  it("retries once without response_format when the schema call throws", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("response_format unsupported"))
      .mockResolvedValueOnce(streamOf([contentChunk('{"ok":1}')]));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const { value } = await streamJsonCompletion(
      client,
      { model: "m", messages: [] },
      { name: "s" },
      { now: clock([0, 1, 2]) },
    );

    expect(value).toEqual({ ok: 1 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].response_format).toBeUndefined();
  });

  it("tolerates JSON wrapped in prose via parseFirstJsonObject", async () => {
    const create = vi.fn(async () =>
      streamOf([contentChunk('Sure! {"a": 2} done')]),
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const { value } = await streamJsonCompletion(
      client,
      { model: "m", messages: [] },
      {},
      { now: clock([0, 1, 2]) },
    );
    expect(value).toEqual({ a: 2 });
  });

  it("throws on an empty response", async () => {
    const create = vi.fn(async () => streamOf([]));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    await expect(
      streamJsonCompletion(
        client,
        { model: "m", messages: [] },
        {},
        { now: clock([0, 1]) },
      ),
    ).rejects.toThrow(/empty response/);
  });
});

describe("parseFirstJsonObject", () => {
  it("extracts the first balanced object", () => {
    expect(parseFirstJsonObject('noise {"x":1} tail')).toEqual({ x: 1 });
  });
  it("throws when there is no object", () => {
    expect(() => parseFirstJsonObject("no json here")).toThrow();
  });
});

describe("aggregateMetrics", () => {
  const m = (over: Partial<AiCallMetrics>): AiCallMetrics => ({
    model: "m",
    ttftMs: 100,
    completionTokens: 10,
    tokensEstimated: false,
    totalMs: 300,
    generationMs: 200,
    tokensPerSec: 50,
    ...over,
  });

  it("returns null for an empty list", () => {
    expect(aggregateMetrics([])).toBeNull();
  });

  it("sums tokens, averages TTFT, and recomputes the rate over summed generation time", () => {
    const agg = aggregateMetrics([
      m({ ttftMs: 100, completionTokens: 10, totalMs: 300, generationMs: 200 }),
      m({ ttftMs: 200, completionTokens: 30, totalMs: 500, generationMs: 300 }),
    ])!;
    expect(agg.completionTokens).toBe(40);
    expect(agg.ttftMs).toBe(150);
    expect(agg.totalMs).toBe(800);
    expect(agg.generationMs).toBe(500);
    // 40 tokens / ((200+300)/1000)s = 80 tok/s
    expect(agg.tokensPerSec).toBeCloseTo(80);
  });

  it("drops the summed window when one contentful call didn't stream", () => {
    const agg = aggregateMetrics([
      m({ ttftMs: 100, completionTokens: 10, totalMs: 300, generationMs: 200 }),
      m({
        ttftMs: 400,
        completionTokens: 90,
        totalMs: 410,
        generationMs: null,
      }),
    ])!;
    // Summing 200ms would understate a job that spent 710ms generating.
    expect(agg.generationMs).toBeNull();
    expect(agg.tokensPerSec).toBeCloseTo(100 / 0.71, 2);
  });

  it("ignores null TTFTs when averaging and flags estimation if any part is estimated", () => {
    const agg = aggregateMetrics([
      m({
        ttftMs: null,
        completionTokens: 5,
        totalMs: 100,
        generationMs: null,
        tokensEstimated: true,
      }),
      m({ ttftMs: 80, completionTokens: 5, totalMs: 200, generationMs: 120 }),
    ])!;
    expect(agg.ttftMs).toBe(80);
    expect(agg.tokensEstimated).toBe(true);
    // The call that produced nothing has no window to contribute, and doesn't
    // disqualify the one that does.
    expect(agg.generationMs).toBe(120);
  });
});
