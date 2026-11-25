import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pausedClassResponse } from "@/lib/class-access-guard";
import { prisma } from "@/lib/prisma";
import { scoreQuiz, type ScorableQuestion } from "@/lib/quiz-scoring";
import { buildReviewSnapshot } from "@/lib/exam-results";
import {
  attachFigureUrls,
  attachOptionImageUrls,
} from "@/lib/question-figures";
import { shuffleAnswerChoices } from "@/lib/quiz-shuffle";
import { enqueueExamResult } from "@/lib/queue";
import { logApiError } from "@/lib/system-log";
import { QUESTION_ORDER } from "@/lib/question-order";
import {
  GRADED_ATTEMPTS,
  loadPreviouslyCorrect,
  parseExcludedQuestionIds,
  selectOfficialQuizQuestions,
} from "@/lib/alternative-retake";
import { quizAvailability } from "@/lib/quiz-availability";
import type { UnifiedQuizOverview } from "@/lib/quiz-overview";

class AttemptLimitError extends Error {}
class AttemptAlreadySubmittedError extends Error {}

const quizTargetSchema = z.object({
  classId: z.string().min(1),
  quizId: z.string().min(1),
});

const startSchema = quizTargetSchema.extend({
  excludeCorrect: z.boolean().optional(),
  excludedQuestionIds: z.array(z.string().min(1).max(200)).max(500).optional(),
});

async function resolveQuizAccess(
  { classId, quizId }: z.infer<typeof quizTargetSchema>,
  userId: string,
) {
  const student = await prisma.student.findUnique({
    where: { userId },
  });
  if (!student)
    return {
      response: NextResponse.json(
        { error: "Student not found" },
        { status: 404 },
      ),
    };

  const enrollment = await prisma.classEnrollment.findUnique({
    where: { classId_studentId: { classId, studentId: student.id } },
  });
  if (!enrollment) {
    return {
      response: NextResponse.json(
        { error: "Not enrolled in this class" },
        { status: 403 },
      ),
    };
  }

  const paused = await pausedClassResponse(classId);
  if (paused) return { response: paused };

  const classQuiz = await prisma.classQuiz.findUnique({
    where: { classId_quizId: { classId, quizId } },
  });
  if (!classQuiz?.published) {
    return {
      response: NextResponse.json(
        { error: "This quiz is not yet available." },
        { status: 403 },
      ),
    };
  }
  return { student, classQuiz };
}

export async function GET(req: NextRequest) {
  const session = await auth();
  if (session?.user?.role !== "STUDENT")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const target = quizTargetSchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams),
  );
  if (!target.success)
    return NextResponse.json(
      { error: "classId and quizId required" },
      { status: 400 },
    );
  const access = await resolveQuizAccess(target.data, session.user.id);
  if (access.response) return access.response;
  const { student, classQuiz } = access;
  const { classId, quizId } = target.data;
  const who = { studentId: student.id, classId, quizId };
  const graded = { ...who, ...GRADED_ATTEMPTS };
  const [
    quiz,
    gradedAttemptCount,
    gradedAttempt,
    practiceAvailableCount,
    practiceAttempt,
    history,
    questionRows,
    recent,
  ] = await Promise.all([
    prisma.quiz.findUnique({
      where: { id: quizId },
      select: { id: true, name: true, topic: { select: { name: true } } },
    }),
    prisma.quizAttempt.count({
      where: { ...graded, completedAt: { not: null } },
    }),
    prisma.quizAttempt.findFirst({
      where: { ...graded, completedAt: null },
      select: { id: true, startedAt: true, excludedQuestionIds: true },
      orderBy: { startedAt: "desc" },
    }),
    prisma.quizPracticeVersion.count({
      where: { quizId, status: "PUBLISHED" },
    }),
    prisma.quizPracticeAttempt.findUnique({
      where: { activeKey: JSON.stringify([student.id, classId, quizId]) },
      select: {
        id: true,
        quizAttemptId: true,
        versionName: true,
        startedAt: true,
      },
    }),
    loadPreviouslyCorrect(prisma, who),
    prisma.question.findMany({
      where: { quizId },
      select: { id: true, text: true },
      orderBy: QUESTION_ORDER,
    }),
    prisma.quizAttempt.findMany({
      where: who,
      select: {
        id: true,
        score: true,
        startedAt: true,
        completedAt: true,
        practiceVersionId: true,
        practiceVersionName: true,
        excludedQuestionIds: true,
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: 30,
    }),
  ]);
  if (!quiz)
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });

  const availability = quizAvailability(classQuiz, gradedAttemptCount);
  const response: UnifiedQuizOverview = {
    classId,
    quiz: { id: quiz.id, name: quiz.name, topicName: quiz.topic?.name ?? null },
    availability,
    availableFrom: classQuiz.availableFrom?.toISOString() ?? null,
    availableUntil: classQuiz.availableUntil?.toISOString() ?? null,
    maxAttempts: classQuiz.maxAttempts,
    gradedAttemptCount,
    gradedAttempt: gradedAttempt
      ? {
          id: gradedAttempt.id,
          startedAt: gradedAttempt.startedAt.toISOString(),
          excludedQuestionIds: parseExcludedQuestionIds(
            gradedAttempt.excludedQuestionIds,
          ),
        }
      : null,
    practiceAvailableCount,
    practiceCanStart:
      practiceAvailableCount > 0 &&
      !availability.notOpenYet &&
      !availability.closed,
    practiceAttempt: practiceAttempt
      ? {
          ...practiceAttempt,
          startedAt: practiceAttempt.startedAt.toISOString(),
        }
      : null,
    previouslyCorrect: questionRows
      .filter((question) => history.correct.has(question.id))
      .map((question) => question.id),
    questions: questionRows.map((question, index) => {
      const preview = question.text.replace(/\s+/g, " ").trim();
      return {
        id: question.id,
        number: index + 1,
        previewText:
          preview.length > 140 ? `${preview.slice(0, 139)}…` : preview,
      };
    }),
    recentAttempts: recent.map((attempt) => ({
      id: attempt.id,
      kind: attempt.practiceVersionId ? "alternative" : "official",
      versionName: attempt.practiceVersionName,
      excludedCount: parseExcludedQuestionIds(attempt.excludedQuestionIds)
        .length,
      score: attempt.score,
      startedAt: attempt.startedAt.toISOString(),
      completedAt: attempt.completedAt?.toISOString() ?? null,
    })),
  };
  return NextResponse.json(response, {
    headers: { "Cache-Control": "no-store" },
  });
}

// POST: Start a quiz attempt
export async function POST(req: NextRequest) {
  const session = await auth();
  if (session?.user?.role !== "STUDENT")
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = startSchema.safeParse(await req.json().catch(() => null));
  if (!body.success)
    return NextResponse.json(
      { error: "Invalid quiz start request" },
      { status: 400 },
    );
  const access = await resolveQuizAccess(body.data, session.user.id);
  if (access.response) return access.response;
  const { student, classQuiz } = access;
  const { classId, quizId, excludeCorrect, excludedQuestionIds } = body.data;

  // Enforce the per-class availability window + attempt cap (the source of
  // truth — the student UI mirrors these but server-side wins). The classQuiz
  // row is already loaded, so the new scalars cost no extra query.
  const now = new Date();
  if (classQuiz.availableFrom && now < classQuiz.availableFrom) {
    return NextResponse.json(
      { error: "This quiz isn't open yet." },
      { status: 403 },
    );
  }
  if (classQuiz.availableUntil && now > classQuiz.availableUntil) {
    return NextResponse.json(
      { error: "This quiz has closed." },
      { status: 403 },
    );
  }
  // Allowlist the fields students need during the attempt. Storage keys and
  // buckets are replaced below with short-lived presigned URLs.
  const questionRows = await prisma.question.findMany({
    where: { quizId },
    select: {
      id: true,
      text: true,
      answerMode: true,
      answerUnit: true,
      points: true,
      figureStorageKey: true,
      figureBucket: true,
      figureAlt: true,
      options: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          text: true,
          imageStorageKey: true,
          imageBucket: true,
          imageAlt: true,
        },
      },
    },
    orderBy: QUESTION_ORDER,
  });

  if (questionRows.length === 0) {
    return NextResponse.json(
      { error: "No questions available for this quiz." },
      { status: 404 },
    );
  }

  // Reserve the attempt before doing optional S3 presigning work. The attempt
  // allocation and progress update must stay together for cap enforcement.
  let started: {
    attempt: { id: string; excludedQuestionIds: string };
    exclusionIgnored: boolean;
  };
  try {
    started = await prisma.$transaction(async (tx) => {
      let exclusionIgnored = false;
      // Resume before allocating. A student who closes the tab, drops off the
      // network, or just reloads comes back to the SAME attempt instead of
      // burning a slot — with maxAttempts: 1 that would otherwise be an
      // unrecoverable lockout, and nothing here can tell "abandoned" apart
      // from "still working on it".
      //
      // SECURITY: this is also what closes the stockpiling hole. Because an
      // unfinished attempt is always reused, POST can never mint a second
      // pending attempt, so a student cannot pre-create a pile of attempt IDs
      // and then submit them one at a time against the correctness feedback
      // the submit response returns.
      let claimed = await tx.quizAttempt.findFirst({
        where: {
          studentId: student.id,
          classId,
          quizId,
          completedAt: null,
          ...GRADED_ATTEMPTS,
        },
        orderBy: { startedAt: "desc" },
        select: { id: true, excludedQuestionIds: true },
      });

      if (!claimed) {
        if (classQuiz.maxAttempts && classQuiz.maxAttempts > 0) {
          const usedAttempts = await tx.quizAttempt.count({
            where: {
              studentId: student.id,
              classId,
              quizId,
              completedAt: { not: null },
              ...GRADED_ATTEMPTS,
            },
          });
          if (usedAttempts >= classQuiz.maxAttempts) {
            throw new AttemptLimitError();
          }
        }
        const { correct } =
          excludeCorrect || excludedQuestionIds?.length
            ? await loadPreviouslyCorrect(tx, {
                studentId: student.id,
                classId,
                quizId,
              })
            : { correct: new Set<string>() };
        const selection = selectOfficialQuizQuestions(questionRows, correct, {
          excludeCorrect,
          excludedQuestionIds,
        });
        exclusionIgnored = selection.exclusionIgnored;
        claimed = await tx.quizAttempt.create({
          data: {
            studentId: student.id,
            classId,
            quizId,
            excludedQuestionIds: JSON.stringify(selection.excludedSourceIds),
          },
          select: { id: true, excludedQuestionIds: true },
        });
      } else {
        const excluded = new Set(
          parseExcludedQuestionIds(claimed.excludedQuestionIds),
        );
        // Quiz edits can leave a resumed attempt with only excluded questions.
        if (questionRows.every((question) => excluded.has(question.id))) {
          await tx.quizAttempt.updateMany({
            where: { id: claimed.id, completedAt: null },
            data: { excludedQuestionIds: "[]" },
          });
          claimed.excludedQuestionIds = "[]";
          exclusionIgnored = true;
        }
      }

      await tx.quizProgress.upsert({
        where: {
          studentId_classId_quizId: { studentId: student.id, classId, quizId },
        },
        update: { status: "IN_PROGRESS" },
        create: {
          studentId: student.id,
          classId,
          quizId,
          status: "IN_PROGRESS",
        },
      });
      return { attempt: claimed, exclusionIgnored };
    });
  } catch (error) {
    if (error instanceof AttemptLimitError) {
      return NextResponse.json(
        { error: `You've used all ${classQuiz.maxAttempts} attempts.` },
        { status: 403 },
      );
    }
    throw error;
  }

  // Reorder each question's choices for this attempt. Seeded by attempt id, so
  // resuming reproduces the same layout while a new attempt gets a new one.
  // Done before presigning so each option's URL rides along with it.
  const { attempt, exclusionIgnored } = started;
  const recordedExclusions = new Set(
    parseExcludedQuestionIds(attempt.excludedQuestionIds),
  );
  const excludedIds = new Set(
    questionRows.filter((q) => recordedExclusions.has(q.id)).map((q) => q.id),
  );
  const orderedRows = questionRows
    .filter((question) => !excludedIds.has(question.id))
    .map((question) => ({
      ...question,
      options: shuffleAnswerChoices(
        question.options,
        `${attempt.id}:${question.id}`,
      ),
    }));

  // Replace figure + option-image storage keys with transient presigned URLs.
  const questions = await attachFigureUrls(orderedRows).then((rows) =>
    attachOptionImageUrls(rows),
  );

  return NextResponse.json({
    attemptId: attempt.id,
    questions,
    excludedCount: excludedIds.size,
    exclusionIgnored,
  });
}

// PATCH: Submit quiz answers
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
  });
  if (!student)
    return NextResponse.json({ error: "Student not found" }, { status: 404 });

  let body: { attemptId?: unknown; answers?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { attemptId, answers } = body;
  // answers: [{ questionId, selectedOptionId }] | [{ questionId, selectedOptionIds }]
  // | [{ questionId, numericValue }] (NUMERIC). The raw array is handed straight
  // to scoreQuiz, which reads/normalizes the relevant field per question mode.
  if (typeof attemptId !== "string" || !attemptId || !Array.isArray(answers)) {
    return NextResponse.json(
      { error: "attemptId and answers required" },
      { status: 400 },
    );
  }

  const attempt = await prisma.quizAttempt.findUnique({
    where: { id: attemptId },
  });
  if (!attempt || attempt.studentId !== student.id) {
    return NextResponse.json({ error: "Attempt not found" }, { status: 404 });
  }
  const paused = await pausedClassResponse(attempt.classId);
  if (paused) return paused;
  // Alternative-version retakes carry different questions; grading one against
  // the quiz's own would corrupt it. They submit through /api/quiz/practice.
  if (attempt.practiceVersionId) {
    return NextResponse.json(
      { error: "Submit alternative-version attempts through practice." },
      { status: 409 },
    );
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
      { status: 409 },
    );
  }
  // quizId is null only if the quiz was deleted mid-attempt — nothing left to score against.
  const quizId = attempt.quizId;
  if (!quizId) {
    return NextResponse.json(
      { error: "This quiz no longer exists." },
      { status: 410 },
    );
  }

  // SECURITY: one answer per question. Repeating a question the student knows
  // would otherwise inflate `correct` past the question count (20 copies of one
  // right answer against a 5-question quiz scored 400%).
  if (
    answers.some(
      (answer) =>
        !answer ||
        typeof answer !== "object" ||
        typeof (answer as { questionId?: unknown }).questionId !== "string" ||
        !(answer as { questionId: string }).questionId,
    )
  ) {
    return NextResponse.json(
      { error: "Each answer requires a questionId." },
      { status: 400 },
    );
  }
  const submittedAnswers = answers as Array<{
    questionId: string;
    selectedOptionId?: unknown;
    selectedOptionIds?: unknown;
    numericValue?: unknown;
  }>;
  const questionIds = submittedAnswers.map((a) => a.questionId);
  if (new Set(questionIds).size !== questionIds.length) {
    return NextResponse.json(
      { error: "Each question may be answered only once." },
      { status: 400 },
    );
  }

  // SECURITY: grade against THIS quiz's questions only, and take the
  // denominator from the quiz rather than from the client's array. Loading the
  // full set does both in one query — a submitted id belonging to another quiz
  // simply won't resolve below, and a partial submission can no longer score
  // 100% by omitting every question the student didn't know.
  const quizQuestions = await prisma.question.findMany({
    where: { quizId },
    include: { options: { orderBy: { id: "asc" } } },
    orderBy: QUESTION_ORDER,
  });
  const recordedExclusions = new Set(
    parseExcludedQuestionIds(attempt.excludedQuestionIds),
  );
  const excludedIds = new Set(
    quizQuestions.filter((q) => recordedExclusions.has(q.id)).map((q) => q.id),
  );
  const activeQuestions = quizQuestions.filter((q) => !excludedIds.has(q.id));
  if (!activeQuestions.length)
    return NextResponse.json(
      { error: "No questions remain in this attempt." },
      { status: 409 },
    );
  const questionsById = new Map<string, ScorableQuestion>(
    activeQuestions.map((q) => [q.id, q]),
  );

  // Reject unknown and excluded question ids before scoring.
  if (submittedAnswers.some((a) => !questionsById.has(a.questionId))) {
    return NextResponse.json({ error: "Question not found" }, { status: 404 });
  }

  // Persist an explicit incorrect record for every unanswered question. This
  // keeps the score denominator, review snapshot, and missed-question UI in
  // agreement instead of scoring omissions as wrong while silently dropping
  // them from the durable result.
  const submittedByQuestion = new Map(
    submittedAnswers.map((answer) => [answer.questionId, answer]),
  );
  const completeAnswers = activeQuestions.map(
    (question) =>
      submittedByQuestion.get(question.id) ?? { questionId: question.id },
  );

  const { correct, score, answerRecords } = scoreQuiz({
    attemptId,
    questionsById,
    answers: completeAnswers,
    totalQuestions: activeQuestions.length,
  });
  const progressScore = excludedIds.size
    ? Math.min(
        100,
        Math.round(
          ((excludedIds.size + correct) / quizQuestions.length) * 10000,
        ) / 100,
      )
    : score;
  const completedAt = new Date();

  // The attempt cap, read outside the transaction: it is static config, and
  // every statement kept out of the transaction below is one less chance for
  // two parallel submissions to interleave on SQLite's single write lock.
  const cap = await prisma.classQuiz.findUnique({
    where: { classId_quizId: { classId: attempt.classId, quizId } },
    select: { maxAttempts: true },
  });

  try {
    await prisma.$transaction(async (tx) => {
      // The claim stays the FIRST statement in this transaction. Opening with a
      // read instead takes only a shared lock, which lets a second submission
      // interleave and roll back writes that were never part of it.
      //
      // SECURITY: the completedAt read above is only a fast-path. This
      // conditional write is the real one-shot claim, so parallel PATCHes
      // cannot all grade the same attempt before any sees it completed.
      const claimed = await tx.quizAttempt.updateMany({
        where: { id: attemptId, studentId: student.id, completedAt: null },
        data: { score: progressScore, completedAt },
      });
      if (claimed.count !== 1) throw new AttemptAlreadySubmittedError();

      // SECURITY: the cap is enforced here as well as at start, because an
      // attempt id is all PATCH needs. Databases written before starting a quiz
      // began reusing the pending attempt can still hold several unfinished
      // attempts per student; without this, someone holding those ids could
      // grade every one and sail past maxAttempts. Checked after the claim (so
      // the write lock is already held) and excluding this attempt, which the
      // claim above has just marked completed — throwing rolls it back.
      if (cap?.maxAttempts && cap.maxAttempts > 0) {
        const usedAttempts = await tx.quizAttempt.count({
          where: {
            studentId: student.id,
            classId: attempt.classId,
            quizId,
            completedAt: { not: null },
            id: { not: attemptId },
            ...GRADED_ATTEMPTS,
          },
        });
        if (usedAttempts >= cap.maxAttempts) throw new AttemptLimitError();
      }

      const existing = await tx.quizProgress.findUnique({
        where: {
          studentId_classId_quizId: {
            studentId: student.id,
            classId: attempt.classId,
            quizId,
          },
        },
      });
      await tx.quizAnswer.createMany({
        data: answerRecords.map((record) => ({
          ...record,
          selectedOptionIds: JSON.stringify(record.selectedOptionIds),
        })),
      });
      await tx.quizProgress.upsert({
        where: {
          studentId_classId_quizId: {
            studentId: student.id,
            classId: attempt.classId,
            quizId,
          },
        },
        update: {
          status: "COMPLETED",
          bestScore: Math.max(progressScore, existing?.bestScore ?? 0),
        },
        create: {
          studentId: student.id,
          classId: attempt.classId,
          quizId,
          status: "COMPLETED",
          bestScore: progressScore,
        },
      });
    });
  } catch (error) {
    if (error instanceof AttemptLimitError) {
      return NextResponse.json(
        { error: "You've used all your attempts for this quiz." },
        { status: 403 },
      );
    }
    if (error instanceof AttemptAlreadySubmittedError) {
      return NextResponse.json(
        { error: "This attempt has already been submitted." },
        { status: 409 },
      );
    }
    throw error;
  }

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
      activeQuestions.map((q) => ({
        id: q.id,
        text: q.text,
        // Save the choice order the student saw so the coach's letter labels match.
        options: shuffleAnswerChoices(q.options, `${attemptId}:${q.id}`),
        // NUMERIC grading data + figure metadata flow into the durable snapshot
        // (see buildReviewSnapshot); ignored for plain choice questions.
        answerMode: q.answerMode,
        answerNumeric: q.answerNumeric,
        answerTolerance: q.answerTolerance,
        answerUnit: q.answerUnit,
        figureStorageKey: q.figureStorageKey,
        figureAlt: q.figureAlt,
      })),
      answerRecords,
    );

    const examResult = await prisma.examResult.create({
      data: {
        quizAttemptId: attemptId,
        studentId: student.id,
        classId: attempt.classId,
        quizId,
        studentName:
          [session.user.firstName, session.user.lastName]
            .filter(Boolean)
            .join(" ") || null,
        className: names?.class.name ?? "",
        topicName: names?.quiz?.topic?.name ?? "",
        quizName: names?.quiz?.name ?? "",
        score,
        correctCount: correct,
        // The quiz's question count, matching the scored denominator — not the
        // length of the client-supplied answers array.
        totalCount: activeQuestions.length,
        excludedCount: excludedIds.size,
        completedAt,
        reviewSnapshot: JSON.stringify(snapshot),
      },
    });

    try {
      enqueueExamResult(examResult.id);
    } catch (err) {
      logApiError(
        "QUIZ_SUBMIT",
        err,
        "Failed to enqueue exam-result generation",
      );
    }
  } catch (err) {
    logApiError("QUIZ_SUBMIT", err, "Failed to create ExamResult snapshot");
  }

  // Student-safe review: reveal only which submitted responses were incorrect.
  // The client already owns those prompts and responses from the active quiz,
  // so ids are enough to render them without returning answer keys, option
  // correctness, numeric solutions/tolerances, questions, or answer records.
  const incorrectQuestionIds = answerRecords.flatMap((record) =>
    record.isCorrect ? [] : [record.questionId],
  );
  return NextResponse.json({ score, incorrectQuestionIds });
}
