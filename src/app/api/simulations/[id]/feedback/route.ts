import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import { enqueueSimulation } from "@/lib/queue";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

const MAX_FEEDBACK_CHARS = 4000;

/**
 * POST /api/simulations/[id]/feedback
 * One review round: a teacher (on their own quiz copy) or an admin (on a pool
 * quiz) reports a problem — a physics/math error, a layout issue, a correction
 * — and the worker revises the artifact. The simulation goes to REVISING; the
 * previous version keeps serving until the revision lands. The job is the
 * feature: an enqueue failure rolls the round back and returns 500.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Each accepted revision re-runs generation against the AI provider.
  const limited = rateLimit(req, "sim-feedback", 30, 60_000);
  if (limited) return limited;

  const [actor, { id }] = await Promise.all([getContentActor(), params]);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sim = await prisma.questionSimulation.findUnique({
    where: { id },
    include: { question: { select: { quiz: { select: { teacherId: true } } } } },
  });
  if (!sim || !canManage(actor, sim.question.quiz)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (sim.status !== "READY" || !sim.storageKey) {
    return NextResponse.json(
      { error: "Only a ready simulation can receive feedback" },
      { status: 409 }
    );
  }

  let body: { feedback?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const feedback = typeof body.feedback === "string" ? body.feedback.trim() : "";
  if (!feedback) return NextResponse.json({ error: "feedback is required" }, { status: 400 });
  if (feedback.length > MAX_FEEDBACK_CHARS) {
    return NextResponse.json(
      { error: `feedback must be at most ${MAX_FEEDBACK_CHARS} characters` },
      { status: 400 }
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: actor.userId },
    select: { firstName: true, lastName: true },
  });

  const [row] = await prisma.$transaction([
    prisma.simulationFeedback.create({
      data: {
        simulationId: sim.id,
        authorUserId: actor.userId,
        authorName: user ? `${user.firstName} ${user.lastName}`.trim() : null,
        feedback,
      },
    }),
    prisma.questionSimulation.update({
      where: { id: sim.id },
      data: { status: "REVISING" },
    }),
  ]);

  try {
    enqueueSimulation(sim.id, row.id);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : "Failed to enqueue revision";
    await prisma
      .$transaction([
        prisma.simulationFeedback.update({
          where: { id: row.id },
          data: { status: "FAILED", errorMessage },
        }),
        prisma.questionSimulation.update({ where: { id: sim.id }, data: { status: "READY" } }),
      ])
      .catch(() => {});
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }

  return NextResponse.json({ id: row.id, status: "REVISING" }, { status: 202 });
}
