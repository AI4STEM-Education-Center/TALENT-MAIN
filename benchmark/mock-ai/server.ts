/**
 * OpenAI-compatible stub for benchmark runs.
 *
 * The app resolves every AI use case through a database-backed provider
 * (src/lib/ai-provider.ts) and streams chat completions
 * (src/lib/ai-streaming.ts). Pointing that at a real model during a load test
 * would make results non-reproducible, cost money, and mostly measure someone
 * else's inference queue. This stub replaces it with deterministic, tunable
 * latency so the numbers describe *our* system.
 *
 * The interesting part is response_format handling: the app requests strict
 * `json_schema` responses with schemas built at runtime (misconception ids,
 * material selection, simulation payloads…). Rather than hardcoding each shape,
 * this generates a conforming object from whatever schema arrives — so it stays
 * correct as those prompts evolve.
 *
 * Endpoints: GET /v1/models, POST /v1/chat/completions (stream + non-stream),
 * GET /healthz, GET /stats, POST /reset.
 *
 * Tunables (env):
 *   MOCK_AI_PORT           default 8088
 *   MOCK_AI_TTFT_MS        time to first token, default 400
 *   MOCK_AI_TOKEN_DELAY_MS inter-chunk delay, default 8
 *   MOCK_AI_TOKENS         chunks per completion, default 180
 *   MOCK_AI_JITTER         +/- fraction applied to both delays, default 0.2
 *   MOCK_AI_FAILURE_RATE   fraction of requests answered with a 503, default 0
 */

import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const PORT = Number(process.env.MOCK_AI_PORT || 8088);
const TTFT_MS = Number(process.env.MOCK_AI_TTFT_MS || 400);
const TOKEN_DELAY_MS = Number(process.env.MOCK_AI_TOKEN_DELAY_MS || 8);
const TOKENS = Number(process.env.MOCK_AI_TOKENS || 180);
const JITTER = Number(process.env.MOCK_AI_JITTER || 0.2);
const FAILURE_RATE = Number(process.env.MOCK_AI_FAILURE_RATE || 0);

const stats = { requests: 0, streamed: 0, failed: 0, totalMs: 0 };

/** Deterministic-ish jitter: seeded by request ordinal, not Math.random. */
function jittered(base: number, ordinal: number): number {
  if (JITTER <= 0) return base;
  const wave = Math.sin(ordinal * 12.9898) * 43758.5453;
  const unit = wave - Math.floor(wave); // [0,1)
  return Math.max(0, base * (1 + (unit * 2 - 1) * JITTER));
}

const LOREM = (
  "The student's responses indicate a partial but inconsistent grasp of the " +
  "underlying principle. Errors cluster around unit conversion and sign " +
  "conventions rather than the conceptual setup, which suggests procedural " +
  "practice will help more than re-teaching the theory. Recommended next step " +
  "is a short set of guided worked examples followed by two mixed-practice items."
).split(/\s+/);

// ─── JSON-schema → conforming sample ─────────────────────────────────────────

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  anyOf?: Schema[];
  oneOf?: Schema[];
  description?: string;
};

/**
 * Build the smallest value that satisfies `schema`. Strict OpenAI schemas mark
 * every property required and forbid extras, so "smallest valid" is also
 * "exactly what the caller will try to parse".
 */
function sampleFromSchema(schema: Schema | undefined, depth = 0, ordinal = 0): unknown {
  if (!schema || depth > 8) return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[ordinal % schema.enum.length];
  }
  const branch = schema.anyOf ?? schema.oneOf;
  if (branch && branch.length > 0) return sampleFromSchema(branch[0], depth + 1, ordinal);

  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;

  switch (type) {
    case "object": {
      const out: Record<string, unknown> = {};
      const properties = schema.properties ?? {};
      // Emit every declared property: `strict: true` implies all are required.
      const keys = Object.keys(properties).length > 0 ? Object.keys(properties) : (schema.required ?? []);
      keys.forEach((key, i) => {
        out[key] = sampleFromSchema(properties[key], depth + 1, ordinal + i);
      });
      return out;
    }
    case "array": {
      const count = Math.max(1, schema.minItems ?? 1);
      const capped = Math.min(count, schema.maxItems ?? count);
      return Array.from({ length: capped }, (_, i) =>
        sampleFromSchema(schema.items, depth + 1, ordinal + i)
      );
    }
    case "integer":
    case "number": {
      const lo = schema.minimum ?? 1;
      const hi = schema.maximum ?? lo + 2;
      const value = Math.min(hi, lo + (ordinal % Math.max(1, hi - lo + 1)));
      return type === "integer" ? Math.round(value) : value;
    }
    case "boolean":
      return ordinal % 2 === 0;
    case "null":
      return null;
    case "string":
    default:
      return "benchmark-mock";
  }
}

/**
 * Text the app will try to parse. With a json_schema response_format we emit a
 * schema-conforming object; otherwise plain prose.
 */
function buildBody(requestBody: Record<string, unknown>, ordinal: number): string {
  const format = requestBody.response_format as
    | { type?: string; json_schema?: { schema?: Schema } }
    | undefined;

  if (format?.type === "json_schema" && format.json_schema?.schema) {
    return JSON.stringify(sampleFromSchema(format.json_schema.schema, 0, ordinal));
  }
  if (format?.type === "json_object") {
    return JSON.stringify({ summary: LOREM.join(" "), items: [] });
  }
  return LOREM.join(" ");
}

/**
 * Split into chunk-sized pieces. When the payload is JSON we must not exceed it
 * (a truncated object would fail to parse), so the token budget is a ceiling,
 * not a target — this is why a JSON reply streams fewer chunks than TOKENS.
 */
function chunkText(text: string, maxChunks: number): string[] {
  if (maxChunks <= 1) return [text];
  const size = Math.max(1, Math.ceil(text.length / maxChunks));
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    req.on("data", (part: Buffer) => {
      parts.push(part);
      // The pdf_description use case sends base64 images; cap the buffer so a
      // runaway client can't grow the stub's heap without bound.
      if (parts.reduce((sum, p) => sum + p.length, 0) > 64 * 1024 * 1024) {
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => {
      const raw = Buffer.concat(parts).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

const json = (res: http.ServerResponse, status: number, payload: unknown) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
};

async function handleChatCompletion(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const ordinal = ++stats.requests;
  const startedAt = Date.now();
  const body = await readJson(req);
  const model = typeof body.model === "string" ? body.model : "bench-mock-1";
  const wantsStream = body.stream === true;
  const wantsUsage = Boolean(
    (body.stream_options as { include_usage?: boolean } | undefined)?.include_usage
  );

  // Deterministic injected failures: every Nth request, not a coin flip, so a
  // resilience run is reproducible.
  if (FAILURE_RATE > 0 && ordinal % Math.max(1, Math.round(1 / FAILURE_RATE)) === 0) {
    stats.failed += 1;
    json(res, 503, { error: { message: "mock-ai injected failure", type: "server_error" } });
    return;
  }

  const text = buildBody(body, ordinal);
  const chunks = chunkText(text, Math.max(1, TOKENS));
  const id = `chatcmpl-bench-${ordinal}`;
  // Fixed created timestamp keeps responses byte-stable except for content.
  const created = Math.floor(startedAt / 1000);

  await sleep(jittered(TTFT_MS, ordinal));

  if (!wantsStream) {
    json(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
      ],
      usage: {
        prompt_tokens: 512,
        completion_tokens: chunks.length,
        total_tokens: 512 + chunks.length,
      },
    });
    stats.totalMs += Date.now() - startedAt;
    return;
  }

  stats.streamed += 1;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // Streaming through any buffering proxy would flatten TTFT into a single
    // flush, and src/lib/ai-streaming.ts explicitly detects that case.
    "x-accel-buffering": "no",
  });

  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  for (let i = 0; i < chunks.length; i++) {
    if (res.writableEnded || res.destroyed) return;
    send({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }],
    });
    if (i < chunks.length - 1) await sleep(jittered(TOKEN_DELAY_MS, ordinal + i));
  }

  send({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    ...(wantsUsage
      ? {
          usage: {
            prompt_tokens: 512,
            completion_tokens: chunks.length,
            total_tokens: 512 + chunks.length,
          },
        }
      : {}),
  });
  res.write("data: [DONE]\n\n");
  res.end();
  stats.totalMs += Date.now() - startedAt;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://mock-ai.local");
  const route = url.pathname.replace(/\/+$/, "") || "/";

  void (async () => {
    try {
      if (route === "/healthz" || route === "/") {
        return json(res, 200, { ok: true, service: "bench-mock-ai" });
      }
      if (route === "/stats") {
        return json(res, 200, {
          ...stats,
          meanMs: stats.requests > 0 ? Math.round(stats.totalMs / stats.requests) : 0,
          config: { TTFT_MS, TOKEN_DELAY_MS, TOKENS, JITTER, FAILURE_RATE },
        });
      }
      if (route === "/reset" && req.method === "POST") {
        stats.requests = 0;
        stats.streamed = 0;
        stats.failed = 0;
        stats.totalMs = 0;
        return json(res, 200, { ok: true });
      }
      // Accept the path with or without the /v1 prefix: ai-provider.ts strips a
      // trailing /chat/completions from baseUrl but leaves the rest as given.
      if (/^(\/v1)?\/models$/.test(route)) {
        return json(res, 200, {
          object: "list",
          data: [
            { id: "bench-mock-1", object: "model", owned_by: "benchmark" },
            { id: "bench-mock-fast", object: "model", owned_by: "benchmark" },
          ],
        });
      }
      if (/^(\/v1)?\/chat\/completions$/.test(route) && req.method === "POST") {
        return await handleChatCompletion(req, res);
      }
      json(res, 404, { error: { message: `no mock route for ${req.method} ${route}` } });
    } catch (error) {
      if (!res.headersSent) {
        json(res, 500, { error: { message: (error as Error).message } });
      } else {
        res.end();
      }
    }
  })();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[mock-ai] listening on :${PORT} — ttft=${TTFT_MS}ms tokenDelay=${TOKEN_DELAY_MS}ms ` +
      `tokens=${TOKENS} jitter=${JITTER} failureRate=${FAILURE_RATE}`
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
