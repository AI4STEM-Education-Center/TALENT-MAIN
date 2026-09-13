import { describe, it, expect } from "vitest";
import { BODY_TOO_LARGE, readBoundedText } from "@/lib/request-body";

/**
 * A body with NO content-length — the shape that defeats a header-only check.
 * A ReadableStream body makes fetch/undici use chunked transfer encoding.
 */
function chunkedRequest(chunks: string[]): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Request("http://x", {
    method: "POST",
    body: stream,
    // @ts-expect-error -- Node's fetch requires this for a stream body.
    duplex: "half",
  });
}

describe("readBoundedText", () => {
  it("returns a body that fits", async () => {
    const req = new Request("http://x", { method: "POST", body: '{"a":1}' });
    expect(await readBoundedText(req, 1024)).toBe('{"a":1}');
  });

  it("rejects on an over-cap content-length", async () => {
    const req = new Request("http://x", {
      method: "POST",
      body: "x".repeat(2048),
      headers: { "content-length": "2048" },
    });
    expect(await readBoundedText(req, 1024)).toBe(BODY_TOO_LARGE);
  });

  // The header is a hint, not a guarantee: a client can understate it. The
  // streaming count is what actually enforces the bound.
  it("rejects an oversized body that understates its content-length", async () => {
    const req = new Request("http://x", {
      method: "POST",
      body: "x".repeat(4096),
      headers: { "content-length": "10" },
    });
    expect(await readBoundedText(req, 1024)).toBe(BODY_TOO_LARGE);
  });

  it("rejects an oversized body that declares no content-length", async () => {
    // The whole point: a chunked sender skips the header check, so the cap has
    // to be enforced while the stream is being read.
    const req = chunkedRequest(Array.from({ length: 64 }, () => "x".repeat(1024)));
    expect(req.headers.get("content-length")).toBeNull();
    expect(await readBoundedText(req, 1024)).toBe(BODY_TOO_LARGE);
  });

  it("stops reading instead of draining the whole stream", async () => {
    let produced = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        // Would run for a very long time if the reader kept pulling.
        if (produced > 10_000) return controller.close();
        controller.enqueue(encoder.encode("x".repeat(1024)));
      },
    });
    const req = new Request("http://x", {
      method: "POST",
      body: stream,
      // @ts-expect-error -- Node's fetch requires this for a stream body.
      duplex: "half",
    });

    expect(await readBoundedText(req, 4096)).toBe(BODY_TOO_LARGE);
    // Bounded by the cap, not by how much the client was willing to send.
    expect(produced).toBeLessThan(20);
  });

  it("accepts a chunked body under the cap", async () => {
    const req = chunkedRequest(['{"a":', "1}"]);
    expect(await readBoundedText(req, 1024)).toBe('{"a":1}');
  });

  it("treats a missing body as empty", async () => {
    expect(await readBoundedText(new Request("http://x"), 1024)).toBe("");
  });
});
