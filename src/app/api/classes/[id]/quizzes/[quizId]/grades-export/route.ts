import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  buildGradeHeader,
  buildGradesCsv,
  calculateExportGrade,
  formatGrade,
  type GradeExportMode,
} from "@/lib/grades-csv";

const nameKey = (first: string, last: string) =>
  `${first.trim().toLowerCase()}|${last.trim().toLowerCase()}`;

async function getTeacherClass(userId: string, classId: string) {
  const teacher = await prisma.teacher.findUnique({ where: { userId } });
  if (!teacher) return null;
  return prisma.class.findFirst({ where: { id: classId, teacherId: teacher.id } });
}

// GET: download the class roster as an eLC-format CSV with each student's
// grade on this quiz in a teacher-named grade column (teacher-only, owning
// teacher). Best-attempt percentages are scaled to maxPoints; completion mode
// awards maxPoints for any completed attempt. A manual percentage overrides
// either calculation.
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

  const modeParam = req.nextUrl.searchParams.get("mode") ?? "best-attempt";
  if (modeParam !== "best-attempt" && modeParam !== "completion") {
    return NextResponse.json({ error: "Invalid grade calculation mode" }, { status: 400 });
  }
  const mode: GradeExportMode = modeParam;

  const maxPointsParam = req.nextUrl.searchParams.get("maxPoints") ?? "100";
  const maxPoints = Number(maxPointsParam);
  if (!Number.isFinite(maxPoints) || maxPoints <= 0 || maxPoints > 1_000_000) {
    return NextResponse.json(
      { error: "Max points must be a number greater than 0 and no more than 1,000,000" },
      { status: 400 }
    );
  }

  // `header` remains supported for callers that already provide a complete eLC
  // header. The dialog sends the simpler grade item `name` instead.
  const exactHeader = req.nextUrl.searchParams.get("header")?.trim();
  const gradeName = req.nextUrl.searchParams.get("name")?.trim() || quiz.name;
  const gradeHeader = exactHeader || buildGradeHeader(gradeName, maxPoints);

  const [roster, attempts, progressRows] = await Promise.all([
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
    prisma.quizProgress.findMany({
      where: { classId: id, quizId, manualGrade: { not: null } },
      select: {
        manualGrade: true,
        student: { select: { user: { select: { firstName: true, lastName: true } } } },
      },
    }),
  ]);

  // Roster rows have no FK to student accounts; bridge by the same
  // case-insensitive "first|last" name key the class roster page uses.
  const gradeDataByName = new Map<
    string,
    { bestScore: number | null; hasCompletedAttempt: boolean; manualGrade: number | null }
  >();
  for (const a of attempts) {
    const key = nameKey(a.student.user.firstName, a.student.user.lastName);
    const score = a.score ?? 0;
    const row = gradeDataByName.get(key) ?? {
      bestScore: null,
      hasCompletedAttempt: false,
      manualGrade: null,
    };
    row.bestScore = row.bestScore === null ? score : Math.max(row.bestScore, score);
    row.hasCompletedAttempt = true;
    gradeDataByName.set(key, row);
  }
  for (const progress of progressRows) {
    const key = nameKey(progress.student.user.firstName, progress.student.user.lastName);
    const row = gradeDataByName.get(key) ?? {
      bestScore: null,
      hasCompletedAttempt: false,
      manualGrade: null,
    };
    row.manualGrade = progress.manualGrade;
    gradeDataByName.set(key, row);
  }

  const csv = buildGradesCsv(
    gradeHeader,
    roster.map((r) => ({
      orgDefinedId: r.orgDefinedId,
      lastName: r.lastName,
      firstName: r.firstName,
      grade: formatGrade(
        calculateExportGrade({
          ...(gradeDataByName.get(nameKey(r.firstName, r.lastName)) ?? {
            bestScore: null,
            hasCompletedAttempt: false,
            manualGrade: null,
          }),
          mode,
          maxPoints,
        })
      ),
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
