import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveProvider, createOpenAIClient, type UseCase } from "@/lib/ai-provider";
import { streamChatCompletion } from "@/lib/ai-streaming";
import { logApiError } from "@/lib/system-log";

const VALID_USE_CASES: UseCase[] = [
  "pdf_description",
  "description_generation",
  "recommendation",
  "quiz_extraction",
  "simulation_generation",
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

    // createOpenAIClient handles base-URL normalization, BYOK headers, and the
    // provider's resolved timeout, so the connection test uses the exact same
    // client config as real calls.
    const openai = await createOpenAIClient(provider);

    const { text, metrics } = await streamChatCompletion(
      openai,
      {
        model: provider.model,
        messages: [
          {
            role: "user",
            content: "Please write a short paragraph testing the connection. Reply with at least 20 words.",
          },
        ],
        max_completion_tokens: !isLocal ? 2000 : undefined,
        max_tokens: isLocal ? 2000 : undefined,
        service_tier:
          !isLocal &&
            provider.serviceTier &&
            ["auto", "default", "flex"].includes(provider.serviceTier)
            ? (provider.serviceTier as any)
            : undefined,
      },
      { includeUsage: !isLocal }
    );

    return NextResponse.json({
      success: true,
      latencyMs: metrics.totalMs,
      ttftMs: metrics.ttftMs,
      // null when the response wasn't delivered incrementally — see
      // AiCallMetrics.generationMs.
      generationMs: metrics.generationMs,
      tokens: metrics.completionTokens,
      tokensEstimated: metrics.tokensEstimated,
      tokensPerSec: metrics.tokensPerSec,
      reply: text.trim(),
      model: provider.model,
      providerType: provider.providerType,
      serviceTier: provider.serviceTier,
    });
  } catch (error: any) {
    logApiError("AI_ASSIGNMENT_TEST", error);
    return NextResponse.json({
      success: false,
      error: error.message || "Connection test failed",
    });
  }
}
