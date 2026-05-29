import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveProvider, roleToChatUseCase, buildProviderHeaders } from "@/lib/ai-provider";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatMode = "chat" | "quiz-review";

function isChatMessageArray(value: unknown): value is ChatMessage[] {
  return Array.isArray(value) && value.every((message) => {
    if (!message || typeof message !== "object") return false;
    const entry = message as { role?: unknown; content?: unknown };
    return (
      (entry.role === "system" || entry.role === "user" || entry.role === "assistant") &&
      typeof entry.content === "string"
    );
  });
}

function buildQuizReviewPrompt(attempt: {
  score: number | null;
  completedAt: Date | null;
  class: { name: string };
  subtopic: { name: string; topic: { name: string } };
  answers: Array<{
    isCorrect: boolean;
    selectedOption: { text: string } | null;
    question: {
      text: string;
      options: Array<{ text: string; isCorrect: boolean }>;
    };
  }>;
}) {
  const incorrectAnswers = attempt.answers.filter((answer) => !answer.isCorrect);
  const correctAnswerCount = attempt.answers.length - incorrectAnswers.length;
  const lines = [
    "You are an educational assistant reviewing a student's latest completed quiz attempt.",
    "Write a concise markdown response directly to the student.",
    "Do not review the quiz question by question.",
    "Summarize the student's main misconceptions or learning gaps across the attempt.",
    "Use exactly three short sections titled Summary, Main Misconceptions, and Next Steps.",
    "Keep the full response under 120 words.",
    "Under Main Misconceptions, use at most 2 bullet points.",
    "Under Next Steps, use at most 2 bullet points.",
    "Only mention a specific question if it is essential evidence for a broader misconception.",
    "",
    `Class: ${attempt.class.name}`,
    `Topic: ${attempt.subtopic.topic.name}`,
    `Module: ${attempt.subtopic.name}`,
    `Score: ${attempt.score ?? 0}%`,
    `Completed at: ${attempt.completedAt?.toISOString() ?? "Unknown"}`,
    `Questions answered: ${attempt.answers.length}`,
    `Correct answers: ${correctAnswerCount}`,
    `Incorrect answers: ${incorrectAnswers.length}`,
    "",
    incorrectAnswers.length > 0
      ? "Evidence from incorrect answers:"
      : "The student answered every question correctly. Reinforce what they understood and suggest one useful next step.",
  ];

  incorrectAnswers.forEach((answer, index) => {
    const correctOptions = answer.question.options
      .filter((option) => option.isCorrect)
      .map((option) => option.text);

    lines.push(
      `${index + 1}. Question: ${answer.question.text}`,
      `   Student selection: ${answer.selectedOption?.text ?? "No answer selected"}`,
      `   Correct answer: ${correctOptions.length > 0 ? correctOptions.join(" | ") : "Unknown"}`
    );
  });

  return lines.join("\n");
}

async function buildMessages(mode: ChatMode, messages: ChatMessage[]) {
  const session = await auth();
  const isStudent = session?.user?.role === "STUDENT";

  if (mode !== "quiz-review") {
    return { messages, autoReviewAvailable: false };
  }

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
      subtopic: {
        select: {
          name: true,
          topic: { select: { name: true } },
        },
      },
      answers: {
        include: {
          selectedOption: { select: { text: true } },
          question: {
            select: {
              text: true,
              options: { select: { text: true, isCorrect: true } },
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
  });

  const serviceTier = provider.serviceTier;

  try {
    const response = await openai.chat.completions.create(
      {
        model: provider.model,
        messages: messages as any,
        temperature: 0.7,
        stream: true,
        max_completion_tokens: !isLocal ? options?.maxCompletionTokens : undefined,
        max_tokens: isLocal ? options?.maxCompletionTokens : undefined,
        service_tier: !isLocal && (serviceTier === "auto" || serviceTier === "default" || serviceTier === "flex")
          ? (serviceTier as any)
          : undefined,
        stream_options: !isLocal && (serviceTier === "auto" || serviceTier === "default" || serviceTier === "flex")
          ? { include_usage: true }
          : undefined,
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
