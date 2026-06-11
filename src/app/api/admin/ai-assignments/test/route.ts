import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveProvider, buildProviderHeaders, type UseCase } from "@/lib/ai-provider";

const VALID_USE_CASES: UseCase[] = [
  "teacher_chat",
  "student_chat",
  "pdf_description",
  "quiz_extraction",
];

/**
 * POST /api/admin/ai-assignments/test
 * Send a minimal chat completion to verify a use-case assignment works.
 * Body: { useCase: string }
 */
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const body = await req.json();
    const useCase = typeof body.useCase === "string" ? body.useCase.trim() : "";

    if (!VALID_USE_CASES.includes(useCase as UseCase)) {
      return NextResponse.json(
        { error: `Invalid use case. Must be one of: ${VALID_USE_CASES.join(", ")}` },
        { status: 400 }
      );
    }

    const provider = await resolveProvider(useCase as UseCase);

    if (!provider) {
      return NextResponse.json(
        {
          success: false,
          error: `No active provider configured for use case: ${useCase}`,
        },
        { status: 200 }
      );
    }

    const isLocal = provider.providerType === "local";
    const isCloudflare = provider.providerType === "cloudflare";

    const { OpenAI } = await import("openai");

    let baseURL: string | undefined;
    if ((isLocal || isCloudflare) && provider.baseUrl) {
      const normalized = provider.baseUrl.replace(/\/+$/, "");
      baseURL = normalized.endsWith("/chat/completions")
        ? normalized.slice(0, -"/chat/completions".length)
        : normalized;
    }

    const openai = new OpenAI({
      apiKey: provider.apiKey || "dummy-key-for-local",
      baseURL,
      defaultHeaders: buildProviderHeaders(provider),
    });

    const startTime = Date.now();

    const response = await openai.chat.completions.create({
      model: provider.model,
      messages: [
        {
          role: "user",
          content: "Please write a short paragraph testing the connection. Reply with at least 20 words.",
        },
      ],
      max_completion_tokens: 2000,
      temperature: 0,
      service_tier:
        !isLocal &&
          provider.serviceTier &&
          ["auto", "default", "flex"].includes(provider.serviceTier)
          ? (provider.serviceTier as any)
          : undefined,
    });

    const latencyMs = Date.now() - startTime;
    const reply = response.choices?.[0]?.message?.content?.trim() ?? "";

    return NextResponse.json({
      success: true,
      latencyMs,
      reply,
      model: provider.model,
      providerType: provider.providerType,
    });
  } catch (error: any) {
    console.error("[AI_ASSIGNMENT_TEST]", error);
    return NextResponse.json({
      success: false,
      error: error.message || "Connection test failed",
    });
  }
}
