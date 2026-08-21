/**
 * OpenAI-compatible AI stub for benchmark runs.
 *
 * WHY A STUB AND NOT A REAL PROVIDER. Three reasons, in order of importance:
 *
 *  1. COST AND DETERMINISM. Exam-result generation fires for every submitted
 *     attempt (src/worker.ts -> generateExamResult), so a 300-student exam-day
 *     run is 300+ real completions. That is money per run and, worse, a
 *     different latency profile every time — which makes regression comparison
 *     meaningless.
 *  2. IT ISOLATES THE THING BEING MEASURED. With a real provider, the worker
 *     spends almost all its time waiting on the network, so the app's own
 *     contention (write lock, event loop) is hidden behind provider latency.
 *     A fast local stub puts the app's bottleneck back in the foreground.
 *  3. NO REAL DATA LEAVES THE BOX. On tier 3 the clone carries production data
 *     (see ec2/sanitize-sut.sh). Pointing its AI provider at a hosted model
 *     would ship real student answers to a third party during a load test.
 *     The stub makes that structurally impossible.
 *
 * SCHEMA-DRIVEN, NOT CANNED. The app asks for strict structured output via
 * `response_format: { type: "json_schema", json_schema }` (src/lib/ai-streaming.ts
 * streamJsonCompletion). A stub returning a hard-coded blob would break the
 * moment a prompt's schema changed, and would break QUIETLY — the worker would
 * mark jobs FAILED and the run would report a suspiciously idle worker. So this
 * generates a response that conforms to whatever schema arrives, which keeps it
 * correct as the app's prompts evolve.
 *
 * Usage:
 *   tsx benchmark/mock-ai/server.ts --port 8099 --latency-ms 400
 * Then point the AI provider at http://<host>:8099/v1 with any api key.
 */

import http from "node:http";
import { parseArgs, num, str } from "../tools/args";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema | JsonSchema[];
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  description?: string;
};

/**
 * Build a value that satisfies `schema`.
 *
 * Deliberately conservative: it honours enum/const, required properties,
 * minItems, and numeric bounds, and falls back to a plausible string otherwise.
 * `seed` makes the output stable for a given (schema, seed) pair so two runs
 * with the same traffic produce the same AI payloads.
 */
function generate(schema: JsonSchema | undefined, seed: number, depth = 0): unknown {
  if (!schema || depth > 12) return null;

  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum[seed % schema.enum.length];
  }
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants) && variants.length > 0) {
    return generate(variants[seed % variants.length], seed + 1, depth + 1);
  }

  // A union type like ["string","null"] — take the first non-null member so
  // required fields are populated rather than nulled out.
  const rawType = Array.isArray(schema.type)
    ? schema.type.find((t) => t !== "null") ?? "string"
    : schema.type;

  switch (rawType) {
    case "object": {
      const out: Record<string, unknown> = {};
      const properties = schema.properties ?? {};
      // Emit EVERY declared property, not just the required ones: OpenAI's
      // strict mode requires all properties be present, and the app's Zod
      // validators are stricter than the schema in places.
      let i = 0;
      for (const [key, child] of Object.entries(properties)) {
        out[key] = generate(child, seed + i++, depth + 1);
      }
      for (const key of schema.required ?? []) {
        if (!(key in out)) out[key] = `stub-${key}`;
      }
      return out;
    }
    case "array": {
      const itemSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
      const count = Math.max(schema.minItems ?? 2, 1);
      const capped = Math.min(count, schema.maxItems ?? count, 5);
      return Array.from({ length: capped }, (_, i) => generate(itemSchema, seed + i * 7, depth + 1));
    }
    case "integer": {
      const min = schema.minimum ?? 0;
      const max = schema.maximum ?? min + 100;
      return Math.round(min + ((seed * 37) % Math.max(1, max - min)));
    }
    case "number": {
      const min = schema.minimum ?? 0;
      const max = schema.maximum ?? min + 1;
      return Math.round((min + ((seed % 100) / 100) * (max - min)) * 100) / 100;
    }
    case "boolean":
      return seed % 2 === 0;
    case "null":
      return null;
    default:
      // Strings carry the property description when there is one, so a human
      // reading a stubbed exam result can tell it came from the stub.
      return `[stub] ${schema.description ?? "generated benchmark response"} #${seed % 1000}`;
  }
}

function unwrapSchema(responseFormat: unknown): JsonSchema | undefined {
  if (!responseFormat || typeof responseFormat !== "object") return undefined;
  const format = responseFormat as { type?: string; json_schema?: { schema?: JsonSchema } | JsonSchema };
  if (format.type !== "json_schema" || !format.json_schema) return undefined;
  const wrapper = format.json_schema as { schema?: JsonSchema };
  // The app passes `json_schema: { name, schema, strict }`; some callers pass
  // the bare schema. Accept both rather than silently returning prose to a
  // caller that will then fail to JSON.parse it.
  return wrapper.schema ?? (format.json_schema as JsonSchema);
}

async function main() {
  const args = parseArgs();
  const port = num(args, "port", 8099);
  const host = str(args, "host", "0.0.0.0");
  /** Simulated provider latency, split across the streamed chunks. */
  const latencyMs = num(args, "latency-ms", 400);
  const chunkCount = num(args, "chunks", 8);

  let requests = 0;

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, requests }));
      return;
    }

    // The app discovers models through this endpoint (admin AI provider config).
    if (req.method === "GET" && (req.url ?? "").endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "bench-stub-1", object: "model", owned_by: "benchmark" }],
        })
      );
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }

    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests++;
      let body: {
        model?: string;
        stream?: boolean;
        response_format?: unknown;
        stream_options?: { include_usage?: boolean };
        messages?: Array<{ role: string; content: unknown }>;
      };
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
        return;
      }

      const schema = unwrapSchema(body.response_format);
      // Seed from the request count so successive calls differ a little but the
      // sequence is reproducible for an identical run.
      const payload = schema
        ? JSON.stringify(generate(schema, requests))
        : `[stub] benchmark response #${requests}`;

      const model = body.model ?? "bench-stub-1";
      const created = Math.floor(Date.now() / 1000);
      const completionTokens = Math.max(1, Math.ceil(payload.length / 4));

      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: `chatcmpl-bench-${requests}`,
            object: "chat.completion",
            created,
            model,
            choices: [{ index: 0, message: { role: "assistant", content: payload }, finish_reason: "stop" }],
            usage: { prompt_tokens: 100, completion_tokens: completionTokens, total_tokens: 100 + completionTokens },
          })
        );
        return;
      }

      // ── SSE stream ──
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });

      // Split on a character boundary. The app reassembles deltas by plain
      // concatenation (streamChatCompletion), so any split is valid as long as
      // the concatenation is byte-exact — which is why this slices the string
      // rather than re-serialising per chunk.
      const size = Math.ceil(payload.length / Math.max(1, chunkCount));
      const pieces: string[] = [];
      for (let i = 0; i < payload.length; i += size) pieces.push(payload.slice(i, i + size));

      const perChunkDelay = Math.max(0, Math.floor(latencyMs / Math.max(1, pieces.length)));
      let index = 0;

      const sendNext = () => {
        if (res.writableEnded) return;

        if (index < pieces.length) {
          const chunk = {
            id: `chatcmpl-bench-${requests}`,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [{ index: 0, delta: { content: pieces[index] }, finish_reason: null }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
          index++;
          setTimeout(sendNext, perChunkDelay);
          return;
        }

        // Final chunk: finish_reason and (when asked) usage. The app reads
        // completion_tokens off this chunk to compute tokens/sec, and treats a
        // missing usage block as "estimate from delta count" — both paths work,
        // but honouring include_usage keeps the measured metrics realistic.
        const final: Record<string, unknown> = {
          id: `chatcmpl-bench-${requests}`,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        if (body.stream_options?.include_usage) {
          final.usage = {
            prompt_tokens: 100,
            completion_tokens: completionTokens,
            total_tokens: 100 + completionTokens,
          };
        }
        res.write(`data: ${JSON.stringify(final)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      };

      // First token after a beat, so TTFT is a realistic non-zero number
      // instead of 0ms (which would make the app's tokens/sec math degenerate).
      setTimeout(sendNext, Math.min(latencyMs, 120));
    });
  });

  server.listen(port, host, () => {
    console.log(`[mock-ai] OpenAI-compatible stub on http://${host}:${port}/v1 (latency ~${latencyMs}ms)`);
  });
}

main().catch((error) => {
  console.error(`mock-ai failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
