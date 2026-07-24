import { prisma } from "@/lib/prisma";
import { decryptApiKey } from "@/lib/crypto";

export type UseCase =
  | "teacher_chat"
  | "student_chat"
  | "pdf_description"
  | "quiz_extraction"
  | "simulation_generation";
export type ProviderType = "openai" | "local" | "cloudflare";

export interface ResolvedProvider {
  providerType: ProviderType;
  baseUrl: string | null;
  apiKey: string | null;          // for cloudflare, this holds CF_AIG_TOKEN
  model: string;
  serviceTier: string | null;
  cfAigByokAlias: string | null;  // null unless providerType === "cloudflare"
  timeoutMs: number;              // per-request timeout, always resolved (provider override or default)
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

/**
 * Resolve the active AI provider config for a given use case.
 * Returns null if no assignment exists (caller should return 503).
 *
 * For ADMIN and TEACHER roles, use "teacher_chat".
 * For STUDENT role, use "student_chat".
 * For PDF processing, use "pdf_description".
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
    cfAigByokAlias: assignment.provider.cfAigByokAlias,
    timeoutMs: assignment.provider.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
  };

  // Cache the result
  _cache.set(useCase, {
    data: resolved,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return resolved;
}

/**
 * Map a user role to the appropriate chat use case.
 */
export function roleToChatUseCase(
  role: string
): UseCase {
  if (role === "STUDENT") return "student_chat";
  // ADMIN and TEACHER both use teacher_chat
  return "teacher_chat";
}

/**
 * Construct an OpenAI SDK client from a resolved provider. Mirrors the inline
 * client setup in the chat route: local/cloudflare providers point the SDK at
 * their base URL (with any trailing `/chat/completions` stripped), while OpenAI
 * uses the default endpoint. Cloudflare's BYOK alias header is injected via
 * `buildProviderHeaders`.
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
