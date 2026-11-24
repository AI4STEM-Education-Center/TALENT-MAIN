// OpenAI Decisions API (POST /v1/decisions) client for fast, typed choice /
// predicate / score evaluations (e.g. gpt-6-luna). Reuses ResolvedProvider
// auth, Cloudflare BYOK headers, and bounded timeouts with zero hidden retries
// so every call in Check 2 and distractor auto-labeling is explicitly audited.

import { z } from "zod";
import { buildProviderHeaders, type ResolvedProvider } from "./ai-provider";
import { errorMessage } from "./errors";

export const DEFAULT_DECISIONS_TIMEOUT_MS = 30_000;

export type DecisionsChoiceQuestion = {
  name: string;
  type: "choice";
  instructions: string;
  choices: string[];
};

export type DecisionsPredicateQuestion = {
  name: string;
  type: "predicate";
  instructions: string;
};

export type DecisionsScoreQuestion = {
  name: string;
  type: "score";
  instructions: string;
  levels: string[];
};

export type DecisionsQuestion =
  DecisionsChoiceQuestion | DecisionsPredicateQuestion | DecisionsScoreQuestion;

export interface DecisionsRequest {
  model: string;
  input: string | Record<string, unknown> | Array<Record<string, unknown>>;
  questions: DecisionsQuestion[];
  store?: boolean;
}

export interface DecisionsChoiceProbability {
  value: string;
  probability: number;
}

export interface DecisionsChoiceAnswer {
  name: string;
  type: "choice";
  choice: string;
  probabilities: DecisionsChoiceProbability[];
  confidence: number | null;
}

export interface DecisionsPredicateAnswer {
  name: string;
  type: "predicate";
  value: boolean;
  probability: number;
  confidence?: number;
}

export interface DecisionsScoreAnswer {
  name: string;
  type: "score";
  score: number;
  confidence?: number;
}

export type DecisionsAnswer =
  DecisionsChoiceAnswer | DecisionsPredicateAnswer | DecisionsScoreAnswer;

export interface DecisionsResponse {
  answers: DecisionsAnswer[];
  raw: unknown;
  latencyMs: number;
  model: string;
}

export class DecisionsApiError extends Error {
  status: number | null;
  code: string | null;
  transient: boolean;

  constructor(
    message: string,
    opts: {
      status?: number | null;
      code?: string | null;
      transient?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "DecisionsApiError";
    this.status = opts.status ?? null;
    this.code = opts.code ?? null;
    this.transient = opts.transient ?? false;
  }
}

const probabilityItemSchema = z.object({
  value: z.string(),
  probability: z.number().finite().min(0).max(1),
});

const choiceAnswerSchema = z.object({
  name: z.string().min(1),
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.array(probabilityItemSchema).default([]),
  confidence: z.number().finite().min(0).max(1).optional(),
});

const predicateAnswerSchema = z.object({
  name: z.string().min(1),
  type: z.literal("predicate"),
  value: z.boolean(),
  probability: z.number().finite().min(0).max(1),
  confidence: z.number().finite().min(0).max(1).optional(),
});

const scoreAnswerSchema = z.object({
  name: z.string().min(1),
  type: z.literal("score"),
  score: z.number().finite(),
  confidence: z.number().finite().min(0).max(1).optional(),
});

const decisionsPayloadSchema = z.object({
  answers: z.array(
    z.union([choiceAnswerSchema, predicateAnswerSchema, scoreAnswerSchema]),
  ),
});

/** Resolve the POST /v1/decisions endpoint URL for any configured provider. */
export function resolveDecisionsUrl(
  provider: Pick<ResolvedProvider, "providerType" | "baseUrl">,
): string {
  if (provider.providerType === "openai" && !provider.baseUrl) {
    return "https://api.openai.com/v1/decisions";
  }
  const base = (provider.baseUrl ?? "https://api.openai.com/v1")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|responses|decisions)$/, "");
  return `${base}/decisions`;
}

/** Serialize a DecisionsRequest into the wire body for POST /v1/decisions. */
export function serializeDecisionsBody(
  request: DecisionsRequest,
): Record<string, unknown> {
  return {
    model: request.model,
    input: request.input,
    questions: request.questions.map((q) => {
      if (q.type === "choice") {
        return {
          name: q.name,
          type: "choice",
          instructions: q.instructions,
          choices: q.choices,
        };
      }
      if (q.type === "score") {
        return {
          name: q.name,
          type: "score",
          instructions: q.instructions,
          levels: q.levels,
        };
      }
      return {
        name: q.name,
        type: "predicate",
        instructions: q.instructions,
      };
    }),
    ...(request.store === false ? { store: false } : {}),
  };
}

/** Parse and validate a raw /v1/decisions JSON response payload. */
export function parseDecisionsPayload(raw: unknown): DecisionsAnswer[] {
  const parsed = decisionsPayloadSchema.parse(raw);
  return parsed.answers.map((answer) => {
    if (answer.type === "choice") {
      const topProb =
        answer.probabilities.find((p) => p.value === answer.choice)
          ?.probability ??
        (answer.probabilities.length > 0
          ? Math.max(...answer.probabilities.map((p) => p.probability))
          : null);
      return {
        name: answer.name,
        type: "choice",
        choice: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence ?? topProb,
      };
    }
    return answer;
  });
}

/** True when the error indicates the endpoint does not serve /v1/decisions. */
export function decisionsEndpointUnsupported(error: unknown): boolean {
  if (error instanceof DecisionsApiError) {
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return true;
    }
  }
  const msg = errorMessage(error).toLowerCase();
  return (
    /\b(404|405|501)\b/.test(msg) ||
    (/decisions|endpoint|route|path/.test(msg) &&
      /not found|not supported|not implemented|unknown|does not exist/.test(
        msg,
      ))
  );
}

/** True when the error indicates the configured model does not support /v1/decisions. */
export function decisionsModelUnsupported(error: unknown): boolean {
  if (error instanceof DecisionsApiError && error.status === 400) {
    const msg = error.message.toLowerCase();
    return /model|unsupported|not supported|invalid_model/.test(msg);
  }
  const msg = errorMessage(error).toLowerCase();
  return /model/.test(msg) && /not supported|invalid|decisions/.test(msg);
}

/**
 * Execute one POST /v1/decisions call with bounded timeout and zero hidden
 * retries. Injectable `fetchImpl` supports deterministic unit testing.
 */
export async function createDecisions(
  provider: ResolvedProvider,
  request: DecisionsRequest,
  options: {
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
): Promise<DecisionsResponse> {
  const fetchFn = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = Math.min(
    options.timeoutMs ?? DEFAULT_DECISIONS_TIMEOUT_MS,
    provider.timeoutMs,
  );
  const url = resolveDecisionsUrl(provider);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey || "dummy-key-for-local"}`,
    ...buildProviderHeaders(provider),
  };

  const startedAt = now();
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(serializeDecisionsBody(request)),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new DecisionsApiError(
      `Decisions API network/timeout error: ${errorMessage(err)}`,
      { transient: true },
    );
  }

  const latencyMs = Math.max(0, now() - startedAt);
  const text = await res.text();
  let json: unknown = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  if (!res.ok) {
    const errObj =
      json && typeof json === "object" && "error" in json
        ? (json as { error?: { message?: string; code?: string } }).error
        : undefined;
    const message =
      errObj?.message ||
      text.slice(0, 400) ||
      `Decisions API HTTP ${res.status}`;
    const transient = res.status === 429 || res.status >= 500;
    throw new DecisionsApiError(message, {
      status: res.status,
      code: errObj?.code ?? null,
      transient,
    });
  }

  try {
    const answers = parseDecisionsPayload(json);
    const responseModel =
      json &&
      typeof json === "object" &&
      "model" in json &&
      typeof (json as { model?: unknown }).model === "string" &&
      (json as { model: string }).model.trim()
        ? (json as { model: string }).model.trim()
        : request.model;
    return {
      answers,
      raw: json,
      latencyMs,
      model: responseModel,
    };
  } catch (err) {
    throw new DecisionsApiError(
      `Invalid Decisions API response shape: ${errorMessage(err)}`,
      {
        status: res.status,
        code: "INVALID_RESPONSE_PAYLOAD",
        transient: false,
      },
    );
  }
}
