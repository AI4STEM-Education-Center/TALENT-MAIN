import { describe, it, expect } from "vitest";
import { consumeNdjson, readNdjson } from "./ndjson";

type Event = { type: string; text?: string };

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("consumeNdjson", () => {
  it("parses whole lines and carries the partial remainder", () => {
    const first = consumeNdjson<Event>("", '{"type":"a"}\n{"type":"b"');
    expect(first.values).toEqual([{ type: "a" }]);
    expect(first.carry).toBe('{"type":"b"');

    const second = consumeNdjson<Event>(first.carry, "}\n");
    expect(second.values).toEqual([{ type: "b" }]);
    expect(second.carry).toBe("");
  });

  it("reassembles a value split across three chunks", () => {
    let carry = "";
    const all: Event[] = [];
    for (const chunk of ['{"ty', 'pe":"del', 'ta","text":"hi"}\n']) {
      const step = consumeNdjson<Event>(carry, chunk);
      carry = step.carry;
      all.push(...step.values);
    }
    expect(all).toEqual([{ type: "delta", text: "hi" }]);
  });

  it("skips a garbage line instead of throwing", () => {
    const { values } = consumeNdjson<Event>("", 'not json\n{"type":"ok"}\n');
    expect(values).toEqual([{ type: "ok" }]);
  });

  it("ignores blank lines", () => {
    const { values } = consumeNdjson<Event>("", '\n\n{"type":"ok"}\n\n');
    expect(values).toEqual([{ type: "ok" }]);
  });
});

describe("readNdjson", () => {
  it("yields every event in arrival order across chunk boundaries", async () => {
    const stream = streamOf([
      '{"type":"delta","text":"He',
      'llo"}\n{"type":"done"}\n',
    ]);
    const events: Event[] = [];
    for await (const event of readNdjson<Event>(stream)) events.push(event);
    expect(events).toEqual([
      { type: "delta", text: "Hello" },
      { type: "done" },
    ]);
  });

  it("flushes a final line that arrived without a trailing newline", async () => {
    const events: Event[] = [];
    for await (const event of readNdjson<Event>(
      streamOf(['{"type":"last"}']),
    )) {
      events.push(event);
    }
    expect(events).toEqual([{ type: "last" }]);
  });

  it("decodes a multi-byte character split across chunks", async () => {
    // "é" is 0xC3 0xA9; send the bytes in two chunks.
    const encoder = new TextEncoder();
    const full = encoder.encode('{"type":"delta","text":"é"}\n');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(full.slice(0, 24));
        controller.enqueue(full.slice(24));
        controller.close();
      },
    });
    const events: Event[] = [];
    for await (const event of readNdjson<Event>(stream)) events.push(event);
    expect(events).toEqual([{ type: "delta", text: "é" }]);
  });
});
