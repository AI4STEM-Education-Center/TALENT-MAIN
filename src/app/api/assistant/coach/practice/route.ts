import { prisma } from "@/lib/prisma";
import {
  cardTargetFields,
  findStoredCard,
  writeStoredCard,
} from "@/lib/assistant/card-interactions";
import { findCoachConversation } from "@/lib/assistant/conversation-store";
import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, rateLimit } from "@/lib/rate-limit";
import { parseJsonBody } from "@/lib/validation";
import { logApiError } from "@/lib/system-log";
import { resolveAssistantSession } from "@/lib/assistant/session";
import {
  gradeCoachPractice,
  practiceAnswerSchema,
  resolveCoachScope,
} from "@/lib/assistant/coach";
import type {
  CoachPracticeInteraction,
  CoachPracticeResult,
} from "@/lib/assistant/coach-types";

export const runtime = "nodejs";

const HOUR_MS = 60 * 60 * 1000;
/** One short answer: far below the app-wide JSON default. */
const BODY_CAP = 8 * 1024;

const bodySchema = practiceAnswerSchema.extend({
  conversationId: cardTargetFields.conversationId,
  cardId: cardTargetFields.cardId,
  source: z.enum(["coach", "widget"]).optional(),
  attemptId: z.string().min(1).max(64),
  questionNumber: z.number().int().min(1).max(500),
});

/** Grade a single inline practice response and record its usage and card state. */
export async function POST(req: Request) {
  try {
    const session = await resolveAssistantSession();
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { ctx, settings } = session;
    const { studentId } = ctx;
    if (!studentId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!settings.enabled) {
      return NextResponse.json(
        { error: "This assistant is currently turned off." },
        { status: 503 },
      );
    }

    // Single-select grading is a yes/no oracle for ONE alternative question, so
    // the budget is what keeps it a practice tool rather than a guessing loop.
    const limited = rateLimit(
      req,
      "assistant-coach-practice",
      120,
      HOUR_MS,
      ctx.userId,
    );
    if (limited) return limited;

    const parsed = await parseJsonBody(bodySchema, req, BODY_CAP);
    if (!parsed.ok) return parsed.response;

    const scope = await resolveCoachScope(
      studentId,
      parsed.data.attemptId,
      parsed.data.questionNumber,
    );
    const graded = scope ? await gradeCoachPractice(scope, parsed.data) : null;
    const notFound = () =>
      NextResponse.json({ error: "Not found" }, { status: 404 });
    if (!scope || !graded) return notFound();

    const owner = { userId: ctx.userId, audience: ctx.audience };
    const { conversationId, cardId, source, versionId, questionId } =
      parsed.data;
    const active =
      conversationId || source === "widget"
        ? null
        : await findCoachConversation(
            owner,
            scope,
            settings.historyRetentionDays,
          );
    const id = conversationId ?? active?.id;
    const findCard = () =>
      findStoredCard(
        { ...owner, studentId },
        settings.historyRetentionDays,
        { conversationId: id },
        ({ ref, study, resultId, questionNumber }) =>
          ref.kind === "practice" &&
          (!cardId || cardId === ref.cardId) &&
          resultId === scope.resultId &&
          questionNumber === scope.questionNumber &&
          ref.versionId === versionId &&
          ref.variantQuestionId === questionId &&
          (source === undefined || (source === "widget") === !!study),
      );
    let card = id ? await findCard() : null;
    if (!card && (conversationId || cardId)) return notFound();
    const shouldPersist = !!card;
    const savedVerdict = (stored: typeof card) => {
      if (stored?.ref.kind !== "practice" || !stored.ref.interaction) {
        return null;
      }
      const interaction = stored.ref.interaction;
      const body: CoachPracticeResult = {
        correct: interaction.correct,
        selectedText: interaction.selectedText,
        questionText: stored.ref.questionText ?? graded.questionText,
        interaction,
      };
      return NextResponse.json(body, {
        headers: { "Cache-Control": "no-store" },
      });
    };
    const existingVerdict = savedVerdict(card);
    if (existingVerdict) return existingVerdict;
    // The account-wide budget alone allows enumeration of every choice. One
    // verdict per published question per day, across ALL source attempts and
    // classes, prevents simply reopening the dialog or changing attemptId to
    // get another guess. Like the shared limiter this is process-local, for
    // the current single-instance deployment, and resets on process restart.
    const verdictBudget = checkRateLimit(
      JSON.stringify([
        "coach-verdict",
        ctx.userId,
        parsed.data.versionId,
        parsed.data.questionId,
      ]),
      1,
      24 * HOUR_MS,
    );
    if (!verdictBudget.allowed) {
      const concurrentVerdict = id ? savedVerdict(await findCard()) : null;
      if (concurrentVerdict) return concurrentVerdict;
      return NextResponse.json(
        { error: "You have already checked this practice question today." },
        {
          status: 429,
          headers: { "Retry-After": String(verdictBudget.retryAfterSeconds) },
        },
      );
    }
    const completedAt = new Date();
    const interaction: CoachPracticeInteraction = {
      status: "completed",
      selectedOptionId: graded.selectedOptionId,
      selectedText: graded.selectedText,
      numericValue: graded.numericValue,
      correct: graded.correct,
      completedAt: completedAt.toISOString(),
    };
    const practiceData = {
      studentId: scope.studentId,
      classId: scope.classId,
      quizId: scope.quizId,
      versionId,
      versionName: `${graded.versionName} (${source === "widget" || card?.study ? "Study assistant" : "Coach"} practice)`,
      quizAttemptId: null,
      activeKey: null,
      questions: JSON.stringify([graded.variant]),
      answers: JSON.stringify(graded.answerRecords),
      score: graded.correct ? 100 : 0,
      completedAt,
    };
    let saved = false;
    for (let retry = 0; retry < 3 && !saved; retry++) {
      const current = card;
      saved = await prisma.$transaction(async (tx) => {
        if (
          shouldPersist &&
          (!current ||
            current.ref.kind !== "practice" ||
            current.ref.interaction ||
            !(await writeStoredCard(tx, current, {
              ...current.ref,
              interaction,
              questionText: graded.questionText,
            })))
        )
          return false;
        await tx.quizPracticeAttempt.create({ data: practiceData });
        return true;
      });
      if (!saved && id) {
        card = await findCard();
        const concurrentVerdict = savedVerdict(card);
        if (concurrentVerdict) return concurrentVerdict;
      }
    }
    if (!saved)
      return NextResponse.json(
        { error: "Card changed. Reload and try again." },
        { status: 409 },
      );
    const body: CoachPracticeResult = {
      correct: graded.correct,
      selectedText: graded.selectedText,
      questionText: graded.questionText,
      interaction,
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
