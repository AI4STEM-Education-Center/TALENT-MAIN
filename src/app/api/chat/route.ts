import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveProvider, roleToChatUseCase, buildProviderHeaders } from "@/lib/ai-provider";
import { type ChatMessage, isChatMessageArray, buildQuizReviewPrompt } from "@/lib/chat-prompt";

type ChatMode = "chat" | "quiz-review";

async function buildMessages(mode: ChatMode, messages: ChatMessage[]) {
  if (mode !== "quiz-review") {
    return { messages, autoReviewAvailable: false };
  }

  const session = await auth();
  const isStudent = session?.user?.role === "STUDENT";

  if (!isStudent || !session?.user?.id) {
    return { messages: [], autoReviewAvailable: false };
  }

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
    select: { id: true },
  });

  if (!student) {
    return { messages: [], autoReviewAvailable: false };
  }

  const latestAttempt = await prisma.quizAttempt.findFirst({
    where: {
      studentId: student.id,
      completedAt: { not: null },
    },
    orderBy: { completedAt: "desc" },
    include: {
      class: { select: { name: true } },
      quiz: {
        select: {
          name: true,
          topic: { select: { name: true } },
        },
      },
      answers: {
        select: {
          isCorrect: true,
          numericValue: true, // NUMERIC questions: the student's submitted number
          selectedOption: { select: { text: true } },
          question: {
            select: {
              text: true,
              options: { select: { text: true, isCorrect: true } },
              // NUMERIC grading data so the prompt can show numeric evidence.
              answerMode: true,
              answerNumeric: true,
              answerUnit: true,
            },
          },
        },
      },
    },
  });

  if (!latestAttempt || latestAttempt.answers.length === 0) {
    return { messages: [], autoReviewAvailable: false };
  }

  return {
    messages: [
      {
        role: "user" as const,
        content: buildQuizReviewPrompt(latestAttempt),
      },
    ],
    autoReviewAvailable: true,
  };
}

function resolveLocalChatEndpoint(endpoint: string): string {
  const normalized = endpoint.replace(/\/+$/, "");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

async function sendChatCompletion(
  messages: ChatMessage[],
  options?: {
    maxCompletionTokens?: number;
    role?: string;
  }
) {
  const role = options?.role ?? "STUDENT";
  const useCase = roleToChatUseCase(role);
  const provider = await resolveProvider(useCase);

  if (!provider) {
    console.error(`[Chat] No AI provider configured for use case: ${useCase}`);
    return NextResponse.json(
      { error: "AI chat is not configured. Please contact your administrator." },
      { status: 503 }
    );
  }

  const isLocal = provider.providerType === "local";
  const isCloudflare = provider.providerType === "cloudflare";

  // OpenAI and Cloudflare both require a bearer token (the upstream key, or CF_AIG_TOKEN for cloudflare)
  if (!isLocal && !provider.apiKey) {
    console.error(`[Chat] ${provider.providerType} provider has no API key configured`);
    return NextResponse.json(
      { error: `${provider.providerType} integration is not properly configured.` },
      { status: 503 }
    );
  }

  if ((isLocal || isCloudflare) && !provider.baseUrl) {
    console.error(`[Chat] ${provider.providerType} provider has no base URL configured`);
    return NextResponse.json(
      { error: `${provider.providerType} chat integration is not properly configured.` },
      { status: 503 }
    );
  }

  // Construct the OpenAI SDK client from resolved config
  const { OpenAI } = await import("openai");
  const baseURL = (isLocal || isCloudflare)
    ? resolveLocalChatEndpoint(provider.baseUrl!).replace(/\/chat\/completions$/, "")
    : undefined;

  const openai = new OpenAI({
    apiKey: provider.apiKey || "dummy-key-for-local",
    baseURL,
    defaultHeaders: buildProviderHeaders(provider),
    timeout: provider.timeoutMs,
  });

  const serviceTier = provider.serviceTier;

  try {
    const response = await openai.chat.completions.create(
      {
        model: provider.model,
        messages: messages as any,
        stream: true,
        max_completion_tokens: !isLocal ? options?.maxCompletionTokens : undefined,
        max_tokens: isLocal ? options?.maxCompletionTokens : undefined,
        service_tier: !isLocal && (serviceTier === "auto" || serviceTier === "default" || serviceTier === "flex")
          ? (serviceTier as any)
          : undefined,
        // Ask hosted providers to report token usage on the final chunk so the
        // client can show a generated-token count. Local servers often reject
        // this field, so the client falls back to counting streamed deltas.
        stream_options: !isLocal ? { include_usage: true } : undefined,
      },
      {
        maxRetries: isLocal ? 0 : 3,
      }
    );

    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of response) {
            const data = `data: ${JSON.stringify(chunk)}\n\n`;
            controller.enqueue(new TextEncoder().encode(data));
          }
          controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        // Surface the model that produced the reply so the client can show it
        // alongside the TTFT / token-count metrics.
        "X-AI-Model": provider.model,
      },
    });
  } catch (error: any) {
    console.error(`[Chat] ${provider.providerType} error:`, error);
    return NextResponse.json(
      { error: `Failed to communicate with ${isLocal ? "local chat endpoint" : isCloudflare ? "Cloudflare AI Gateway" : "OpenAI"}` },
      { status: error.status || 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const mode = body?.mode === "quiz-review" ? "quiz-review" : "chat";
    const messages = body?.messages;

    if (!isChatMessageArray(messages)) {
      return NextResponse.json({ error: "Messages are required and must be an array" }, { status: 400 });
    }

    const resolved = await buildMessages(mode, messages);
    if (mode === "quiz-review" && !resolved.autoReviewAvailable) {
      return new Response(null, { status: 204 });
    }

    return sendChatCompletion(resolved.messages, {
      maxCompletionTokens: mode === "quiz-review" ? 500 : undefined,
      role: session.user.role,
    });
  } catch (error) {
    console.error("Error handling chat request:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
