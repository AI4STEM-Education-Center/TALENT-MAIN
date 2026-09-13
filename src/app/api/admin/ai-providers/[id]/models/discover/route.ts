import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { decryptApiKey } from "@/lib/crypto";
import { logApiError } from "@/lib/system-log";

/**
 * POST /api/admin/ai-providers/[id]/models/discover
 * For local / Cloudflare providers: fetch the /models endpoint to discover available models.
 */
export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    const provider = await prisma.aiProvider.findUnique({ where: { id } });
    if (!provider) {
      return NextResponse.json(
        { error: "Provider not found" },
        { status: 404 },
      );
    }

    if (!provider.baseUrl) {
      return NextResponse.json(
        { error: "Provider has no base URL configured" },
        { status: 400 },
      );
    }

    // Decrypt bearer token if present (CF_AIG_TOKEN for cloudflare)
    let apiKey: string | null = null;
    if (provider.apiKeyEnc && provider.apiKeyIv && provider.apiKeyTag) {
      try {
        apiKey = decryptApiKey(
          provider.apiKeyEnc,
          provider.apiKeyIv,
          provider.apiKeyTag,
        );
      } catch {
        return NextResponse.json(
          { error: "Failed to decrypt provider API key" },
          { status: 500 },
        );
      }
    }

    // Build the models endpoint URL
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const modelsUrl = baseUrl.endsWith("/chat/completions")
      ? baseUrl.slice(0, -"/chat/completions".length) + "/models"
      : baseUrl + "/models";

    const headers: Record<string, string> = {};
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    if (provider.providerType === "cloudflare" && provider.cfAigByokAlias) {
      headers["cf-aig-byok-alias"] = provider.cfAigByokAlias;
    }

    const response = await fetch(modelsUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: `Models endpoint returned ${response.status}` },
        { status: 502 },
      );
    }

    const data: unknown = await response.json();

    // Normalize the response — handle both array and { data: [] } formats
    const rawModels = Array.isArray(data)
      ? data
      : data &&
          typeof data === "object" &&
          Array.isArray((data as { data?: unknown }).data)
        ? (data as { data: unknown[] }).data
        : [];

    const modelIds = Array.from(
      new Set(
        rawModels.flatMap((entry: unknown) => {
          let id = "";
          if (typeof entry === "string") {
            id = entry.trim();
          } else if (entry && typeof entry === "object") {
            const obj = entry as {
              id?: unknown;
              name?: unknown;
              model?: unknown;
            };
            const raw = obj.id ?? obj.name ?? obj.model;
            id = typeof raw === "string" ? raw.trim() : "";
          }
          return id ? [id] : [];
        }),
      ),
    ).sort((a, b) => a.localeCompare(b));

    return NextResponse.json({ models: modelIds });
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      return NextResponse.json(
        { error: "Models endpoint timed out after 10 seconds" },
        { status: 504 },
      );
    }

    logApiError("AI_MODELS_DISCOVER", error);
    return NextResponse.json(
      { error: "Failed to discover models from the provider" },
      { status: 502 },
    );
  }
}
