import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canRead, getContentActor } from "@/lib/quiz-access";

/**
 * GET /api/simulations/[id]
 * Staff detail for one simulation: metadata + full feedback history (no
 * storage keys — content is served only through ./content). Admins see
 * everything; teachers see sims on their own quizzes and pool quizzes.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const [actor, { id }] = await Promise.all([getContentActor(), params]);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sim = await prisma.questionSimulation.findUnique({
    where: { id },
    include: {
      question: { select: { quiz: { select: { teacherId: true } } } },
      feedback: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!sim || (actor.role !== "ADMIN" && !canRead(actor, sim.question.quiz))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: sim.id,
    status: sim.status,
    topic: sim.topic,
    title: sim.title,
    learningGoal: sim.learningGoal,
    declineReason: sim.declineReason,
    errorMessage: sim.errorMessage,
    version: sim.version,
    hasContent: sim.storageKey !== null,
    aiModel: sim.aiModel,
    updatedAt: sim.updatedAt,
    feedback: sim.feedback.map((f) => ({
      id: f.id,
      authorName: f.authorName,
      feedback: f.feedback,
      status: f.status,
      errorMessage: f.errorMessage,
      createdAt: f.createdAt,
    })),
  });
}
