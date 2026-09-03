import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getQuizStats } from "@/lib/quiz-stats-server";

async function getTeacherClass(userId: string, classId: string) {
  const teacher = await prisma.teacher.findUnique({ where: { userId } });
  if (!teacher) return null;
  return prisma.class.findFirst({
    where: { id: classId, teacherId: teacher.id },
  });
}

// GET: per-quiz statistics for one class (teacher-only, owning teacher).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; quizId: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, quizId } = await params;
  const cls = await getTeacherClass(session.user.id, id);
  if (!cls)
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  // The quiz must actually be assigned to this class.
  const assigned = await prisma.classQuiz.findUnique({
    where: { classId_quizId: { classId: id, quizId } },
  });
  if (!assigned)
    return NextResponse.json(
      { error: "Quiz not assigned to this class" },
      { status: 404 },
    );

  const stats = await getQuizStats(id, quizId);
  if (!stats)
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });

  return NextResponse.json(stats);
}
