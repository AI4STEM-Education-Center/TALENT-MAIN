import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getCoachEligibilityForAttempt } from "@/lib/wrong-answer-coach-engine";
import { logApiError } from "@/lib/system-log";

export async function GET(
  _req: Request,
  context: { params: Promise<{ attemptId: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ attemptId }, student] = await Promise.all([
    context.params,
    prisma.student.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    }),
  ]);
  if (!student) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  try {
    const items = await getCoachEligibilityForAttempt({
      attemptId,
      studentId: student.id,
      studentUserId: session.user.id,
    });
    return NextResponse.json({ items });
  } catch (err) {
    logApiError("COACH_ELIGIBILITY_GET", err);
    return NextResponse.json(
      { error: "Could not load coach availability." },
      { status: 500 },
    );
  }
}
