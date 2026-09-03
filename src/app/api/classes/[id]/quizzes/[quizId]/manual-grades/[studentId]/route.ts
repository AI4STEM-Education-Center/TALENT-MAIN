import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type RouteParams = {
  params: Promise<{ id: string; quizId: string; studentId: string }>;
};

async function authorize(
  userId: string,
  classId: string,
  quizId: string,
  studentId: string,
) {
  const teacher = await prisma.teacher.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!teacher) return false;

  const [cls, assignment, enrollment] = await Promise.all([
    prisma.class.findFirst({
      where: { id: classId, teacherId: teacher.id },
      select: { id: true },
    }),
    prisma.classQuiz.findUnique({
      where: { classId_quizId: { classId, quizId } },
      select: { id: true },
    }),
    prisma.classEnrollment.findUnique({
      where: { classId_studentId: { classId, studentId } },
      select: { id: true },
    }),
  ]);
  return Boolean(cls && assignment && enrollment);
}

/** Set a teacher-entered percentage for one enrolled student on this quiz. */
export async function PUT(req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, quizId, studentId } = await params;
  if (!(await authorize(session.user.id, id, quizId, studentId))) {
    return NextResponse.json(
      { error: "Class, quiz, or student not found" },
      { status: 404 },
    );
  }

  const body = await req.json().catch(() => null);
  const grade = body?.grade;
  if (
    typeof grade !== "number" ||
    !Number.isFinite(grade) ||
    grade < 0 ||
    grade > 100
  ) {
    return NextResponse.json(
      { error: "Manual grade must be a number from 0 to 100" },
      { status: 400 },
    );
  }

  const progress = await prisma.quizProgress.upsert({
    where: { studentId_classId_quizId: { studentId, classId: id, quizId } },
    create: { studentId, classId: id, quizId, manualGrade: grade },
    update: { manualGrade: grade },
    select: { manualGrade: true },
  });
  return NextResponse.json(progress);
}

/** Clear the override and return to the calculated best-attempt grade. */
export async function DELETE(_req: NextRequest, { params }: RouteParams) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, quizId, studentId } = await params;
  if (!(await authorize(session.user.id, id, quizId, studentId))) {
    return NextResponse.json(
      { error: "Class, quiz, or student not found" },
      { status: 404 },
    );
  }

  await prisma.quizProgress.updateMany({
    where: { studentId, classId: id, quizId },
    data: { manualGrade: null },
  });
  return new NextResponse(null, { status: 204 });
}
