import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import {
  streamChatCompletion,
  streamJsonCompletion,
  parseFirstJsonObject,
  aggregateMetrics,
  type AiCallMetrics,
} from "./ai-streaming";

type Chunk = {
  choices?: { delta?: { content?: string } }[];
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
      streamOf([contentChunk("Hello "), contentChunk("world"), { choices: [{ delta: {} }], usage: { completion_tokens: 7 } }])
    );
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    // now() is called at start, on first content delta, and at the end.
    const { text, metrics } = await streamChatCompletion(
      client,
      { model: "gpt-x", messages: [] },
      { now: clock([100, 150, 400]) }
    );

    expect(text).toBe("Hello world");
    expect(metrics.model).toBe("gpt-x");
    expect(metrics.ttftMs).toBe(50);
    expect(metrics.totalMs).toBe(300);
    expect(metrics.completionTokens).toBe(7);
    expect(metrics.tokensEstimated).toBe(false);
    // tokensPerSec = 7 / ((300-50)/1000) = 28
    expect(metrics.tokensPerSec).toBeCloseTo(28);
  });

  it("estimates token count from streamed deltas when the provider omits usage", async () => {
    const create = vi.fn(async () => streamOf([contentChunk("a"), contentChunk("b"), contentChunk("c")]));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const { metrics } = await streamChatCompletion(client, { model: "local", messages: [] }, { now: clock([0, 10, 60]) });

    expect(metrics.completionTokens).toBe(3);
    expect(metrics.tokensEstimated).toBe(true);
  });

  it("requests usage and forwards request options only when asked", async () => {
    const create = vi.fn(async () => streamOf([contentChunk("x")]));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    await streamChatCompletion(
      client,
      { model: "m", messages: [] },
      { includeUsage: true, requestOptions: { maxRetries: 0 }, now: clock([0, 1, 2]) }
    );

    const [params, reqOpts] = create.mock.calls[0] as unknown as [any, any];
    expect(params.stream).toBe(true);
    expect(params.stream_options).toEqual({ include_usage: true });
    expect(reqOpts).toEqual({ maxRetries: 0 });
  });

  it("omits stream_options when includeUsage is not set", async () => {
    const create = vi.fn(async () => streamOf([contentChunk("x")]));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    await streamChatCompletion(client, { model: "m", messages: [] }, { now: clock([0, 1, 2]) });

    expect((create.mock.calls[0] as any[])[0].stream_options).toBeUndefined();
  });

  it("reports null TTFT and rate when no content arrives", async () => {
    const create = vi.fn(async () => streamOf([{ choices: [{ delta: {} }], usage: { completion_tokens: 0 } }]));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const { text, metrics } = await streamChatCompletion(client, { model: "m", messages: [] }, { now: clock([0, 5]) });

    expect(text).toBe("");
    expect(metrics.ttftMs).toBeNull();
    expect(metrics.tokensPerSec).toBeNull();
  });
});

describe("streamJsonCompletion", () => {
  it("parses streamed JSON and returns metrics", async () => {
    const create = vi.fn(async () => streamOf([contentChunk('{"needed":'), contentChunk('true}')]));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const { value, metrics } = await streamJsonCompletion<{ needed: boolean }>(
      client,
      { model: "m", messages: [] },
      { name: "s", schema: {}, strict: true },
      { now: clock([0, 2, 12]) }
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

    const { value } = await streamJsonCompletion(client, { model: "m", messages: [] }, { name: "s" }, { now: clock([0, 1, 2]) });

    expect(value).toEqual({ ok: 1 });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].response_format).toBeUndefined();
  });

  it("tolerates JSON wrapped in prose via parseFirstJsonObject", async () => {
    const create = vi.fn(async () => streamOf([contentChunk('Sure! {"a": 2} done')]));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const { value } = await streamJsonCompletion(client, { model: "m", messages: [] }, {}, { now: clock([0, 1, 2]) });
    expect(value).toEqual({ a: 2 });
  });

  it("throws on an empty response", async () => {
    const create = vi.fn(async () => streamOf([]));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    await expect(
      streamJsonCompletion(client, { model: "m", messages: [] }, {}, { now: clock([0, 1]) })
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
    tokensPerSec: 50,
    ...over,
  });

  it("returns null for an empty list", () => {
    expect(aggregateMetrics([])).toBeNull();
  });

  it("sums tokens, averages TTFT, and recomputes the rate over summed generation time", () => {
    const agg = aggregateMetrics([
      m({ ttftMs: 100, completionTokens: 10, totalMs: 300 }), // genMs 200
      m({ ttftMs: 200, completionTokens: 30, totalMs: 500 }), // genMs 300
    ])!;
    expect(agg.completionTokens).toBe(40);
    expect(agg.ttftMs).toBe(150);
    expect(agg.totalMs).toBe(800);
    // 40 tokens / ((200+300)/1000)s = 80 tok/s
    expect(agg.tokensPerSec).toBeCloseTo(80);
  });

  it("ignores null TTFTs when averaging and flags estimation if any part is estimated", () => {
    const agg = aggregateMetrics([
      m({ ttftMs: null, completionTokens: 5, totalMs: 100, tokensEstimated: true }),
      m({ ttftMs: 80, completionTokens: 5, totalMs: 200 }),
    ])!;
    expect(agg.ttftMs).toBe(80);
    expect(agg.tokensEstimated).toBe(true);
  });
});
