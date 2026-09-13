import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptApiKey, maskApiKey, decryptApiKey } from "@/lib/crypto";
import { logApiError } from "@/lib/system-log";
import { isApiSurface } from "@/lib/ai-provider";

const VALID_TYPES = new Set(["openai", "local", "cloudflare"]);

// Bounds for a provider's per-request timeout override (ms). null clears the
// override so the resolver falls back to DEFAULT_AI_TIMEOUT_MS.
const MIN_TIMEOUT_MS = 1_000;        // 1s
const MAX_TIMEOUT_MS = 3_600_000;    // 60min

/**
 * Validate an incoming `timeoutMs` value. Returns either `{ value }` (an int or
 * null when unset/empty) or `{ error }` with a message for a 400 response.
 */
function parseTimeoutMs(raw: unknown): { value: number | null } | { error: string } {
  if (raw === undefined || raw === null || raw === "") return { value: null };
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) {
    return {
      error: `timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms, or null to use the default`,
    };
  }
  return { value: n };
}

/**
 * GET /api/admin/ai-providers
 * List all AI providers. API keys are returned masked.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const providers = await prisma.aiProvider.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        models: {
          orderBy: { modelId: "asc" },
        },
        _count: {
          select: { assignments: true },
        },
      },
    });

    const masked = providers.map((p) => {
      let maskedKey: string | null = null;
      if (p.apiKeyEnc && p.apiKeyIv && p.apiKeyTag) {
        try {
          const decrypted = decryptApiKey(p.apiKeyEnc, p.apiKeyIv, p.apiKeyTag);
          maskedKey = maskApiKey(decrypted);
        } catch {
          maskedKey = "••••(decryption failed)";
        }
      }

      return {
        id: p.id,
        name: p.name,
        providerType: p.providerType,
        baseUrl: p.baseUrl,
        hasApiKey: !!p.apiKeyEnc,
        maskedApiKey: maskedKey,
        cfAigByokAlias: p.cfAigByokAlias,
        timeoutMs: p.timeoutMs,
        // null means "unset" — the client renders the resolved default.
        apiSurface: p.apiSurface,
        isActive: p.isActive,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        models: p.models.map((m) => ({
          id: m.id,
          modelId: m.modelId,
          displayName: m.displayName,
          serviceTier: m.serviceTier,
          isDefault: m.isDefault,
        })),
        assignmentCount: p._count.assignments,
      };
    });

    return NextResponse.json({ providers: masked });
  } catch (error) {
    logApiError("AI_PROVIDERS_GET", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/admin/ai-providers
 * Create a new AI provider. Encrypts the bearer token before storing.
 * For cloudflare providers, apiKey holds the CF_AIG_TOKEN.
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json();

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const providerType = typeof body.providerType === "string" ? body.providerType.trim() : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() || null : null;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() || null : null;
    const cfAigByokAlias = typeof body.cfAigByokAlias === "string"
      ? body.cfAigByokAlias.trim() || null
      : null;

    const timeout = parseTimeoutMs(body.timeoutMs);
    if ("error" in timeout) {
      return NextResponse.json({ error: timeout.error }, { status: 400 });
    }

    // Unset (null) is legal and means "use the per-type default".
    const apiSurface = body.apiSurface == null || body.apiSurface === "" ? null : body.apiSurface;
    if (apiSurface !== null && !isApiSurface(apiSurface)) {
      return NextResponse.json(
        { error: "apiSurface must be 'responses', 'chat_completions', or null" },
        { status: 400 }
      );
    }

    if (!name) {
      return NextResponse.json({ error: "Provider name is required" }, { status: 400 });
    }

    if (!VALID_TYPES.has(providerType)) {
      return NextResponse.json(
        { error: "Provider type must be 'openai', 'local', or 'cloudflare'" },
        { status: 400 }
      );
    }

    if (providerType === "local" && !baseUrl) {
      return NextResponse.json(
        { error: "Base URL is required for local providers" },
        { status: 400 }
      );
    }

    if (providerType === "cloudflare") {
      if (!baseUrl) {
        return NextResponse.json(
          { error: "Base URL is required for Cloudflare AI Gateway providers" },
          { status: 400 }
        );
      }
      if (!apiKey) {
        return NextResponse.json(
          { error: "CF_AIG_TOKEN is required for Cloudflare AI Gateway providers" },
          { status: 400 }
        );
      }
    }

    const encryptedKey = apiKey ? encryptApiKey(apiKey) : null;

    const provider = await prisma.aiProvider.create({
      data: {
        name,
        providerType,
        baseUrl,
        apiKeyEnc: encryptedKey?.encrypted ?? null,
        apiKeyIv: encryptedKey?.iv ?? null,
        apiKeyTag: encryptedKey?.tag ?? null,
        cfAigByokAlias: providerType === "cloudflare" ? cfAigByokAlias : null,
        timeoutMs: timeout.value,
        apiSurface,
      },
    });

    return NextResponse.json({
      provider: {
        id: provider.id,
        name: provider.name,
        providerType: provider.providerType,
        baseUrl: provider.baseUrl,
        hasApiKey: !!encryptedKey,
        maskedApiKey: apiKey ? maskApiKey(apiKey) : null,
        cfAigByokAlias: provider.cfAigByokAlias,
        timeoutMs: provider.timeoutMs,
        apiSurface: provider.apiSurface,
        isActive: provider.isActive,
      },
    }, { status: 201 });
  } catch (error) {
    logApiError("AI_PROVIDERS_POST", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
