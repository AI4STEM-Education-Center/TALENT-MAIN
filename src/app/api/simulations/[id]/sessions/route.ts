import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseBody, simulationSessionCreateSchema } from "@/lib/validation";
import { hasResearchConsent } from "@/lib/consent";

export const runtime = "nodejs";

/**
 * POST /api/simulations/[id]/sessions
 * Open a telemetry session for a student opening a simulation pop-up, labelled
 * with the launch surface and device viewport (closed sets, see
 * simulation-telemetry.ts). Student-only (staff previews are not tracked); access mirrors
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

  // Every class of this student's the quiz is assigned to — access requires at
  // least one, and a claimed attempt's class must be among them.
  const assignments = await prisma.classQuiz.findMany({
    where: {
      quizId: sim.question.quizId,
      class: {
        disabledAt: null,
        enrollments: { some: { studentId: student.id } },
      },
    },
    select: { classId: true },
  });
  if (assignments.length === 0)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const assignedClassIds = new Set(assignments.map((a) => a.classId));

  // Resolve class/attempt context from the attempt row, keeping it only when
  // it really is this student's attempt OF THIS SIMULATION'S QUIZ, taken in a
  // class that assigns that quiz to them — otherwise a session for simulation
  // A could be filed under quiz A but attempt/class B. Library opens never
  // carry class context (classId stays null): library browsing is not tied to
  // a results page, and must not surface in instructor-facing class stats.
  let attemptId: string | null = null;
  let classId: string | null = null;
  if (parsed.data.attemptId && parsed.data.surface !== "library") {
    const attempt = await prisma.quizAttempt.findUnique({
      where: { id: parsed.data.attemptId },
      select: { id: true, studentId: true, classId: true, quizId: true },
    });
    if (
      attempt &&
      attempt.studentId === student.id &&
      attempt.quizId === sim.question.quizId &&
      assignedClassIds.has(attempt.classId)
    ) {
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
      viewport: parsed.data.viewport,
    },
    select: { id: true },
  });

  return NextResponse.json({ sessionId: row.id }, { status: 201 });
}
