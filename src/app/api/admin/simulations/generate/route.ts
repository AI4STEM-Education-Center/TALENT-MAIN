import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enqueueSimulation } from "@/lib/queue";

export const runtime = "nodejs";

// Statuses that a plain (non-force) trigger re-enqueues. READY/DECLINED are
// terminal decisions; PENDING/REVISING are already in flight.
const RETRYABLE = new Set(["FAILED"]);
const IN_FLIGHT = new Set(["PENDING", "REVISING"]);

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
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

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

  const existing = await prisma.questionSimulation.findMany({
    where: { questionId: { in: questionIds } },
  });
  const byQuestionId = new Map(existing.map((s) => [s.questionId, s]));
  const force = scope.scope === "question" && scope.force;

  let created = 0;
  let retried = 0;
  let skipped = 0;
  const toEnqueue: string[] = [];

  for (const questionId of questionIds) {
    const sim = byQuestionId.get(questionId);
    if (!sim) {
      // No skipDuplicates on SQLite; a concurrent trigger may have created the
      // row between the read above and here, so treat a unique violation as a
      // skip rather than failing the whole batch.
      try {
        const row = await prisma.questionSimulation.create({ data: { questionId } });
        created += 1;
        toEnqueue.push(row.id);
      } catch {
        skipped += 1;
      }
      continue;
    }
    if (IN_FLIGHT.has(sim.status)) {
      skipped += 1;
      continue;
    }
    if (RETRYABLE.has(sim.status) || force) {
      await prisma.questionSimulation.update({
        where: { id: sim.id },
        data: { status: "PENDING", errorMessage: null },
      });
      retried += 1;
      toEnqueue.push(sim.id);
      continue;
    }
    skipped += 1;
  }

  // The job is the feature: an enqueue failure marks that row FAILED so it is
  // visible (and retryable) in the dashboard instead of stuck PENDING forever.
  let enqueueFailed = 0;
  for (const simulationId of toEnqueue) {
    try {
      enqueueSimulation(simulationId);
    } catch (e) {
      enqueueFailed += 1;
      const errorMessage = e instanceof Error ? e.message : "Failed to enqueue simulation job";
      await prisma.questionSimulation
        .update({ where: { id: simulationId }, data: { status: "FAILED", errorMessage } })
        .catch(() => {});
    }
  }

  return NextResponse.json(
    {
      scope: scope.scope,
      totalQuestions: questionIds.length,
      created,
      retried,
      skipped,
      enqueued: toEnqueue.length - enqueueFailed,
      enqueueFailed,
    },
    { status: 202 }
  );
}
