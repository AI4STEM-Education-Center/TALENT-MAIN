import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptApiKey, maskApiKey, decryptApiKey } from "@/lib/crypto";

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

    // Mask API keys - never return the encrypted values
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
    console.error("[AI_PROVIDERS_GET]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * POST /api/admin/ai-providers
 * Create a new AI provider. Encrypts the API key before storing.
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

    if (!name) {
      return NextResponse.json({ error: "Provider name is required" }, { status: 400 });
    }

    if (providerType !== "openai" && providerType !== "local") {
      return NextResponse.json(
        { error: "Provider type must be 'openai' or 'local'" },
        { status: 400 }
      );
    }

    if (providerType === "local" && !baseUrl) {
      return NextResponse.json(
        { error: "Base URL is required for local providers" },
        { status: 400 }
      );
    }

    // Encrypt the API key if provided
    let encrypted: { encrypted: string; iv: string; tag: string } | null = null;
    if (apiKey) {
      encrypted = encryptApiKey(apiKey);
    }

    const provider = await prisma.aiProvider.create({
      data: {
        name,
        providerType,
        baseUrl,
        apiKeyEnc: encrypted?.encrypted ?? null,
        apiKeyIv: encrypted?.iv ?? null,
        apiKeyTag: encrypted?.tag ?? null,
      },
    });

    return NextResponse.json({
      provider: {
        id: provider.id,
        name: provider.name,
        providerType: provider.providerType,
        baseUrl: provider.baseUrl,
        hasApiKey: !!encrypted,
        maskedApiKey: apiKey ? maskApiKey(apiKey) : null,
        isActive: provider.isActive,
      },
    }, { status: 201 });
  } catch (error) {
    console.error("[AI_PROVIDERS_POST]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
