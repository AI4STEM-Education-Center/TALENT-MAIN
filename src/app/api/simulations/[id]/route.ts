import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, canRead, getContentActor } from "@/lib/quiz-access";
import { deleteS3Object } from "@/lib/storage";
import { simulationMetricsView } from "@/lib/simulation-metrics";

export const runtime = "nodejs";

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
    aiMetrics: simulationMetricsView(sim),
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

/**
 * DELETE /api/simulations/[id]
 * Remove a simulation entirely: an admin may delete a pool simulation, a
 * teacher one on their own quiz (same canManage rule as feedback). The row and
 * its feedback (cascade) are deleted, then each S3 artifact this row used — its
 * current key plus every previous version — is removed ONLY when no other
 * simulation or feedback row still references that key. Deep-copied quizzes
 * share artifact keys by reference (see deepCopyQuiz), so a naive object delete
 * would break a sibling's copy; the reference check prevents that. S3 cleanup
 * is best-effort — the DB row is the source of truth, and an orphaned object is
 * harmless — so a storage error does not fail the request.
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const [actor, { id }] = await Promise.all([getContentActor(), params]);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sim = await prisma.questionSimulation.findUnique({
    where: { id },
    include: {
      question: { select: { quiz: { select: { teacherId: true } } } },
      feedback: { select: { previousStorageKey: true } },
    },
  });
  if (!sim || !canManage(actor, sim.question.quiz)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Every S3 key this row is responsible for: the current artifact plus each
  // version snapshotted on a feedback round.
  const bucket = sim.bucket;
  const candidateKeys = new Set<string>();
  if (sim.storageKey) candidateKeys.add(sim.storageKey);
  for (const f of sim.feedback) if (f.previousStorageKey) candidateKeys.add(f.previousStorageKey);

  await prisma.questionSimulation.delete({ where: { id: sim.id } });

  // With the row gone, an artifact is safe to remove only when nothing else
  // points at it (a deep-copied sibling, or another sibling's version history).
  if (bucket) {
    for (const key of candidateKeys) {
      try {
        const [stillUsed, stillReferenced] = await Promise.all([
          prisma.questionSimulation.count({ where: { storageKey: key } }),
          prisma.simulationFeedback.count({ where: { previousStorageKey: key } }),
        ]);
        if (stillUsed === 0 && stillReferenced === 0) {
          await deleteS3Object(bucket, key);
        }
      } catch (e) {
        console.error(`[Simulation] Best-effort delete of artifact ${key} failed:`, e);
      }
    }
  }

  return NextResponse.json({ deleted: true });
}
