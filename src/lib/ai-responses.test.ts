import { describe, it, expect, vi, beforeEach } from "vitest";
import type OpenAI from "openai";
import {
  isResponsesUnsupported,
  streamResponsesCompletion,
  toResponsesRequest,
} from "./ai-responses";
import { resetSurfaceMemo, streamChatCompletion } from "./ai-streaming";

/** Deterministic clock: returns each value in turn, then sticks on the last. */
function clock(values: number[]) {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function streamOf(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

function textDelta(delta: string) {
  return { type: "response.output_text.delta", delta };
}

function completed(outputTokens: number | null) {
  return {
    type: "response.completed",
    response: {
      usage: outputTokens === null ? null : { output_tokens: outputTokens },
    },
  };
}

/** A client exposing only `responses.create`, like a real Responses provider. */
function responsesClient(events: unknown[]) {
  const create = vi.fn(async () => streamOf(events));
  return { client: { responses: { create } } as unknown as OpenAI, create };
}

/** An error shaped like the SDK's APIError. */
function apiError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

beforeEach(() => {
  resetSurfaceMemo();
});

describe("toResponsesRequest", () => {
  it("moves system turns into instructions and leaves the rest as input", () => {
    const req = toResponsesRequest({
      model: "m",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" },
      ],
    });

    expect(req.instructions).toBe("be brief");
    expect(req.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  it("joins multiple system turns rather than dropping all but one", () => {
    const req = toResponsesRequest({
      model: "m",
      messages: [
        { role: "system", content: "one" },
        { role: "developer", content: "two" },
        { role: "user", content: "hi" },
      ],
    });
    expect(req.instructions).toBe("one\n\ntwo");
  });

  it("flattens image parts into the input_image shape", () => {
    const req = toResponsesRequest({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            {
              type: "image_url",
              image_url: { url: "data:image/png;base64,AAA" },
            },
          ],
        },
      ],
    });

    expect(req.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "what is this?" },
          // Not the nested { image_url: { url } } object chat completions uses.
          {
            type: "input_image",
            image_url: "data:image/png;base64,AAA",
            detail: "auto",
          },
        ],
      },
    ]);
  });

  it("turns a tool round-trip into function_call / function_call_output items", () => {
    const req = toResponsesRequest({
      model: "m",
      messages: [
        { role: "user", content: "how did I do?" },
        {
          role: "assistant",
          content: "let me check",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "search", arguments: '{"q":1}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call-1", content: '{"hits":0}' },
      ],
    });

    expect(req.input).toEqual([
      {
        role: "user",
        content: [{ type: "input_text", text: "how did I do?" }],
      },
      { role: "assistant", content: "let me check" },
      {
        type: "function_call",
        call_id: "call-1",
        name: "search",
        arguments: '{"q":1}',
      },
      { type: "function_call_output", call_id: "call-1", output: '{"hits":0}' },
    ]);
  });

  it("flattens tool definitions and keeps json_schema output constrained", () => {
    const req = toResponsesRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            description: "find",
            parameters: { type: "object" },
          },
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "out", schema: { type: "object" }, strict: true },
      },
    });

    // Responses hoists name/parameters out of the nested `function` object.
    expect(req.tools).toEqual([
      {
        type: "function",
        name: "search",
        description: "find",
        parameters: { type: "object" },
        strict: false,
      },
    ]);
    expect(req.text).toEqual({
      format: {
        type: "json_schema",
        name: "out",
        schema: { type: "object" },
        strict: true,
      },
    });
  });

  it("renames the token cap and nests the thinking level", () => {
    const req = toResponsesRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      max_completion_tokens: 1500,
      reasoning_effort: "high",
    });

    expect(req.max_output_tokens).toBe(1500);
    // The pairing chat completions rejects for tool-calling models.
    expect(req.reasoning).toEqual({ effort: "high" });
    expect(req).not.toHaveProperty("reasoning_effort");
  });

  it("accepts a local provider's max_tokens as the cap", () => {
    const req = toResponsesRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      max_tokens: 900,
    });
    expect(req.max_output_tokens).toBe(900);
  });

  it("never opts into server-side retention", () => {
    // Student work should not persist in OpenAI storage as a side effect of
    // which endpoint we happen to call.
    const req = toResponsesRequest({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    });
    expect(req.store).toBe(false);
  });
});

describe("streamResponsesCompletion", () => {
  it("measures TTFT from the first visible token and takes tokens from usage", async () => {
    const { client } = responsesClient([
      textDelta("Hello "),
      textDelta("world"),
      completed(7),
    ]);

    const { text, metrics } = await streamResponsesCompletion(
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
  });

  it("does not let reasoning deltas count as the first token", async () => {
    // Reasoning arrives before any answer text; treating it as first-token
    // would report a TTFT the user never experienced.
    const { client } = responsesClient([
      { type: "response.reasoning_text.delta", delta: "hmm" },
      textDelta("answer"),
      completed(3),
    ]);

    const { metrics } = await streamResponsesCompletion(
      client,
      { model: "m", messages: [] },
      { now: clock([0, 200, 300]) },
    );

    expect(metrics.ttftMs).toBe(200);
  });

  it("estimates tokens from deltas when the provider reports no usage", async () => {
    const { client } = responsesClient([
      textDelta("a"),
      textDelta("b"),
      completed(null),
    ]);

    const { metrics } = await streamResponsesCompletion(
      client,
      { model: "m", messages: [] },
      { now: clock([0, 1, 2]) },
    );

    expect(metrics.completionTokens).toBe(2);
    expect(metrics.tokensEstimated).toBe(true);
  });

  it("reassembles a function call from its argument deltas", async () => {
    const { client } = responsesClient([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "function_call",
          call_id: "call-1",
          name: "search",
          arguments: "",
        },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"q"',
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: ":1}",
      },
      completed(4),
    ]);

    const { toolCalls, finishReason } = await streamResponsesCompletion(
      client,
      { model: "m", messages: [] },
      { now: clock([0, 1]) },
    );

    expect(toolCalls).toEqual([
      { id: "call-1", name: "search", arguments: '{"q":1}' },
    ]);
    // Mapped onto the chat-completions vocabulary so callers read one set.
    expect(finishReason).toBe("tool_calls");
  });

  it("prefers the terminal arguments string over the accumulated deltas", async () => {
    const { client } = responsesClient([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: "c", name: "t", arguments: "" },
      },
      {
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: '{"a":',
      },
      {
        type: "response.function_call_arguments.done",
        output_index: 0,
        arguments: '{"a":1}',
      },
      completed(1),
    ]);

    const { toolCalls } = await streamResponsesCompletion(
      client,
      { model: "m", messages: [] },
      { now: clock([0, 1]) },
    );
    expect(toolCalls[0].arguments).toBe('{"a":1}');
  });

  it("reports a truncated response as finishReason length", async () => {
    const { client } = responsesClient([
      textDelta("cut off"),
      {
        type: "response.incomplete",
        response: {
          usage: { output_tokens: 2 },
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    ]);

    const { finishReason, metrics } = await streamResponsesCompletion(
      client,
      { model: "m", messages: [] },
      { now: clock([0, 1, 2]) },
    );
    expect(finishReason).toBe("length");
    expect(metrics.completionTokens).toBe(2);
  });

  it("throws when the response itself fails mid-stream", async () => {
    const { client } = responsesClient([
      {
        type: "response.failed",
        response: { error: { message: "upstream exploded" } },
      },
    ]);

    await expect(
      streamResponsesCompletion(
        client,
        { model: "m", messages: [] },
        { now: clock([0, 1]) },
      ),
    ).rejects.toThrow("upstream exploded");
  });
});

describe("isResponsesUnsupported", () => {
  it("treats a missing endpoint as unsupported", () => {
    expect(isResponsesUnsupported(apiError(404, "Not Found"))).toBe(true);
    expect(isResponsesUnsupported(apiError(405, "Method Not Allowed"))).toBe(
      true,
    );
  });

  it("does not treat a bad request as a missing endpoint", () => {
    // A 400 means the endpoint exists and we built a bad request — falling back
    // would hide that bug behind a working call on the other transport.
    expect(
      isResponsesUnsupported(apiError(400, "invalid schema for tool 'search'")),
    ).toBe(false);
    expect(isResponsesUnsupported(apiError(500, "internal error"))).toBe(false);
    expect(isResponsesUnsupported(apiError(429, "rate limited"))).toBe(false);
  });

  it("matches proxies that spell a missing route as a 400", () => {
    expect(
      isResponsesUnsupported(apiError(400, "unknown path /v1/responses")),
    ).toBe(true);
  });

  it("matches Cloudflare AI Gateway's compat endpoint verbatim", () => {
    // Checked against the live gateway: the compat endpoint routes before it
    // authenticates, so an unserved path comes back 400, not 404. Every use
    // case on that deployment goes through this endpoint, so getting it wrong
    // takes down all AI, not just the assistant.
    //
    // This is the string the SDK actually builds, not a paraphrase of the
    // gateway's prose. Cloudflare puts `error` in the body as an ARRAY, so it
    // has no `.message` for APIError.makeMessage to read and the whole array
    // gets JSON-stringified instead. Asserting the tidier sentence would let a
    // tightening of the regex pass here and still break in production.
    expect(
      isResponsesUnsupported(
        apiError(
          400,
          '400 [{"code":2019,"message":"Compatibility endpoint: responses is not supported."}]',
        ),
      ),
    ).toBe(true);
  });

  it("still surfaces a 400 about the request rather than the endpoint", () => {
    // The phrases overlap ("not supported"), so these are the cases that prove
    // the endpoint-noun half of the test is doing real work.
    expect(
      isResponsesUnsupported(
        apiError(
          400,
          "Unsupported parameter: 'max_tokens' is not supported with this model.",
        ),
      ),
    ).toBe(false);
    expect(
      isResponsesUnsupported(
        apiError(400, "Invalid schema for function 'search'."),
      ),
    ).toBe(false);
    expect(
      isResponsesUnsupported(
        apiError(
          400,
          "Provider 'openai' has no BYOK credential named 'default'.",
        ),
      ),
    ).toBe(false);
  });
});

describe("streamChatCompletion — transport selection", () => {
  /** A client that serves chat completions but 404s on /v1/responses. */
  function chatOnlyClient(text: string) {
    const chatCreate = vi.fn(async () =>
      streamOf([
        { choices: [{ delta: { content: text } }] },
        { choices: [{ delta: {} }], usage: { completion_tokens: 5 } },
      ]),
    );
    const responsesCreate = vi.fn(async () => {
      throw apiError(404, "Not Found");
    });
    return {
      client: {
        baseURL: "https://local.example/v1",
        chat: { completions: { create: chatCreate } },
        responses: { create: responsesCreate },
      } as unknown as OpenAI,
      chatCreate,
      responsesCreate,
    };
  }

  it("uses chat completions when that is the provider's surface", async () => {
    const { client, chatCreate, responsesCreate } = chatOnlyClient("hi");
    await streamChatCompletion(
      client,
      { model: "m", messages: [] },
      { surface: "chat_completions", now: clock([0, 1, 2]) },
    );
    expect(chatCreate).toHaveBeenCalledTimes(1);
    expect(responsesCreate).not.toHaveBeenCalled();
  });

  it("falls back to chat completions when the endpoint has no /v1/responses", async () => {
    const { client, chatCreate, responsesCreate } =
      chatOnlyClient("fallback text");

    const { text, metrics } = await streamChatCompletion(
      client,
      { model: "m", messages: [] },
      { surface: "responses", now: clock([0, 1, 2]) },
    );

    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(chatCreate).toHaveBeenCalledTimes(1);
    // The stats survive the fallback — that is the whole point of the seam.
    expect(text).toBe("fallback text");
    expect(metrics.completionTokens).toBe(5);
    expect(metrics.tokensEstimated).toBe(false);
  });

  it("remembers the fallback so the next call skips the dead endpoint", async () => {
    const { client, responsesCreate } = chatOnlyClient("x");
    const options = { surface: "responses" as const, now: clock([0, 1, 2]) };

    await streamChatCompletion(client, { model: "m", messages: [] }, options);
    await streamChatCompletion(client, { model: "m", messages: [] }, options);

    // Probed once, not once per call — a PDF extraction runs one call per page.
    expect(responsesCreate).toHaveBeenCalledTimes(1);
  });

  it("scopes what it learned to the endpoint that taught it", async () => {
    const a = chatOnlyClient("a");
    const b = chatOnlyClient("b");
    const options = { surface: "responses" as const, now: clock([0, 1, 2]) };

    await streamChatCompletion(
      a.client,
      { model: "m", messages: [] },
      { ...options, surfaceKey: "a" },
    );
    await streamChatCompletion(
      b.client,
      { model: "m", messages: [] },
      { ...options, surfaceKey: "b" },
    );

    expect(a.responsesCreate).toHaveBeenCalledTimes(1);
    expect(b.responsesCreate).toHaveBeenCalledTimes(1);
  });

  it("does not fall back once content has already streamed", async () => {
    // Re-running the call would replay the text the caller has already shown.
    const seen: string[] = [];
    const chatCreate = vi.fn(async () => streamOf([]));
    const responsesCreate = vi.fn(async () =>
      streamOf([
        textDelta("half an answer"),
        {
          get type(): string {
            throw apiError(404, "Not Found");
          },
        },
      ]),
    );
    const client = {
      baseURL: "https://x/v1",
      chat: { completions: { create: chatCreate } },
      responses: { create: responsesCreate },
    } as unknown as OpenAI;

    await expect(
      streamChatCompletion(
        client,
        { model: "m", messages: [] },
        {
          surface: "responses",
          now: clock([0, 1, 2]),
          onContent: async (_t, d) => {
            seen.push(d);
          },
        },
      ),
    ).rejects.toThrow();

    expect(seen).toEqual(["half an answer"]);
    expect(chatCreate).not.toHaveBeenCalled();
  });
});
