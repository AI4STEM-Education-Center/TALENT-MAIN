import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { encryptApiKey, maskApiKey } from "@/lib/crypto";
import { invalidateProviderCache } from "@/lib/ai-provider";

/**
 * PATCH /api/admin/ai-providers/[id]
 * Update an existing AI provider.
 * If apiKey is sent as "••••..." (masked placeholder), the key is left unchanged.
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
      if (pt === "openai" || pt === "local") {
        data.providerType = pt;
      }
    }

    if (body.baseUrl !== undefined) {
      data.baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() || null : null;
    }

    if (typeof body.isActive === "boolean") {
      data.isActive = body.isActive;
    }

    // Handle API key update
    if (typeof body.apiKey === "string") {
      const rawKey = body.apiKey.trim();
      // If it starts with "••••" it's the masked placeholder — skip update
      if (rawKey && !rawKey.startsWith("••••")) {
        const encrypted = encryptApiKey(rawKey);
        data.apiKeyEnc = encrypted.encrypted;
        data.apiKeyIv = encrypted.iv;
        data.apiKeyTag = encrypted.tag;
      }
      // If explicitly empty string, clear the API key
      if (rawKey === "") {
        data.apiKeyEnc = null;
        data.apiKeyIv = null;
        data.apiKeyTag = null;
      }
    }

    const updated = await prisma.aiProvider.update({
      where: { id },
      data,
    });

    // Invalidate cache since provider config changed
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

    // Invalidate cache since provider was deleted
    invalidateProviderCache();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[AI_PROVIDER_DELETE]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
