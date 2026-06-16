import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptApiKey, maskApiKey } from "@/lib/crypto";
import { invalidateProviderCache } from "@/lib/ai-provider";

const VALID_TYPES = new Set(["openai", "local", "cloudflare"]);

// Per-request timeout override bounds (ms). Mirrors the create route.
const MIN_TIMEOUT_MS = 1_000;        // 1s
const MAX_TIMEOUT_MS = 3_600_000;    // 60min

/**
 * PATCH /api/admin/ai-providers/[id]
 * Update an existing AI provider.
 * If apiKey is sent as "••••..." (masked placeholder), the field is left unchanged.
 * Sending an empty string clears the field.
 */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    const existing = await prisma.aiProvider.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    }

    const body = await req.json();
    const data: Record<string, unknown> = {};

    if (typeof body.name === "string" && body.name.trim()) {
      data.name = body.name.trim();
    }

    if (typeof body.providerType === "string") {
      const pt = body.providerType.trim();
      if (VALID_TYPES.has(pt)) {
        data.providerType = pt;
      }
    }

    if (body.baseUrl !== undefined) {
      data.baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() || null : null;
    }

    if (typeof body.isActive === "boolean") {
      data.isActive = body.isActive;
    }

    // Per-request timeout override (ms). null/empty clears it (use the default).
    if (body.timeoutMs !== undefined) {
      const raw = body.timeoutMs;
      if (raw === null || raw === "") {
        data.timeoutMs = null;
      } else {
        const n = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isInteger(n) || n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) {
          return NextResponse.json(
            {
              error: `timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} ms, or null to use the default`,
            },
            { status: 400 }
          );
        }
        data.timeoutMs = n;
      }
    }

    // Handle API key / CF_AIG_TOKEN update
    if (typeof body.apiKey === "string") {
      const rawKey = body.apiKey.trim();
      if (rawKey && !rawKey.startsWith("••••")) {
        const encrypted = encryptApiKey(rawKey);
        data.apiKeyEnc = encrypted.encrypted;
        data.apiKeyIv = encrypted.iv;
        data.apiKeyTag = encrypted.tag;
      } else if (rawKey === "") {
        data.apiKeyEnc = null;
        data.apiKeyIv = null;
        data.apiKeyTag = null;
      }
    }

    // Handle BYOK alias (plain string, optional)
    if (body.cfAigByokAlias !== undefined) {
      data.cfAigByokAlias =
        typeof body.cfAigByokAlias === "string" && body.cfAigByokAlias.trim()
          ? body.cfAigByokAlias.trim()
          : null;
    }

    const updated = await prisma.aiProvider.update({
      where: { id },
      data,
    });

    invalidateProviderCache();

    return NextResponse.json({
      provider: {
        id: updated.id,
        name: updated.name,
        providerType: updated.providerType,
        baseUrl: updated.baseUrl,
        hasApiKey: !!updated.apiKeyEnc,
        maskedApiKey: data.apiKeyEnc
          ? maskApiKey(body.apiKey.trim())
          : existing.apiKeyEnc
            ? "••••(unchanged)"
            : null,
        cfAigByokAlias: updated.cfAigByokAlias,
        timeoutMs: updated.timeoutMs,
        isActive: updated.isActive,
      },
    });
  } catch (error) {
    console.error("[AI_PROVIDER_PATCH]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}

/**
 * DELETE /api/admin/ai-providers/[id]
 * Delete a provider and cascade to models + assignments.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    const existing = await prisma.aiProvider.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json({ error: "Provider not found" }, { status: 404 });
    }

    await prisma.aiProvider.delete({ where: { id } });

    invalidateProviderCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[AI_PROVIDER_DELETE]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
