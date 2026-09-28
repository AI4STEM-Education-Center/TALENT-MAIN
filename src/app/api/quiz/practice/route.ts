import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  scoreVariant,
  studentVariantQuestions,
  type VariantQuestion,
} from "@/lib/quiz-variants";

async function studentActor() {
  const session = await auth();
  if (session?.user?.role !== "STUDENT") return null;
  return prisma.student.findUnique({ where: { userId: session.user.id } });
}
async function access(studentId: string, classId: string, quizId: string) {
  const [enrollment, assignment] = await Promise.all([
    prisma.classEnrollment.findUnique({
      where: { classId_studentId: { classId, studentId } },
    }),
    prisma.classQuiz.findUnique({
      where: { classId_quizId: { classId, quizId } },
    }),
  ]);
  if (!enrollment || !assignment?.published) return false;
  const now = new Date();
  return (
    !(assignment.availableFrom && now < assignment.availableFrom) &&
    !(assignment.availableUntil && now > assignment.availableUntil)
  );
}
const startSchema = z.object({
  classId: z.string().min(1),
  quizId: z.string().min(1),
});
export async function GET(req: NextRequest) {
  const student = await studentActor();
  if (!student)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const input = startSchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!input.success)
    return NextResponse.json(
      { error: "Class and quiz required" },
      { status: 400 },
    );
  const { classId, quizId } = input.data;
  if (!(await access(student.id, classId, quizId)))
    return NextResponse.json(
      { error: "Practice is unavailable for this class or quiz." },
      { status: 403 },
    );
  const [available, attempts] = await Promise.all([
    prisma.quizPracticeVersion.count({
      where: { quizId, status: "PUBLISHED" },
    }),
    prisma.quizPracticeAttempt.findMany({
      where: { studentId: student.id, classId, quizId },
      select: {
        id: true,
        versionName: true,
        score: true,
        completedAt: true,
        startedAt: true,
      },
      orderBy: { startedAt: "desc" },
      take: 50,
    }),
  ]);
  return NextResponse.json({ available, attempts });
}
export async function POST(req: NextRequest) {
  const student = await studentActor();
  if (!student)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const input = startSchema.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return NextResponse.json(
      { error: "Class and quiz required" },
      { status: 400 },
    );
  const { classId, quizId } = input.data;
  if (!(await access(student.id, classId, quizId)))
    return NextResponse.json(
      { error: "Practice is unavailable for this class or quiz." },
      { status: 403 },
    );
  const activeKey = JSON.stringify([student.id, classId, quizId]);
  const attempt = await prisma.$transaction(async (tx) => {
    const active = await tx.quizPracticeAttempt.findUnique({
      where: { activeKey },
    });
    if (active) return active;
    const versions = await tx.quizPracticeVersion.findMany({
      where: { quizId, status: "PUBLISHED" },
      orderBy: { createdAt: "asc" },
    });
    if (!versions.length) return null;
    const previous = await tx.quizPracticeAttempt.findMany({
      where: { studentId: student.id, classId, quizId },
      select: { versionId: true },
      orderBy: { startedAt: "desc" },
    });
    const seen = new Set(previous.map((a) => a.versionId));
    const selected =
      versions.find((v) => !seen.has(v.id)) ??
      versions.find((v) => v.id !== previous[0]?.versionId) ??
      versions[0];
    return tx.quizPracticeAttempt.create({
      data: {
        studentId: student.id,
        classId,
        quizId,
        versionId: selected.id,
        versionName: selected.name,
        questions: selected.questions,
        activeKey,
      },
    });
  });
  if (!attempt)
    return NextResponse.json(
      { error: "Your teacher has not published an alternative version yet." },
      { status: 404 },
    );
  return NextResponse.json({
    attemptId: attempt.id,
    versionName: attempt.versionName,
    questions: studentVariantQuestions(
      JSON.parse(attempt.questions),
      attempt.id,
    ),
  });
}
const submitSchema = z.object({
  attemptId: z.string().min(1),
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1),
        selectedOptionId: z.unknown().optional(),
        selectedOptionIds: z.unknown().optional(),
        numericValue: z.unknown().optional(),
      }),
    )
    .max(40),
});
export async function PATCH(req: NextRequest) {
  const student = await studentActor();
  if (!student)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const input = submitSchema.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return NextResponse.json({ error: "Invalid answers" }, { status: 400 });
  const attempt = await prisma.quizPracticeAttempt.findFirst({
    where: { id: input.data.attemptId, studentId: student.id },
  });
  if (!attempt)
    return NextResponse.json({ error: "Attempt not found" }, { status: 404 });
  if (attempt.completedAt)
    return NextResponse.json(
      { error: "This practice was already submitted." },
      { status: 409 },
    );
  // Closing the availability window does not discard already-started work;
  // enrollment must still exist when submitting.
  if (
    !(await prisma.classEnrollment.findUnique({
      where: {
        classId_studentId: { classId: attempt.classId, studentId: student.id },
      },
    }))
  )
    return NextResponse.json({ error: "Not enrolled" }, { status: 403 });
  const questions = JSON.parse(attempt.questions) as VariantQuestion[];
  let result;
  try {
    result = scoreVariant(questions, input.data.answers, attempt.id);
  } catch {
    return NextResponse.json(
      { error: "Invalid or repeated question or choice." },
      { status: 400 },
    );
  }
  const saved = await prisma.quizPracticeAttempt.updateMany({
    where: { id: attempt.id, completedAt: null },
    data: {
      completedAt: new Date(),
      activeKey: null,
      score: result.score,
      answers: JSON.stringify(result.answerRecords),
    },
  });
  if (!saved.count)
    return NextResponse.json(
      { error: "This practice was already submitted." },
      { status: 409 },
    );
  return NextResponse.json({
    score: result.score,
    incorrectQuestionIds: result.answerRecords
      .filter((a) => !a.isCorrect)
      .map((a) => a.questionId),
  });
}
