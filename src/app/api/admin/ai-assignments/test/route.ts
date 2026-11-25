import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import {
  resolveProvider,
  createOpenAIClient,
  thinkingParams,
  isUseCase,
  DECISIONS_USE_CASES,
  MODERATION_USE_CASES,
  USE_CASES,
  type ResolvedProvider,
} from "@/lib/ai-provider";
import {
  createDecisions,
  decisionsEndpointUnsupported,
  decisionsModelUnsupported,
} from "@/lib/ai-decisions";
import {
  streamChatCompletion,
  streamOptionsFor,
  transportFor,
} from "@/lib/ai-streaming";
import {
  isModerationModel,
  moderationEndpointUnsupported,
} from "@/lib/guardrail-fence";
import { logApiError } from "@/lib/system-log";
import { errorMessage } from "@/lib/errors";

/**
 * Explain a failed moderation call in terms of what the admin has to change.
 *
 * Both failure modes here are configuration rather than faults, and the raw
 * provider error names neither: a gateway that has no moderations endpoint
 * needs a different PROVIDER, while a chat model on a provider that does have
 * one needs a different MODEL. Reported through the connection test because
 * the runtime path deliberately swallows this — moderation fails open, so an
 * assignment that can never work is otherwise invisible.
 */
function moderationFailure(error: unknown, provider: ResolvedProvider): string {
  const raw = errorMessage(error) || "the call failed";

  if (moderationEndpointUnsupported(error)) {
    return (
      `This provider does not implement the /v1/moderations endpoint, so content ` +
      `moderation cannot run on it — assign an OpenAI provider with a moderation ` +
      `model (omni-moderation-latest) instead, or leave this unassigned to turn ` +
      `the check off. Provider said: ${raw}`
    );
  }

  if (!isModerationModel(provider.model)) {
    return (
      `${provider.model} is a chat model — /v1/moderations only accepts a ` +
      `moderation model such as omni-moderation-latest. Provider said: ${raw}`
    );
  }

  return raw;
}

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

  let response;
  try {
    response = await client.moderations.create({
      model: provider.model,
      input: "A short, harmless sentence used to test this connection.",
    });
  } catch (error) {
    return { success: false, error: moderationFailure(error, provider) };
  }

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
 * Explain a failed Decisions API (/v1/decisions) call in terms of what the
 * admin needs to change (provider vs model).
 */
function decisionsFailure(error: unknown, provider: ResolvedProvider): string {
  const raw = errorMessage(error) || "the call failed";

  if (decisionsEndpointUnsupported(error)) {
    return (
      `This provider does not implement the POST /v1/decisions endpoint — ` +
      `assign an OpenAI provider (or a gateway exposing /v1/decisions) with a ` +
      `Decisions-capable model such as gpt-6-luna. Provider said: ${raw}`
    );
  }

  if (decisionsModelUnsupported(error)) {
    return (
      `${provider.model} does not support the /v1/decisions endpoint — assign a ` +
      `Decisions-capable model such as gpt-6-luna. Provider said: ${raw}`
    );
  }

  return raw;
}

/**
 * Connection test for an OpenAI Decisions API assignment (e.g. Check 2
 * explanation classification). Sends a benign physics classification choice
 * probe to POST /v1/decisions and verifies choice, probabilities, and confidence.
 */
async function testDecisions(provider: ResolvedProvider) {
  let response;
  try {
    response = await createDecisions(provider, {
      model: provider.model,
      input:
        "Question: A ball is thrown straight up. At its highest point, what is its acceleration?\n" +
        "Correct answer: Downward at g.\n" +
        "Student explanation: Velocity is zero at the top, but gravity still pulls downward so acceleration is g downward.",
      questions: [
        {
          name: "check2_probe",
          type: "choice",
          instructions:
            "Classify the student explanation as 'sound' (uses correct physics), " +
            "'M_TEST' (claims zero velocity means zero acceleration), or 'neither'.",
          choices: [
            { value: "sound", description: "Uses correct physics" },
            { value: "neither", description: "Neither sound nor M_TEST" },
            {
              value: "M_TEST",
              description: "Claims zero velocity means zero acceleration",
            },
          ],
        },
      ],
    });
  } catch (error) {
    return { success: false, error: decisionsFailure(error, provider) };
  }

  const answer = response.answers.find(
    (a) => a.name === "check2_probe" && a.type === "choice",
  );
  const allowedProbeChoices = new Set(["sound", "neither", "M_TEST"]);
  if (
    !answer ||
    answer.type !== "choice" ||
    !allowedProbeChoices.has(answer.choice) ||
    (answer.confidence === null && answer.probabilities.length === 0)
  ) {
    return {
      success: false,
      error:
        "Decisions endpoint responded without a valid in-set 'choice' answer and confidence/probabilities for check2_probe.",
    };
  }

  const confPct =
    answer.confidence !== null ? Math.round(answer.confidence * 100) : null;
  return {
    success: true,
    latencyMs: response.latencyMs,
    ttftMs: null,
    generationMs: null,
    tokens: null,
    tokensEstimated: false,
    tokensPerSec: null,
    reply: `Decisions endpoint (/v1/decisions) answered — choice: ${answer.choice} (${confPct !== null ? `confidence ${confPct}%, ` : ""}${response.latencyMs} ms).`,
    model: response.model,
    providerType: provider.providerType,
    serviceTier: null,
    thinkingLevel: null,
  };
}

/**
 * POST /api/admin/ai-assignments/test
 * Send a minimal request to verify a use-case assignment works — a chat
 * completion, or a moderation call for the use cases served by that endpoint.
 * Body: { useCase: string }
 */
export async function POST(req: Request) {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;

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

    if (DECISIONS_USE_CASES.includes(useCase)) {
      return NextResponse.json(await testDecisions(provider));
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
