import { prisma } from "@/lib/prisma";
import { decryptApiKey } from "@/lib/crypto";

export type UseCase =
  | "pdf_description"
  | "description_generation"
  | "recommendation"
  | "quiz_extraction"
  | "simulation_generation"
  // The two chat assistants. Separate assignments on purpose: the student and
  // teacher bots are tuned (and costed) independently, and a site may want a
  // cheap local model for one and a hosted vision model for the other.
  | "student_assistant"
  | "teacher_assistant";
export type ProviderType = "openai" | "local" | "cloudflare";

/**
 * Which OpenAI-compatible endpoint a provider is called on.
 *
 * "responses" is `/v1/responses` — OpenAI's item-based API, where a reasoning
 * model's thinking survives across tool rounds and `reasoning` is legal
 * alongside function tools. "chat_completions" is `/v1/chat/completions`, the
 * older transcript API that every OpenAI-compatible server implements.
 *
 * Both are streamed and both report usage, so the choice does not change what
 * we measure (see `src/lib/ai-streaming.ts`) — only how the request is shaped
 * and how the stream is read.
 */
export const API_SURFACES = ["responses", "chat_completions"] as const;
export type ApiSurface = (typeof API_SURFACES)[number];

export function isApiSurface(value: unknown): value is ApiSurface {
  return typeof value === "string" && (API_SURFACES as readonly string[]).includes(value);
}

/**
 * The endpoint to call for a provider, given the admin's stored preference.
 *
 * Every provider type defaults to "responses": OpenAI serves it natively, and
 * Cloudflare AI Gateway exposes a Responses-compatible endpoint. Local servers
 * (llama.cpp, Ollama, LM Studio) mostly do not — but rather than guess from the
 * base URL, the call itself falls back to /chat/completions the first time the
 * endpoint answers "not found", and remembers. An admin who wants to skip that
 * one-time probe can pin "chat_completions" here.
 */
export function resolveApiSurface(stored: string | null | undefined): ApiSurface {
  return isApiSurface(stored) ? stored : "responses";
}

/**
 * Reasoning ("thinking") levels an admin can pin a use case to, sent as the
 * OpenAI-compatible `reasoning_effort` request field. Every provider type we
 * support speaks this field on its /chat/completions endpoint — OpenAI for the
 * GPT-5 family, Cloudflare AI Gateway (which forwards it upstream in
 * compat mode), and local servers such as llama.cpp / vLLM / LM Studio for
 * reasoning checkpoints like gpt-oss.
 *
 * The list mirrors the OpenAI SDK's `ReasoningEffort` union (minus null) —
 * which levels a given model actually accepts differs per model, and we
 * deliberately do NOT validate the level against the model id. A level is only
 * ever sent when an admin sets one, so a non-reasoning model simply never
 * receives the field (see `thinkingParams`).
 *
 * The level belongs to the use-case assignment, not the model: one model is
 * routinely shared between a bulk extraction job that wants "low" and a chat
 * assistant that wants "high".
 */
export const THINKING_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Pick the effective thinking level for an assignment, preferring the
 * per-use-case value and falling back to the legacy per-model one. Anything
 * unrecognised (a level removed from THINKING_LEVELS, or hand-edited data)
 * degrades to null so the request field is omitted rather than rejected.
 */
export function resolveThinkingLevel(
  assignmentLevel: string | null | undefined,
  legacyModelLevel: string | null | undefined
): ThinkingLevel | null {
  if (isThinkingLevel(assignmentLevel)) return assignmentLevel;
  if (assignmentLevel == null && isThinkingLevel(legacyModelLevel)) return legacyModelLevel;
  return null;
}

export interface ResolvedProvider {
  providerType: ProviderType;
  baseUrl: string | null;
  apiKey: string | null;          // for cloudflare, this holds CF_AIG_TOKEN
  model: string;
  serviceTier: string | null;
  /** Reasoning effort for this use case, or null to leave the request field off. */
  thinkingLevel: ThinkingLevel | null;
  cfAigByokAlias: string | null;  // null unless providerType === "cloudflare"
  timeoutMs: number;              // per-request timeout, always resolved (provider override or default)
  /** Endpoint to call, always resolved (admin preference or the default). */
  apiSurface: ApiSurface;
}

/**
 * Default per-request timeout (ms) applied to every AI call. Used when a
 * provider has no explicit `timeoutMs` override. 10 minutes — generous enough
 * for slow local models and long structured-extraction jobs.
 */
export const DEFAULT_AI_TIMEOUT_MS = 600_000;

// In-memory cache to avoid per-request DB hits
let _cache: Map<UseCase, { data: ResolvedProvider; expiresAt: number }> =
  new Map();

const CACHE_TTL_MS = 60_000; // 60 seconds

/**
 * Invalidate the provider cache for all or a specific use case.
 * Call this when admin saves a new assignment.
 */
export function invalidateProviderCache(useCase?: UseCase) {
  if (useCase) {
    _cache.delete(useCase);
  } else {
    _cache.clear();
  }
}

/**
 * Extra HTTP headers for a resolved provider.
 * Currently only used to inject cf-aig-byok-alias for Cloudflare AI Gateway.
 * The CF_AIG_TOKEN is sent via the standard Authorization: Bearer header
 * (set by the OpenAI SDK from `apiKey`), matching Cloudflare's compat-mode sample.
 */
export function buildProviderHeaders(
  provider: ResolvedProvider
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (provider.providerType === "cloudflare" && provider.cfAigByokAlias) {
    headers["cf-aig-byok-alias"] = provider.cfAigByokAlias;
  }
  return headers;
}

/** The spreadable request fragment produced by `thinkingParams`. */
export type ThinkingParams = { reasoning_effort?: ThinkingLevel };

/**
 * The thinking-level fragment to spread into a chat-completion request.
 *
 * Returns `{}` unless the admin pinned a level on the use case, so the
 * `reasoning_effort` key is absent from the request body rather than sent as
 * null — providers that don't understand it (non-reasoning OpenAI models, most
 * local servers) reject an unknown field, so "unset" has to mean "not there".
 * That is what keeps this safe to call on every request for every provider
 * type: it only ever changes a call an admin explicitly opted in.
 */
export function thinkingParams(
  provider: Pick<ResolvedProvider, "thinkingLevel">
): ThinkingParams {
  return provider.thinkingLevel ? { reasoning_effort: provider.thinkingLevel } : {};
}

/**
 * Resolve the active AI provider config for a given use case.
 * Returns null if no assignment exists (caller should return 503).
 *
 * For PDF page descriptions, use "pdf_description".
 * For exam-result summaries, use "description_generation".
 * For study-material recommendations, use "recommendation".
 * For the chat assistants, use "student_assistant" / "teacher_assistant".
 */
export async function resolveProvider(
  useCase: UseCase
): Promise<ResolvedProvider | null> {
  // Check cache first
  const cached = _cache.get(useCase);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  const assignment = await prisma.aiUseCaseAssignment.findUnique({
    where: { useCase },
    include: {
      provider: true,
      model: true,
    },
  });

  if (!assignment) {
    return null;
  }

  if (!assignment.provider.isActive) {
    return null;
  }

  // Decrypt API key / CF_AIG_TOKEN if present
  let apiKey: string | null = null;
  if (
    assignment.provider.apiKeyEnc &&
    assignment.provider.apiKeyIv &&
    assignment.provider.apiKeyTag
  ) {
    try {
      apiKey = decryptApiKey(
        assignment.provider.apiKeyEnc,
        assignment.provider.apiKeyIv,
        assignment.provider.apiKeyTag
      );
    } catch (err) {
      console.error(
        `[AI Provider] Failed to decrypt API key for provider "${assignment.provider.name}":`,
        err instanceof Error ? err.message : err
      );
      return null;
    }
  }

  const resolved: ResolvedProvider = {
    providerType: assignment.provider.providerType as ProviderType,
    baseUrl: assignment.provider.baseUrl,
    apiKey,
    model: assignment.model.modelId,
    serviceTier: assignment.model.serviceTier,
    // The assignment owns the level. `model.thinkingLevel` is the legacy
    // per-model column and is only consulted for configs saved before the
    // setting moved — the admin assignments route carries those over and
    // clears the model value, so this fallback goes quiet on its own.
    thinkingLevel:
      resolveThinkingLevel(assignment.thinkingLevel, assignment.model.thinkingLevel),
    cfAigByokAlias: assignment.provider.cfAigByokAlias,
    timeoutMs: assignment.provider.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
    apiSurface: resolveApiSurface(assignment.provider.apiSurface),
  };

  // Cache the result
  _cache.set(useCase, {
    data: resolved,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return resolved;
}

/**
 * Construct an OpenAI SDK client from a resolved provider. Local/cloudflare
 * providers point the SDK at their base URL (with any trailing
 * `/chat/completions` stripped), while OpenAI uses the default endpoint.
 * Cloudflare's BYOK alias header is injected via `buildProviderHeaders`.
 */
export async function createOpenAIClient(provider: ResolvedProvider) {
  const { OpenAI } = await import("openai");

  const isLocal = provider.providerType === "local";
  const isCloudflare = provider.providerType === "cloudflare";

  let baseURL: string | undefined;
  if ((isLocal || isCloudflare) && provider.baseUrl) {
    baseURL = provider.baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  }

  return new OpenAI({
    apiKey: provider.apiKey || "dummy-key-for-local",
    baseURL,
    defaultHeaders: buildProviderHeaders(provider),
    timeout: provider.timeoutMs,
  });
}
