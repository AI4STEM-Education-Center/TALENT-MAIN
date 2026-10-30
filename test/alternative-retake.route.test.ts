import { describe, it, expect, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", () => ({
  enqueueQuizVariant: vi.fn(),
  enqueueExamResult: vi.fn(),
}));
import { auth } from "@/lib/auth";
import { enqueueExamResult } from "@/lib/queue";
import { prisma } from "@/lib/prisma";
import {
  GET as history,
  POST as start,
  PATCH as submit,
} from "@/app/api/quiz/practice/route";
import { POST as startQuiz, PATCH as submitQuiz } from "@/app/api/quiz/route";
import { getQuizStats, getStudentStats } from "@/lib/quiz-stats-server";
import {
  resetDb,
  createTeacher,
  createStudent,
  createClass,
  createPublishedQuiz,
} from "./db";

function req(body: unknown, method = "POST", path = "/api/quiz/practice") {
  return new NextRequest(`http://localhost${path}`, {
    method,
    body: JSON.stringify(body),
  });
}
function login(id: string) {
  vi.mocked(auth).mockResolvedValue({
    user: { id, role: "STUDENT", firstName: "Sam", lastName: "Student" },
  } as never);
}
beforeEach(async () => {
  await resetDb();
  vi.resetAllMocks();
});

// A two-question quiz (q1 = the helper's question, q2 added here) with one
// published alternative whose questions v1/v2 stem from q1/q2.
async function fixture() {
  const teacher = await createTeacher();
  const student = await createStudent();
  const cls = await createClass(teacher.teacher.id);
  await prisma.classEnrollment.create({
    data: { classId: cls.id, studentId: student.student.id },
  });
  const { quiz, question: q1 } = await createPublishedQuiz({
    classId: cls.id,
    teacherId: teacher.teacher.id,
  });
  const q2 = await prisma.question.create({
    data: {
      text: "What is 3 + 3?",
      quizId: quiz.id,
      answerMode: "SINGLE_SELECT",
      options: {
        create: [
          { text: "5", isCorrect: false },
          { text: "6", isCorrect: true },
        ],
      },
    },
  });
  const variant = (id: string, source: string) => ({
    id,
    sourceQuestionId: source,
    text: `Variant ${id}`,
    answerMode: "SINGLE_SELECT",
    answerUnit: null,
    answerNumeric: null,
    answerTolerance: null,
    options: [
      { id: `${id}-right`, text: "right", isCorrect: true },
      { id: `${id}-wrong`, text: "wrong", isCorrect: false },
    ],
    solution: "because",
    intentExplanation: "same idea",
  });
  const version = await prisma.quizPracticeVersion.create({
    data: {
      quizId: quiz.id,
      name: "Version A",
      status: "PUBLISHED",
      variation: "NUMBERS",
      sourceSnapshot: "[]",
      objectives: "[]",
      questions: JSON.stringify([variant("v1", q1.id), variant("v2", q2.id)]),
    },
  });
  login(student.user.id);
  return {
    teacher,
    student,
    cls,
    quiz,
    q1,
    q2,
    version,
    input: { classId: cls.id, quizId: quiz.id },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A completed graded attempt: q1 answered correctly, q2 incorrectly. */
async function gradedAttempt(f: Fixture, when = new Date("2026-01-01")) {
  const attempt = await prisma.quizAttempt.create({
    data: {
      studentId: f.student.student.id,
      classId: f.cls.id,
      quizId: f.quiz.id,
      score: 50,
      startedAt: when,
      completedAt: when,
    },
  });
  await prisma.quizAnswer.createMany({
    data: [
      { quizAttemptId: attempt.id, questionId: f.q1.id, isCorrect: true },
      { quizAttemptId: attempt.id, questionId: f.q2.id, isCorrect: false },
    ],
  });
  await prisma.quizProgress.create({
    data: {
      studentId: f.student.student.id,
      classId: f.cls.id,
      quizId: f.quiz.id,
      status: "COMPLETED",
      bestScore: 50,
    },
  });
  return attempt;
}

describe("excluding previously-correct questions", () => {
  it("offers the choice only once there is history and reports what it would skip", async () => {
    const f = await fixture();
    const url = `http://localhost/api/quiz/practice?${new URLSearchParams(f.input)}`;
    expect(
      (await (await history(new NextRequest(url))).json()).last,
    ).toBeNull();
    await gradedAttempt(f);
    expect((await (await history(new NextRequest(url))).json()).last).toEqual({
      total: 2,
      correct: 1,
    });
  });

  it("asks the full version unless excluding, then only the missed questions", async () => {
    const f = await fixture();
    await gradedAttempt(f);
    const full = await (await start(req(f.input))).json();
    expect(full.questions.map((q: { id: string }) => q.id)).toEqual([
      "v1",
      "v2",
    ]);
    expect(full.excludedCount).toBe(0);
    // Abandon it (resume would otherwise return the same run) and restart.
    await prisma.quizPracticeAttempt.deleteMany();
    await prisma.quizAttempt.deleteMany({
      where: { practiceVersionId: { not: null } },
    });

    const started = await (
      await start(req({ ...f.input, excludeCorrect: true }))
    ).json();
    expect(started.questions.map((q: { id: string }) => q.id)).toEqual(["v2"]);
    expect(started.excludedCount).toBe(1);
    expect(started.exclusionIgnored).toBe(false);
    const attempt = await prisma.quizAttempt.findUniqueOrThrow({
      where: { id: started.quizAttemptId },
    });
    expect(JSON.parse(attempt.excludedQuestionIds)).toEqual([f.q1.id]);

    // A wrong answer on the one asked question: the score covers just it.
    const response = await submit(
      req(
        {
          attemptId: started.attemptId,
          answers: [{ questionId: "v2", selectedOptionIds: ["v2-wrong"] }],
        },
        "PATCH",
      ),
    );
    expect(await response.json()).toMatchObject({
      score: 0,
      incorrectQuestionIds: ["v2"],
    });
    const result = await prisma.examResult.findUniqueOrThrow({
      where: { quizAttemptId: started.quizAttemptId },
    });
    expect(result).toMatchObject({
      score: 0,
      correctCount: 0,
      totalCount: 1,
      excludedCount: 1,
      practiceVersionName: "Version A",
    });
    expect(JSON.parse(result.reviewSnapshot).questions).toHaveLength(1);
    expect(enqueueExamResult).toHaveBeenCalledWith(result.id);
  });

  it("falls back to the full version when everything was already correct", async () => {
    const f = await fixture();
    const earlier = await gradedAttempt(f);
    await prisma.quizAnswer.updateMany({
      where: { quizAttemptId: earlier.id },
      data: { isCorrect: true },
    });
    const started = await (
      await start(req({ ...f.input, excludeCorrect: true }))
    ).json();
    expect(started.questions).toHaveLength(2);
    expect(started.excludedCount).toBe(0);
    expect(started.exclusionIgnored).toBe(true);
  });

  it("counts earlier alternative retakes as history for later exclusions", async () => {
    const f = await fixture();
    await gradedAttempt(f);
    const first = await (
      await start(req({ ...f.input, excludeCorrect: true }))
    ).json();
    // q2 is now answered correctly on the alternative version.
    await submit(
      req(
        {
          attemptId: first.attemptId,
          answers: [{ questionId: "v2", selectedOptionIds: ["v2-right"] }],
        },
        "PATCH",
      ),
    );
    expect(
      (
        await prisma.quizAnswer.findMany({
          where: { quizAttemptId: first.quizAttemptId },
        })
      ).map((a) => [a.questionId, a.isCorrect]),
    ).toEqual([[f.q2.id, true]]);
    // Both questions are now correct as of their latest result, so there is
    // nothing left to isolate and the full version is used.
    const second = await (
      await start(req({ ...f.input, excludeCorrect: true }))
    ).json();
    expect(second.exclusionIgnored).toBe(true);
    expect(second.questions).toHaveLength(2);
  });

  it("resumes an in-progress retake exactly as started, ignoring a new exclusion request", async () => {
    const f = await fixture();
    await gradedAttempt(f);
    const first = await (
      await start(req({ ...f.input, excludeCorrect: true }))
    ).json();
    const again = await (await start(req(f.input))).json();
    expect(again.attemptId).toBe(first.attemptId);
    expect(again.questions).toEqual(first.questions);
    expect(again.excludedCount).toBe(1);
    expect(
      await prisma.quizAttempt.count({ where: { completedAt: null } }),
    ).toBe(1);
  });
});

describe("how alternative retakes relate to graded attempts", () => {
  it("does not consume the attempt cap or get resumed/graded by the ordinary quiz", async () => {
    const f = await fixture();
    await gradedAttempt(f);
    await prisma.classQuiz.update({
      where: { classId_quizId: f.input },
      data: { maxAttempts: 1 },
    });
    // Graded allowance is used up, yet practice on an alternative still works.
    expect((await startQuiz(req(f.input, "POST", "/api/quiz"))).status).toBe(
      403,
    );
    const started = await (await start(req(f.input))).json();
    expect(started.quizAttemptId).toBeTruthy();
    // The unfinished alternative retake must not be mistaken for a graded one.
    await prisma.classQuiz.update({
      where: { classId_quizId: f.input },
      data: { maxAttempts: null },
    });
    const normal = await (
      await startQuiz(req(f.input, "POST", "/api/quiz"))
    ).json();
    expect(normal.attemptId).not.toBe(started.quizAttemptId);
    // And the ordinary submit endpoint refuses to grade it against the quiz.
    expect(
      (
        await submitQuiz(
          req(
            { attemptId: started.quizAttemptId, answers: [] },
            "PATCH",
            "/api/quiz",
          ),
        )
      ).status,
    ).toBe(409);
  });

  it("keeps graded progress, best score and per-question stats unchanged", async () => {
    const f = await fixture();
    await gradedAttempt(f);
    const started = await (await start(req(f.input))).json();
    await submit(
      req(
        {
          attemptId: started.attemptId,
          answers: [
            { questionId: "v1", selectedOptionIds: ["v1-right"] },
            { questionId: "v2", selectedOptionIds: ["v2-right"] },
          ],
        },
        "PATCH",
      ),
    );
    const progress = await prisma.quizProgress.findFirstOrThrow({
      where: { quizId: f.quiz.id },
    });
    expect(progress.bestScore).toBe(50);

    const stats = await getQuizStats(f.cls.id, f.quiz.id);
    expect(stats).toMatchObject({
      attemptsTotal: 1,
      alternativeAttemptsTotal: 1,
      max: 50,
      mean: 50,
    });
    expect(stats!.students[0]).toMatchObject({
      attempts: 1,
      alternativeAttempts: 1,
      bestScore: 50,
    });
    // q2 was answered once on the graded quiz (wrong); the alternative's
    // correct answer is not folded into the quiz's own question statistics.
    expect(
      stats!.questionStats.find((q) => q.questionId === f.q2.id),
    ).toMatchObject({ total: 1, correct: 0 });

    const student = await getStudentStats(f.cls.id, f.student.student.id);
    expect(student).toMatchObject({ totalAttempts: 1, avgBestScore: 50 });
    expect(student!.attempts.map((a) => a.alternativeVersion)).toEqual(
      expect.arrayContaining([null, "Version A"]),
    );
    expect(student!.attempts).toHaveLength(2);
  });

  it("files a run started before retakes were recorded when it is submitted", async () => {
    const f = await fixture();
    const legacy = await prisma.quizPracticeAttempt.create({
      data: {
        studentId: f.student.student.id,
        classId: f.cls.id,
        quizId: f.quiz.id,
        versionId: f.version.id,
        versionName: "Version A",
        questions: f.version.questions,
        activeKey: JSON.stringify([f.student.student.id, f.cls.id, f.quiz.id]),
      },
    });
    const response = await submit(
      req(
        {
          attemptId: legacy.id,
          answers: [{ questionId: "v1", selectedOptionIds: ["v1-right"] }],
        },
        "PATCH",
      ),
    );
    const body = await response.json();
    expect(body.score).toBe(50);
    const filed = await prisma.quizAttempt.findUniqueOrThrow({
      where: { id: body.quizAttemptId },
    });
    expect(filed).toMatchObject({
      practiceVersionId: f.version.id,
      score: 50,
      startedAt: legacy.startedAt,
    });
    expect(
      (
        await prisma.quizPracticeAttempt.findUniqueOrThrow({
          where: { id: legacy.id },
        })
      ).quizAttemptId,
    ).toBe(body.quizAttemptId);
    expect(
      await prisma.examResult.count({
        where: { quizAttemptId: body.quizAttemptId },
      }),
    ).toBe(1);
  });

  it("still records the retake when a source question was deleted afterwards", async () => {
    const f = await fixture();
    const started = await (await start(req(f.input))).json();
    await prisma.question.delete({ where: { id: f.q2.id } });
    const response = await submit(
      req(
        {
          attemptId: started.attemptId,
          answers: [
            { questionId: "v1", selectedOptionIds: ["v1-right"] },
            { questionId: "v2", selectedOptionIds: ["v2-right"] },
          ],
        },
        "PATCH",
      ),
    );
    expect(response.status).toBe(200);
    expect(
      await prisma.quizAnswer.count({
        where: { quizAttemptId: started.quizAttemptId },
      }),
    ).toBe(1);
    expect(
      await prisma.examResult.count({
        where: { quizAttemptId: started.quizAttemptId },
      }),
    ).toBe(1);
  });
});
