import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import { triggerSimulations } from "@/lib/simulation-trigger";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

type Scope =
  | { scope: "quiz"; quizId: string }
  | { scope: "question"; questionId: string; force: boolean };

function parseScope(body: Record<string, unknown>): Scope | null {
  if (body.scope === "quiz" && typeof body.quizId === "string" && body.quizId.trim()) {
    return { scope: "quiz", quizId: body.quizId.trim() };
  }
  if (body.scope === "question" && typeof body.questionId === "string" && body.questionId.trim()) {
    return { scope: "question", questionId: body.questionId.trim(), force: body.force === true };
  }
  return null;
}

/**
 * POST /api/simulations/generate
 * Content-owner trigger for simulation generation, from the quiz editor:
 *   { scope: "quiz", quizId }                  — every question of one quiz
 *   { scope: "question", questionId, force? }  — one question; force re-generates
 *                                                even a READY/DECLINED simulation
 *
 * Scoped by the usual canManage rule — a teacher may only generate on their own
 * quizzes, an admin only on the pool. A teacher who wants simulations on a pool
 * quiz imports it first; that copy's artifacts are independent of the pool's
 * (see deepCopyQuiz), so regenerating here never touches the global version.
 * Force is question-scoped on purpose, so a whole-quiz trigger can never
 * discard settled work.
 */
export async function POST(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limited = rateLimit(req, "sim-generate", 20, 60_000, actor.userId);
  if (limited) return limited;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const scope = parseScope(body);
  if (!scope) {
    return NextResponse.json(
      { error: "scope must be 'quiz' (with quizId) or 'question' (with questionId)" },
      { status: 400 }
    );
  }

  let questionIds: string[];
  if (scope.scope === "quiz") {
    const quiz = await prisma.quiz.findUnique({
      where: { id: scope.quizId },
      include: { questions: { select: { id: true } } },
    });
    // 404, not 403: an unmanageable quiz is indistinguishable from a missing
    // one here, matching /api/quizzes/[id].
    if (!quiz || !canManage(actor, quiz)) {
      return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
    }
    questionIds = quiz.questions.map((q) => q.id);
  } else {
    const question = await prisma.question.findUnique({
      where: { id: scope.questionId },
      include: { quiz: { select: { teacherId: true } } },
    });
    if (!question || !canManage(actor, question.quiz)) {
      return NextResponse.json({ error: "Question not found" }, { status: 404 });
    }
    questionIds = [question.id];
  }

  const summary = await triggerSimulations(
    questionIds,
    scope.scope === "question" && scope.force
  );
  return NextResponse.json({ scope: scope.scope, ...summary }, { status: 202 });
}
