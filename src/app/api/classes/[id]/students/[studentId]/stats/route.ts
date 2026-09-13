import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getStudentStats } from "@/lib/quiz-stats-server";

async function getTeacherClass(userId: string, classId: string) {
  const teacher = await prisma.teacher.findUnique({ where: { userId } });
  if (!teacher) return null;
  return prisma.class.findFirst({
    where: { id: classId, teacherId: teacher.id },
  });
}

// GET: cross-quiz statistics for one student in one class (teacher-only).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; studentId: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, studentId } = await params;
  const cls = await getTeacherClass(session.user.id, id);
  if (!cls)
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  // The student must be enrolled in this class.
  const enrollment = await prisma.classEnrollment.findUnique({
    where: { classId_studentId: { classId: id, studentId } },
  });
  if (!enrollment)
    return NextResponse.json(
      { error: "Student not enrolled" },
      { status: 404 },
    );

  const stats = await getStudentStats(id, studentId);
  if (!stats)
    return NextResponse.json({ error: "Student not found" }, { status: 404 });

  return NextResponse.json(stats);
}
