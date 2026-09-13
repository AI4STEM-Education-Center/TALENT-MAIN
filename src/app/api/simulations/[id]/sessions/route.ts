import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseBody, simulationSessionCreateSchema } from "@/lib/validation";
import { hasResearchConsent } from "@/lib/consent";

export const runtime = "nodejs";

/**
 * POST /api/simulations/[id]/sessions
 * Open a telemetry session for a student viewing a simulation from their
 * results page. Student-only (staff previews are not tracked); access mirrors
 * the content route — the student must be enrolled in a class the simulation's
 * quiz is assigned to. The optional attemptId links the session to the quiz
 * attempt whose results surfaced the simulation; it is verified to belong to
 * this student (and silently dropped otherwise) so sessions can't be attached
 * to someone else's attempt.
 *
 * This is engagement telemetry, not grading data, so it's gated by research
 * consent (see docs/plans/consent-compliance-plan.md §9): a non-consenting
 * student gets a 200 with `sessionId: null` — the client's SimulationViewer
 * already treats a missing sessionId as "nothing to flush" and never calls
 * the follow-up telemetry-update endpoint, so no row is ever created for
 * this student going forward. The simulation itself is unaffected either way.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [session, { id }] = await Promise.all([auth(), params]);
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "STUDENT") {
    return NextResponse.json(
      { error: "Only student sessions are recorded" },
      { status: 403 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = parseBody(simulationSessionCreateSchema, raw);
  if (!parsed.ok) return parsed.response;

  if (!(await hasResearchConsent(session.user.id))) {
    return NextResponse.json({ sessionId: null });
  }

  const [student, sim] = await Promise.all([
    prisma.student.findUnique({ where: { userId: session.user.id } }),
    prisma.questionSimulation.findUnique({
      where: { id },
      include: { question: { select: { quizId: true } } },
    }),
  ]);
  if (!student || !sim)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  const assignment = await prisma.classQuiz.findFirst({
    where: {
      quizId: sim.question.quizId,
      class: { enrollments: { some: { studentId: student.id } } },
    },
    select: { id: true },
  });
  if (!assignment)
    return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Resolve class/attempt context from the attempt row, keeping it only when
  // it really is this student's attempt.
  let attemptId: string | null = null;
  let classId: string | null = null;
  if (parsed.data.attemptId) {
    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: parsed.data.attemptId },
      select: { id: true, studentId: true, classId: true },
    });
    if (attempt && attempt.studentId === student.id) {
      attemptId = attempt.id;
      classId = attempt.classId;
    }
  }

  const row = await prisma.simulationSession.create({
    data: {
      simulationId: sim.id,
      studentId: student.id,
      classId,
      quizId: sim.question.quizId,
      attemptId,
      surface: parsed.data.surface,
    },
    select: { id: true },
  });

  return NextResponse.json({ sessionId: row.id }, { status: 201 });
}
