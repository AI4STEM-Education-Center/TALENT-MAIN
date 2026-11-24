import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import {
  CoachHttpError,
  startOrResumeCoachSession,
} from "@/lib/wrong-answer-coach-engine";
import { logApiError } from "@/lib/system-log";

const startSessionSchema = z.object({
  questionId: z.string().trim().min(1).max(200),
});

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ attemptId: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = rateLimit(
    req,
    "coach-session-start",
    20,
    3_600_000,
    session.user.id,
  );
  if (limited) return limited;

  const [{ attemptId }, student, rawBody] = await Promise.all([
    context.params,
    prisma.student.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    }),
    req.json().catch(() => null),
  ]);
  if (!student) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  const parsed = startSessionSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Valid questionId is required." },
      { status: 400 },
    );
  }

  try {
    const view = await startOrResumeCoachSession({
      attemptId,
      questionId: parsed.data.questionId,
      studentId: student.id,
      studentUserId: session.user.id,
    });
    return NextResponse.json(view);
  } catch (err) {
    if (err instanceof CoachHttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    logApiError("COACH_SESSION_START", err);
    return NextResponse.json(
      { error: "Could not start coaching chat." },
      { status: 500 },
    );
  }
}
