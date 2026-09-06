import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  resolveProvider,
  createOpenAIClient,
  thinkingParams,
  isUseCase,
  MODERATION_USE_CASES,
  USE_CASES,
  type ResolvedProvider,
} from "@/lib/ai-provider";
import {
  streamChatCompletion,
  streamOptionsFor,
  transportFor,
} from "@/lib/ai-streaming";
import { logApiError } from "@/lib/system-log";
import { errorMessage } from "@/lib/errors";

/**
 * Connection test for a moderation assignment.
 *
 * Moderation models live on /v1/moderations and reject a chat-shaped request,
 * so testing them with a chat completion would report a working assignment as
 * broken. Sends a benign string and reports whether the endpoint answered, not
 * what it decided — the reply is a status line rather than model prose.
 */
async function testModeration(provider: ResolvedProvider) {
  const client = await createOpenAIClient(provider);
  const startedAt = Date.now();
  const response = await client.moderations.create({
    model: provider.model,
    input: "A short, harmless sentence used to test this connection.",
  });
  const latencyMs = Date.now() - startedAt;
  const flagged = (response.results ?? []).some((r) => r.flagged);

  return {
    success: true,
    latencyMs,
    ttftMs: null,
    generationMs: null,
    tokens: null,
    tokensEstimated: false,
    tokensPerSec: null,
    reply: `Moderation endpoint answered — benign sample ${
      flagged ? "flagged (unexpected)" : "not flagged"
    }.`,
    model: provider.model,
    providerType: provider.providerType,
    serviceTier: provider.serviceTier,
    thinkingLevel: provider.thinkingLevel,
  };
}

/**
 * POST /api/admin/ai-assignments/test
 * Send a minimal request to verify a use-case assignment works — a chat
 * completion, or a moderation call for the use cases served by that endpoint.
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

    if (!isUseCase(useCase)) {
      return NextResponse.json(
        {
          error: `Invalid use case. Must be one of: ${USE_CASES.join(", ")}`,
        },
        { status: 400 },
      );
    }

    const provider = await resolveProvider(useCase);

    if (!provider) {
      return NextResponse.json(
        {
          success: false,
          error: `No active provider configured for use case: ${useCase}`,
        },
        { status: 200 },
      );
    }

    if (MODERATION_USE_CASES.includes(useCase)) {
      return NextResponse.json(await testModeration(provider));
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
            content:
              "Please write a short paragraph testing the connection. Reply with at least 20 words.",
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
        // Absent unless the assigned model has a level pinned, so the test call
        // exercises exactly the request the real use case will send.
        ...thinkingParams(provider),
      },
      streamOptionsFor(transportFor(provider)),
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
      thinkingLevel: provider.thinkingLevel,
    });
  } catch (error: unknown) {
    logApiError("AI_ASSIGNMENT_TEST", error);
    return NextResponse.json({
      success: false,
      error: errorMessage(error) || "Connection test failed",
    });
  }
}
