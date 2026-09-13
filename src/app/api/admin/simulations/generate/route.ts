import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { triggerSimulations } from "@/lib/simulation-trigger";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

type Scope =
  | { scope: "pool" }
  | { scope: "quiz"; quizId: string }
  | { scope: "question"; questionId: string; force: boolean };

function parseScope(body: Record<string, unknown>): Scope | null {
  if (body.scope === "pool") return { scope: "pool" };
  if (body.scope === "quiz" && typeof body.quizId === "string" && body.quizId.trim()) {
    return { scope: "quiz", quizId: body.quizId.trim() };
  }
  if (body.scope === "question" && typeof body.questionId === "string" && body.questionId.trim()) {
    return { scope: "question", questionId: body.questionId.trim(), force: body.force === true };
  }
  return null;
}

/**
 * POST /api/admin/simulations/generate
 * Enqueue simulation generation at one of three scopes:
 *   { scope: "pool" }                          — every global-pool question
 *   { scope: "quiz", quizId }                  — every question of one quiz
 *   { scope: "question", questionId, force? }  — one question; force re-generates
 *                                                even a READY/DECLINED simulation
 * Creates missing QuestionSimulation rows and re-enqueues FAILED ones; READY,
 * DECLINED, and in-flight rows are skipped unless force (question scope only).
 *
 * Teachers use the ownership-checked ../../simulations/generate instead.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const limited = rateLimit(req, "admin-sim-generate", 20, 60_000, session.user.id);
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
      { error: "scope must be 'pool', 'quiz' (with quizId), or 'question' (with questionId)" },
      { status: 400 }
    );
  }

  // Resolve the target question ids.
  let questionIds: string[];
  if (scope.scope === "pool") {
    const questions = await prisma.question.findMany({
      where: { quiz: { teacherId: null } },
      select: { id: true },
    });
    questionIds = questions.map((q) => q.id);
  } else if (scope.scope === "quiz") {
    const quiz = await prisma.quiz.findUnique({
      where: { id: scope.quizId },
      include: { questions: { select: { id: true } } },
    });
    if (!quiz) return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
    questionIds = quiz.questions.map((q) => q.id);
  } else {
    const question = await prisma.question.findUnique({ where: { id: scope.questionId } });
    if (!question) return NextResponse.json({ error: "Question not found" }, { status: 404 });
    questionIds = [question.id];
  }

  const summary = await triggerSimulations(
    questionIds,
    scope.scope === "question" && scope.force
  );
  return NextResponse.json({ scope: scope.scope, ...summary }, { status: 202 });
}
