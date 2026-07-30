import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { scoreQuiz, type ScorableQuestion } from "@/lib/quiz-scoring";
import { buildReviewSnapshot } from "@/lib/exam-results";
import { attachFigureUrls, attachOptionImageUrls } from "@/lib/question-figures";
import { enqueueExamResult } from "@/lib/queue";
import { logApiError } from "@/lib/system-log";

// POST: Start a quiz attempt
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const student = await prisma.student.findUnique({ where: { userId: session.user.id } });
  if (!student) return NextResponse.json({ error: "Student not found" }, { status: 404 });

  const { classId, quizId } = await req.json();
  if (!classId || !quizId) {
    return NextResponse.json({ error: "classId and quizId required" }, { status: 400 });
  }

  // Verify student is enrolled
  const enrollment = await prisma.classEnrollment.findUnique({
    where: { classId_studentId: { classId, studentId: student.id } },
  });
  if (!enrollment) return NextResponse.json({ error: "Not enrolled in this class" }, { status: 403 });

  // Verify the quiz is published for this class
  const classQuiz = await prisma.classQuiz.findUnique({
    where: { classId_quizId: { classId, quizId } },
  });
  if (!classQuiz?.published) {
    return NextResponse.json({ error: "This quiz is not yet available." }, { status: 403 });
  }

  // Enforce the per-class availability window + attempt cap (the source of
  // truth — the student UI mirrors these but server-side wins). The classQuiz
  // row is already loaded, so the new scalars cost no extra query.
  const now = new Date();
  if (classQuiz.availableFrom && now < classQuiz.availableFrom) {
    return NextResponse.json({ error: "This quiz isn't open yet." }, { status: 403 });
  }
  if (classQuiz.availableUntil && now > classQuiz.availableUntil) {
    return NextResponse.json({ error: "This quiz has closed." }, { status: 403 });
  }
  if (classQuiz.maxAttempts && classQuiz.maxAttempts > 0) {
    const usedAttempts = await prisma.quizAttempt.count({
      where: { studentId: student.id, classId, quizId, completedAt: { not: null } },
    });
    if (usedAttempts >= classQuiz.maxAttempts) {
      return NextResponse.json(
        { error: `You've used all ${classQuiz.maxAttempts} attempts.` },
        { status: 403 }
      );
    }
  }

  // Get questions for this quiz. SECURITY: students must never receive the
  // grading data — `omit` strips the NUMERIC answer/tolerance scalars, options
  // are selected without `isCorrect`, and the raw figure storage key/bucket are
  // replaced below with a short-lived presigned URL. Students see only:
  // id, text, answerMode, answerUnit, points, figureAlt, options { id, text,
  // imageAlt }, plus the transient figureUrl / option imageUrl. An image
  // answer-choice exposes its imageAlt + presigned imageUrl but NOT isCorrect.
  const questionRows = await prisma.question.findMany({
    where: { quizId },
    omit: { answerNumeric: true, answerTolerance: true },
    include: {
      options: { select: { id: true, text: true, imageStorageKey: true, imageBucket: true, imageAlt: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  if (questionRows.length === 0) {
    return NextResponse.json({ error: "No questions available for this quiz." }, { status: 404 });
  }

  // These are independent: presigning the figure + option-image URLs (S3),
  // creating the attempt, and flipping progress to IN_PROGRESS don't read each
  // other's results, so race them instead of waterfalling. Only `questions` and
  // `attempt.id` feed the response. (Option-image presigning still chains after
  // figure presigning, since it consumes the figure-augmented rows.)
  const [questions, attempt] = await Promise.all([
    // Replace figure + option-image storage keys with transient presigned URLs.
    attachFigureUrls(questionRows).then((rows) => attachOptionImageUrls(rows)),
    // Create attempt
    prisma.quizAttempt.create({
      data: { studentId: student.id, classId, quizId },
    }),
    // Update QuizProgress to IN_PROGRESS
    prisma.quizProgress.upsert({
      where: { studentId_classId_quizId: { studentId: student.id, classId, quizId } },
      update: { status: "IN_PROGRESS" },
      create: { studentId: student.id, classId, quizId, status: "IN_PROGRESS" },
    }),
  ]);

  return NextResponse.json({ attemptId: attempt.id, questions });
}

// PATCH: Submit quiz answers
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const student = await prisma.student.findUnique({ where: { userId: session.user.id } });
  if (!student) return NextResponse.json({ error: "Student not found" }, { status: 404 });

  const { attemptId, answers } = await req.json();
  // answers: [{ questionId, selectedOptionId }] | [{ questionId, selectedOptionIds }]
  // | [{ questionId, numericValue }] (NUMERIC). The raw array is handed straight
  // to scoreQuiz, which reads/normalizes the relevant field per question mode.
  if (!attemptId || !answers) {
    return NextResponse.json({ error: "attemptId and answers required" }, { status: 400 });
  }

  const attempt = await prisma.quizAttempt.findUnique({ where: { id: attemptId } });
  if (!attempt || attempt.studentId !== student.id) {
    return NextResponse.json({ error: "Attempt not found" }, { status: 404 });
  }
  // SECURITY: an attempt may be graded exactly once. Without this, a student
  // could re-submit the same attemptId indefinitely — the per-class
  // `maxAttempts` cap counts COMPLETED attempts, so replaying one attempt
  // never consumes another. Combined with the `incorrectQuestionIds` reply
  // below that turns submission into an answer-key oracle: guess, see which
  // ids came back wrong, flip those, resubmit until everything is correct.
  if (attempt.completedAt) {
    return NextResponse.json(
      { error: "This attempt has already been submitted." },
      { status: 409 }
    );
  }
  // quizId is null only if the quiz was deleted mid-attempt — nothing left to score against.
  const quizId = attempt.quizId;
  if (!quizId) {
    return NextResponse.json({ error: "This quiz no longer exists." }, { status: 410 });
  }

  if (!Array.isArray(answers)) {
    return NextResponse.json({ error: "answers must be an array" }, { status: 400 });
  }

  // SECURITY: one answer per question. Repeating a question the student knows
  // would otherwise inflate `correct` past the question count (20 copies of one
  // right answer against a 5-question quiz scored 400%).
  const questionIds = answers.map((a: { questionId: string }) => a.questionId);
  if (new Set(questionIds).size !== questionIds.length) {
    return NextResponse.json(
      { error: "Each question may be answered only once." },
      { status: 400 }
    );
  }

  // SECURITY: grade against THIS quiz's questions only, and take the
  // denominator from the quiz rather than from the client's array. Loading the
  // full set does both in one query — a submitted id belonging to another quiz
  // simply won't resolve below, and a partial submission can no longer score
  // 100% by omitting every question the student didn't know.
  const quizQuestions = await prisma.question.findMany({
    where: { quizId },
    include: { options: true },
  });
  const answeredIds = new Set(questionIds);
  const questionsWithAnswers = quizQuestions.filter((q) => answeredIds.has(q.id));
  const questionsById = new Map<string, ScorableQuestion>(
    questionsWithAnswers.map((q) => [q.id, q])
  );

  // Any answer referencing a question outside this quiz is rejected.
  if (answers.some((a: { questionId: string }) => !questionsById.has(a.questionId))) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  const { correct, score, answerRecords } = scoreQuiz({
    attemptId,
    questionsById,
    answers,
    totalQuestions: quizQuestions.length,
  });
  const completedAt = new Date();

  const [_, __, existing] = await Promise.all([
    // selectedOptionIds is persisted as a JSON string (schema: String @default("[]")).
    prisma.quizAnswer.createMany({
      data: answerRecords.map((record) => ({
        ...record,
        selectedOptionIds: JSON.stringify(record.selectedOptionIds),
      })),
    }),
    prisma.quizAttempt.update({
      where: { id: attemptId },
      data: { score, completedAt },
    }),
    prisma.quizProgress.findUnique({
      where: { studentId_classId_quizId: { studentId: student.id, classId: attempt.classId, quizId } },
    }),
  ]);

  // Update QuizProgress: COMPLETED + bestScore
  await prisma.quizProgress.upsert({
    where: { studentId_classId_quizId: { studentId: student.id, classId: attempt.classId, quizId } },
    update: {
      status: "COMPLETED",
      bestScore: Math.max(score, existing?.bestScore ?? 0),
    },
    create: {
      studentId: student.id,
      classId: attempt.classId,
      quizId,
      status: "COMPLETED",
      bestScore: score,
    },
  });

  // Build a durable, self-contained ExamResult snapshot and kick off background
  // AI generation. Best-effort: a failure here must never fail quiz submission,
  // and the ExamResult is deliberately decoupled from the quiz rows so it
  // survives later deletion/edits of the questions or the student account.
  try {
    const names = await prisma.quizAttempt.findUnique({
      where: { id: attemptId },
      select: {
        class: { select: { name: true } },
        quiz: { select: { name: true, topic: { select: { name: true } } } },
      },
    });

    const snapshot = buildReviewSnapshot(
      questionsWithAnswers.map((q) => ({
        id: q.id,
        text: q.text,
        options: q.options,
        // NUMERIC grading data + figure metadata flow into the durable snapshot
        // (see buildReviewSnapshot); ignored for plain choice questions.
        answerMode: q.answerMode,
        answerNumeric: q.answerNumeric,
        answerTolerance: q.answerTolerance,
        answerUnit: q.answerUnit,
        figureStorageKey: q.figureStorageKey,
        figureAlt: q.figureAlt,
      })),
      answerRecords
    );

    const examResult = await prisma.examResult.create({
      data: {
        quizAttemptId: attemptId,
        studentId: student.id,
        classId: attempt.classId,
        quizId,
        studentName:
          [session.user.firstName, session.user.lastName].filter(Boolean).join(" ") || null,
        className: names?.class.name ?? "",
        topicName: names?.quiz?.topic?.name ?? "",
        quizName: names?.quiz?.name ?? "",
        score,
        correctCount: correct,
        // The quiz's question count, matching the scored denominator — not the
        // length of the client-supplied answers array.
        totalCount: quizQuestions.length,
        completedAt,
        reviewSnapshot: JSON.stringify(snapshot),
      },
    });

    try {
      enqueueExamResult(examResult.id);
    } catch (err) {
      logApiError("QUIZ_SUBMIT", err, "Failed to enqueue exam-result generation");
    }
  } catch (err) {
    logApiError("QUIZ_SUBMIT", err, "Failed to create ExamResult snapshot");
  }

  // Student-safe review: reveal only which submitted responses were incorrect.
  // The client already owns those prompts and responses from the active quiz,
  // so ids are enough to render them without returning answer keys, option
  // correctness, numeric solutions/tolerances, questions, or answer records.
  const incorrectQuestionIds = answerRecords.flatMap((record) =>
    record.isCorrect ? [] : [record.questionId]
  );
  return NextResponse.json({ score, incorrectQuestionIds });
}
