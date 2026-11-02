import { NextResponse } from "next/server";
import { z } from "zod";
import { rateLimit } from "@/lib/rate-limit";
import { logApiError } from "@/lib/system-log";
import { resolveAssistantSession } from "@/lib/assistant/session";
import {
  buildCoachQuestionView,
  coachOpening,
  hydrateCoachActions,
  resolveCoachScope,
} from "@/lib/assistant/coach";
import {
  findCoachConversation,
  loadConversationHistory,
  MAX_TRANSCRIPT_TURNS,
} from "@/lib/assistant/conversation-store";
import type { CoachSessionView } from "@/lib/assistant/coach-types";

export const runtime = "nodejs";

const HOUR_MS = 60 * 60 * 1000;

const querySchema = z.object({
  attemptId: z.string().min(1).max(64),
  questionNumber: z.coerce.number().int().min(1).max(500),
});

/**
 * GET /api/assistant/coach?attemptId=…&questionNumber=…
 *
 * Opens the coach dialog for one missed question: the original question for the
 * reference pane, the assistant's opening line, and — if the student has been
 * here before and is still inside their history window — the conversation so
 * far, with its cards re-checked and re-rendered. Every unverifiable request
 * (another student's attempt, a question they got right, an unknown id) is the
 * same 404.
 */
export async function GET(req: Request) {
  try {
    const session = await resolveAssistantSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { ctx, settings } = session;
    if (!ctx.studentId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!settings.enabled) {
      return NextResponse.json(
        { error: "This assistant is currently turned off." },
        { status: 503 },
      );
    }

    const limited = rateLimit(
      req,
      "assistant-coach-open",
      240,
      HOUR_MS,
      ctx.userId,
    );
    if (limited) return limited;

    const query = querySchema.safeParse(
      Object.fromEntries(new URL(req.url).searchParams),
    );
    if (!query.success) {
      return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    }

    const scope = await resolveCoachScope(
      ctx.studentId,
      query.data.attemptId,
      query.data.questionNumber,
    );
    if (!scope) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const conversation = await findCoachConversation(
      { userId: ctx.userId, audience: ctx.audience },
      scope,
      settings.historyRetentionDays,
    );
    const [question, stored] = await Promise.all([
      buildCoachQuestionView(scope),
      conversation
        ? loadConversationHistory(conversation.id, MAX_TRANSCRIPT_TURNS)
        : [],
    ]);
    const turns = await Promise.all(
      stored.map(async (turn) => ({
        role: turn.role,
        content: turn.content,
        actions:
          turn.role === "assistant"
            ? await hydrateCoachActions(turn.actions, scope)
            : [],
      })),
    );

    const body: CoachSessionView = {
      question,
      opening: coachOpening(scope.questionNumber),
      conversationId: conversation?.id ?? null,
      turns,
    };
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logApiError("ASSISTANT_COACH", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
