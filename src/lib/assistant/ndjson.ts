// Incremental NDJSON decoding for the chat stream. A network chunk can split a
// line anywhere — mid-token, mid-escape — so the reader keeps a carry buffer and
// only parses on a newline. Pure and separate from the component so the framing
// is unit-testable without a fake stream.

/**
 * Consume one decoded text chunk. Returns the values that completed on this
 * chunk plus the leftover partial line to pass back in next time.
 *
 * A line that isn't valid JSON is skipped rather than thrown: a proxy injecting
 * a keep-alive comment shouldn't abort a half-written answer.
 */
export function consumeNdjson<T>(
  carry: string,
  chunk: string,
): { values: T[]; carry: string } {
  const combined = carry + chunk;
  const lines = combined.split("\n");
  // The final element is either "" (chunk ended on a newline) or a partial line.
  const carryOut = lines.pop() ?? "";
  const values: T[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      values.push(JSON.parse(trimmed) as T);
    } catch {
      // Not a complete JSON value — drop it and keep reading.
    }
  }
  return { values, carry: carryOut };
}

/** Read a `Response` body as a stream of NDJSON values, in arrival order. */
export async function* readNdjson<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const { values, carry: next } = consumeNdjson<T>(
        carry,
        decoder.decode(value, { stream: true }),
      );
      carry = next;
      for (const parsed of values) yield parsed;
    }
    // Flush a final line that arrived without a trailing newline.
    const { values } = consumeNdjson<T>(carry, "\n");
    for (const parsed of values) yield parsed;
  } finally {
    reader.releaseLock();
  }
}
