import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { pausedClassResponse } from "@/lib/class-access-guard";
import { prisma } from "@/lib/prisma";
import { studentCanPractice } from "@/lib/quiz-practice-access";
import {
  scoreVariant,
  studentVariantQuestions,
  type VariantQuestion,
} from "@/lib/quiz-variants";
import {
  excludedCountOf,
  loadPreviouslyCorrect,
  selectRetakeQuestions,
  variantAnswerRows,
  variantSnapshotInputs,
} from "@/lib/alternative-retake";
import { buildReviewSnapshot } from "@/lib/exam-results";
import { enqueueExamResult } from "@/lib/queue";
import { logApiError } from "@/lib/system-log";

class AlreadySubmittedError extends Error {}

async function studentActor() {
  const session = await auth();
  if (session?.user?.role !== "STUDENT") return null;
  return prisma.student.findUnique({ where: { userId: session.user.id } });
}
const startSchema = z.object({
  classId: z.string().min(1),
  quizId: z.string().min(1),
  // Leave out the questions the student already has correct. Opt-in per start
  // so existing clients keep getting the full version.
  excludeCorrect: z.boolean().optional(),
});
const historySchema = startSchema.omit({ excludeCorrect: true });
export async function GET(req: NextRequest) {
  const student = await studentActor();
  if (!student)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const input = historySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!input.success)
    return NextResponse.json(
      { error: "Class and quiz required" },
      { status: 400 },
    );
  const { classId, quizId } = input.data;
  const paused = await pausedClassResponse(classId);
  if (paused) return paused;
  if (!(await studentCanPractice(student.id, classId, quizId)))
    return NextResponse.json(
      { error: "Practice is unavailable for this class or quiz." },
      { status: 403 },
    );
  const [available, attempts, history, questionRows] = await Promise.all([
    prisma.quizPracticeVersion.count({
      where: { quizId, status: "PUBLISHED" },
    }),
    prisma.quizPracticeAttempt.findMany({
      where: { studentId: student.id, classId, quizId },
      select: {
        id: true,
        quizAttemptId: true,
        versionName: true,
        score: true,
        completedAt: true,
        startedAt: true,
      },
      orderBy: { startedAt: "desc" },
      take: 50,
    }),
    loadPreviouslyCorrect(prisma, { studentId: student.id, classId, quizId }),
    prisma.question.findMany({ where: { quizId }, select: { id: true } }),
  ]);
  // What "exclude questions I got right" would do: counted against the quiz's
  // current questions. Null until the student has a completed attempt.
  const questionIds = questionRows.map((q) => q.id);
  const answered = questionIds.filter((id) => history.answered.has(id));
  const last = answered.length
    ? {
        total: questionIds.length,
        correct: answered.filter((id) => history.correct.has(id)).length,
      }
    : null;
  return NextResponse.json({ available, attempts, last });
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
  const { classId, quizId, excludeCorrect = false } = input.data;
  const paused = await pausedClassResponse(classId);
  if (paused) return paused;
  if (!(await studentCanPractice(student.id, classId, quizId)))
    return NextResponse.json(
      { error: "Practice is unavailable for this class or quiz." },
      { status: 403 },
    );
  const activeKey = JSON.stringify([student.id, classId, quizId]);
  const started = await prisma.$transaction(async (tx) => {
    const active = await tx.quizPracticeAttempt.findUnique({
      where: { activeKey },
    });
    if (active) return { attempt: active, exclusionIgnored: false };
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
    const { correct } = excludeCorrect
      ? await loadPreviouslyCorrect(tx, {
          studentId: student.id,
          classId,
          quizId,
        })
      : { correct: new Set<string>() };
    const selection = selectRetakeQuestions(
      JSON.parse(selected.questions) as VariantQuestion[],
      correct,
      excludeCorrect,
    );
    // The retake is recorded as an ordinary (unfinished) attempt from the
    // moment it starts, linked to the version it was taken on.
    const quizAttempt = await tx.quizAttempt.create({
      data: {
        studentId: student.id,
        classId,
        quizId,
        practiceVersionId: selected.id,
        practiceVersionName: selected.name,
        excludedQuestionIds: JSON.stringify(selection.excludedSourceIds),
      },
      select: { id: true },
    });
    const attempt = await tx.quizPracticeAttempt.create({
      data: {
        studentId: student.id,
        classId,
        quizId,
        versionId: selected.id,
        versionName: selected.name,
        quizAttemptId: quizAttempt.id,
        questions: JSON.stringify(selection.questions),
        activeKey,
      },
    });
    return { attempt, exclusionIgnored: selection.exclusionIgnored };
  });
  if (!started)
    return NextResponse.json(
      { error: "Your teacher has not published an alternative version yet." },
      { status: 404 },
    );
  const { attempt, exclusionIgnored } = started;
  const questions = JSON.parse(attempt.questions) as VariantQuestion[];
  // Resumed attempts report the exclusion they were started with.
  const recorded = attempt.quizAttemptId
    ? await prisma.quizAttempt.findUnique({
        where: { id: attempt.quizAttemptId },
        select: { excludedQuestionIds: true },
      })
    : null;
  return NextResponse.json({
    attemptId: attempt.id,
    quizAttemptId: attempt.quizAttemptId,
    versionName: attempt.versionName,
    excludedCount: excludedCountOf(recorded?.excludedQuestionIds),
    exclusionIgnored,
    questions: studentVariantQuestions(questions, attempt.id),
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
  const paused = await pausedClassResponse(attempt.classId);
  if (paused) return paused;
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
  const completedAt = new Date();
  let quizAttemptId: string;
  let examResultId: string;
  try {
    const recorded = await prisma.$transaction(async (tx) => {
      let recordedId = attempt.quizAttemptId;
      // Single-use claim first (see the normal quiz route): parallel PATCHes
      // cannot both record the same practice run.
      const saved = await tx.quizPracticeAttempt.updateMany({
        where: { id: attempt.id, completedAt: null },
        data: {
          completedAt,
          activeKey: null,
          score: result.score,
          answers: JSON.stringify(result.answerRecords),
        },
      });
      if (!saved.count) throw new AlreadySubmittedError();
      if (recordedId) {
        const claimed = await tx.quizAttempt.updateMany({
          where: {
            id: recordedId,
            studentId: student.id,
            classId: attempt.classId,
            OR: [{ quizId: attempt.quizId }, { quizId: null }],
            practiceVersionId: attempt.versionId,
            completedAt: null,
          },
          data: { score: result.score, completedAt },
        });
        if (claimed.count !== 1) throw new AlreadySubmittedError();
      } else {
        // Started before retakes were recorded: file it now so it is not lost.
        const quiz = await tx.quiz.findUnique({
          where: { id: attempt.quizId },
          select: { id: true },
        });
        const created = await tx.quizAttempt.create({
          data: {
            studentId: student.id,
            classId: attempt.classId,
            quizId: quiz?.id ?? null,
            practiceVersionId: attempt.versionId,
            practiceVersionName: attempt.versionName,
            score: result.score,
            startedAt: attempt.startedAt,
            completedAt,
          },
          select: { id: true },
        });
        recordedId = created.id;
        await tx.quizPracticeAttempt.update({
          where: { id: attempt.id },
          data: { quizAttemptId: recordedId },
        });
      }
      // Read source FKs inside the write transaction: a concurrent deletion
      // cannot invalidate the set between this read and answer insertion.
      const existingSources = new Set(
        (
          await tx.question.findMany({
            where: {
              quizId: attempt.quizId,
              id: { in: questions.map((q) => q.sourceQuestionId) },
            },
            select: { id: true },
          })
        ).map((q) => q.id),
      );
      await tx.quizAnswer.createMany({
        data: variantAnswerRows(
          recordedId,
          questions,
          result.answerRecords,
          existingSources,
        ),
      });
      const [names, user] = await Promise.all([
        tx.quizAttempt.findUnique({
          where: { id: recordedId },
          select: {
            class: { select: { name: true } },
            quiz: { select: { name: true, topic: { select: { name: true } } } },
            excludedQuestionIds: true,
          },
        }),
        tx.user.findUnique({
          where: { id: student.userId },
          select: { firstName: true, lastName: true },
        }),
      ]);
      const snapshotInput = variantSnapshotInputs(
        questions,
        result.answerRecords,
      );
      const examResult = await tx.examResult.create({
        data: {
          quizAttemptId: recordedId,
          studentId: student.id,
          classId: attempt.classId,
          quizId: attempt.quizId,
          studentName:
            [user?.firstName, user?.lastName].filter(Boolean).join(" ") || null,
          className: names?.class.name ?? "",
          topicName: names?.quiz?.topic?.name ?? "",
          quizName: names?.quiz?.name ?? "",
          practiceVersionName: attempt.versionName,
          excludedCount: excludedCountOf(names?.excludedQuestionIds),
          score: result.score,
          correctCount: result.correct,
          totalCount: questions.length,
          completedAt,
          reviewSnapshot: JSON.stringify(
            buildReviewSnapshot(snapshotInput.questions, snapshotInput.answers),
          ),
        },
      });
      return { quizAttemptId: recordedId, examResultId: examResult.id };
    });
    quizAttemptId = recorded.quizAttemptId;
    examResultId = recorded.examResultId;
  } catch (error) {
    if (error instanceof AlreadySubmittedError)
      return NextResponse.json(
        { error: "This practice was already submitted or is no longer valid." },
        { status: 409 },
      );
    throw error;
  }

  // Queue delivery is best-effort; the committed PENDING result can be retried
  // by the results endpoint if enqueueing fails.
  try {
    enqueueExamResult(examResultId);
  } catch (err) {
    logApiError(
      "QUIZ_PRACTICE_SUBMIT",
      err,
      "Failed to enqueue exam-result generation",
    );
  }
  return NextResponse.json({
    score: result.score,
    quizAttemptId,
    incorrectQuestionIds: result.answerRecords
      .filter((a) => !a.isCorrect)
      .map((a) => a.questionId),
  });
}
