import { prisma } from "@/lib/prisma";
import { decryptApiKey } from "@/lib/crypto";

export type UseCase = "teacher_chat" | "student_chat" | "pdf_description";

export interface ResolvedProvider {
  providerType: "openai" | "local";
  baseUrl: string | null;
  apiKey: string | null;
  model: string;
  serviceTier: string | null;
}

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

  // Decrypt API key if present
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
    providerType: assignment.provider.providerType as "openai" | "local",
    baseUrl: assignment.provider.baseUrl,
    apiKey,
    model: assignment.model.modelId,
    serviceTier: assignment.model.serviceTier,
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
