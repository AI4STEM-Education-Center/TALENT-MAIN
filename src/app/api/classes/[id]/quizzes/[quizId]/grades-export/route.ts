import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildGradesCsv, formatGrade } from "@/lib/grades-csv";

async function getTeacherClass(userId: string, classId: string) {
  const teacher = await prisma.teacher.findUnique({ where: { userId } });
  if (!teacher) return null;
  return prisma.class.findFirst({ where: { id: classId, teacherId: teacher.id } });
}

// GET: download the class roster as an eLC-format CSV with each student's
// best score on this quiz in a teacher-named grade column (teacher-only,
// owning teacher). ?header= sets the grade column's header text.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; quizId: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, quizId } = await params;
  const cls = await getTeacherClass(session.user.id, id);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  // The quiz must actually be assigned to this class.
  const assigned = await prisma.classQuiz.findUnique({
    where: { classId_quizId: { classId: id, quizId } },
  });
  if (!assigned) return NextResponse.json({ error: "Quiz not assigned to this class" }, { status: 404 });

  const quiz = await prisma.quiz.findUnique({ where: { id: quizId }, select: { name: true } });
  if (!quiz) return NextResponse.json({ error: "Quiz not found" }, { status: 404 });

  const gradeHeader =
    req.nextUrl.searchParams.get("header")?.trim() || `${quiz.name} Points Grade`;

  const [roster, attempts] = await Promise.all([
    prisma.classStudentList.findMany({
      where: { classId: id },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
    prisma.quizAttempt.findMany({
      where: { classId: id, quizId, completedAt: { not: null } },
      select: {
        score: true,
        student: { select: { user: { select: { firstName: true, lastName: true } } } },
      },
    }),
  ]);

  // Roster rows have no FK to student accounts; bridge by the same
  // case-insensitive "first|last" name key the class roster page uses.
  const nameKey = (first: string, last: string) =>
    `${first.trim().toLowerCase()}|${last.trim().toLowerCase()}`;
  const bestByName = new Map<string, number>();
  for (const a of attempts) {
    const key = nameKey(a.student.user.firstName, a.student.user.lastName);
    const score = a.score ?? 0;
    const prev = bestByName.get(key);
    if (prev === undefined || score > prev) bestByName.set(key, score);
  }

  const csv = buildGradesCsv(
    gradeHeader,
    roster.map((r) => ({
      orgDefinedId: r.orgDefinedId,
      lastName: r.lastName,
      firstName: r.firstName,
      grade: formatGrade(bestByName.get(nameKey(r.firstName, r.lastName)) ?? null),
    }))
  );

  const safeName =
    quiz.name.replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_") || "quiz";
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName}_grades.csv"`,
    },
  });
}
