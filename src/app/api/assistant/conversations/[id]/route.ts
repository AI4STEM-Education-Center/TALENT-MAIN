import type { AssistantConversationDetail } from "@/lib/assistant/types";
import {
  buildCoachQuestionView,
  coachOpening,
  hydrateCoachActions,
  resolveCoachScope,
} from "@/lib/assistant/coach";
import { hydrateStudyActions } from "@/lib/assistant/study-recommendations";
import { NextResponse } from "next/server";
import { resolveAssistantSession } from "@/lib/assistant/session";
import {
  coachActiveKey,
  readUserConversation,
} from "@/lib/assistant/conversation-store";
import { logApiError } from "@/lib/system-log";

export const runtime = "nodejs";

/**
 * GET /api/assistant/conversations/:id
 *
 * One of the caller's own conversations in full, so the chat panel can reopen it
 * and keep talking.
 *
 * Authorization is the query, as with stored attachments: `readUserConversation`
 * filters on the session's user id, the audience, AND the retention window, so
 * another user's conversation and one that has aged out are both simply 404.
 * Note that the window — not the archive flag — is what closes access: a user is
 * outside their history the moment the cutoff passes, whether or not the worker
 * has swept yet.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await resolveAssistantSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { ctx, settings } = session;
    if (!settings.enabled) {
      return NextResponse.json(
        { error: "This assistant is currently turned off." },
        { status: 503 },
      );
    }

    const { id } = await params;
    const owner = { userId: ctx.userId, audience: ctx.audience };
    const conversation = await readUserConversation(
      owner,
      id,
      settings.historyRetentionDays,
    );
    if (!conversation) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const { summary, finalCoachTranscript } = conversation;
    const attemptId = summary.coachResultId;
    const questionNumber = summary.coachQuestionNumber;
    const scope =
      summary.kind === "coach" && ctx.studentId && attemptId && questionNumber
        ? await resolveCoachScope(ctx.studentId, attemptId, questionNumber)
        : null;
    // A teacher can reopen a previously final quiz. Its final-review messages
    // may contain the key even though the current question view withholds it.
    if (finalCoachTranscript && !scope?.answerKeyAvailable) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const readOnly =
      scope !== null &&
      conversation.coachActiveKey !== coachActiveKey(owner, scope);
    const turns = await Promise.all(
      conversation.turns.map(async ({ actions, ...turn }) => ({
        ...turn,
        cards:
          turn.role !== "assistant" || !ctx.studentId
            ? []
            : scope
              ? await hydrateCoachActions(actions, scope)
              : summary.kind === "chat"
                ? await hydrateStudyActions(actions, ctx.studentId)
                : [],
      })),
    );
    const coach = scope
      ? {
          attemptId: scope.resultId,
          questionNumber: scope.questionNumber,
          opening: coachOpening(scope.questionNumber),
          question: await buildCoachQuestionView(
            readOnly ? { ...scope, answerKeyAvailable: false } : scope,
          ),
        }
      : undefined;
    const body: AssistantConversationDetail = { summary, turns, coach };
    if (readOnly) {
      body.readOnly = true;
      body.readOnlyReason =
        "The quiz's answer-key policy changed. Open a new coaching conversation to continue.";
    }
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    logApiError("ASSISTANT_CONVERSATION_GET", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
