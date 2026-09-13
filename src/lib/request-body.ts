/**
 * Size-bounded request-body reading.
 *
 * `await req.text()` / `await req.json()` buffer the WHOLE body into memory
 * before any code can measure it, so a size check written after the await has
 * already lost: a client that omits `content-length` (trivially, by using
 * chunked transfer encoding) can stream gigabytes into the heap of a process
 * that intended to accept a few megabytes, and the check runs — if the process
 * is still alive — only once the damage is done. This app runs as a single
 * instance, so one such request takes down every user.
 *
 * Reading through the stream and stopping at the cap keeps peak memory at the
 * cap regardless of what the client claims or sends.
 */

/** Returned instead of a string when the body exceeds the cap. */
export const BODY_TOO_LARGE = Symbol("BODY_TOO_LARGE");

/**
 * Read a request body as UTF-8 text, aborting once `maxBytes` is exceeded.
 *
 * Returns `BODY_TOO_LARGE` rather than throwing so callers answer with their own
 * status/message. The `content-length` header is honoured first as a fast path —
 * it rejects before a single byte is read — but it is only a hint, and the
 * streaming count below is what actually enforces the bound.
 */
export async function readBoundedText(
  req: Request,
  maxBytes: number,
): Promise<string | typeof BODY_TOO_LARGE> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return BODY_TOO_LARGE;

  const reader = req.body?.getReader();
  if (!reader) return "";

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling: the sender is told to go away and nothing further is
        // retained. Everything buffered so far is at most maxBytes + one chunk.
        await reader.cancel();
        return BODY_TOO_LARGE;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(Buffer.concat(chunks));
}
