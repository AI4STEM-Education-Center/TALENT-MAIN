import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Simulation status counts for one quiz. "missing" = questions with no
// QuestionSimulation row at all (never triggered).
export type SimulationCounts = {
  ready: number;
  declined: number;
  failed: number;
  inFlight: number; // PENDING + REVISING
  missing: number;
};

function emptyCounts(): SimulationCounts {
  return { ready: 0, declined: 0, failed: 0, inFlight: 0, missing: 0 };
}

function tally(counts: SimulationCounts, status: string | null) {
  if (status === "READY") counts.ready += 1;
  else if (status === "DECLINED") counts.declined += 1;
  else if (status === "FAILED") counts.failed += 1;
  else if (status === "PENDING" || status === "REVISING") counts.inFlight += 1;
  else counts.missing += 1;
}

/**
 * GET /api/admin/simulations            — global-pool coverage summary
 * GET /api/admin/simulations?quizId=xxx — per-question detail for one quiz
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const quizId = req.nextUrl.searchParams.get("quizId");

  if (quizId) {
    const quiz = await prisma.quiz.findUnique({
      where: { id: quizId },
      include: {
        topic: { select: { name: true } },
        questions: {
          orderBy: { createdAt: "asc" },
          include: { simulation: { include: { _count: { select: { feedback: true } } } } },
        },
      },
    });
    if (!quiz) return NextResponse.json({ error: "Quiz not found" }, { status: 404 });

    return NextResponse.json({
      quiz: { id: quiz.id, name: quiz.name, topicName: quiz.topic?.name ?? null },
      questions: quiz.questions.map((q) => ({
        id: q.id,
        title: q.title,
        text: q.text,
        simulation: q.simulation
          ? {
              id: q.simulation.id,
              status: q.simulation.status,
              topic: q.simulation.topic,
              title: q.simulation.title,
              learningGoal: q.simulation.learningGoal,
              declineReason: q.simulation.declineReason,
              errorMessage: q.simulation.errorMessage,
              version: q.simulation.version,
              hasContent: q.simulation.storageKey !== null,
              feedbackCount: q.simulation._count.feedback,
              aiModel: q.simulation.aiModel,
              updatedAt: q.simulation.updatedAt,
            }
          : null,
      })),
    });
  }

  const quizzes = await prisma.quiz.findMany({
    where: { teacherId: null },
    include: {
      topic: { select: { name: true } },
      questions: { select: { simulation: { select: { status: true } } } },
    },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });

  const totals = emptyCounts();
  const rows = quizzes.map((quiz) => {
    const counts = emptyCounts();
    for (const q of quiz.questions) {
      tally(counts, q.simulation?.status ?? null);
      tally(totals, q.simulation?.status ?? null);
    }
    return {
      id: quiz.id,
      name: quiz.name,
      topicName: quiz.topic?.name ?? null,
      questionCount: quiz.questions.length,
      counts,
    };
  });

  return NextResponse.json({ quizzes: rows, totals });
}
