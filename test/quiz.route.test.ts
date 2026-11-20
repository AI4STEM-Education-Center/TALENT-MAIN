import { NextRequest } from "next/server";
import {
  GET as alternativeHistory,
  POST as startAlternative,
  PATCH as submitAlternative,
} from "@/app/api/quiz/practice/route";
import type { UnifiedQuizOverview } from "@/lib/quiz-overview";
import type { VariantQuestion } from "@/lib/quiz-variants";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueExamResult: vi.fn() }));

import { GET, POST, PATCH } from "@/app/api/quiz/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  resetDb,
  createTeacher,
  createStudent,
  createClass,
  createPublishedQuiz,
} from "./db";

const mockAuth = vi.mocked(auth);

function jsonReq(body: unknown) {
  return new Request("http://localhost/api/quiz", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function asStudent(userId: string) {
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "STUDENT" },
  } as never);
}

async function setup(
  opts: {
    published?: boolean;
    answerMode?: "SINGLE_SELECT" | "MULTI_SELECT";
  } = {},
) {
  const { teacher } = await createTeacher();
  const cls = await createClass(teacher.id);
  const { user: studentUser, student } = await createStudent();
  await prisma.classEnrollment.create({
    data: { classId: cls.id, studentId: student.id },
  });
  const mod = await createPublishedQuiz({
    classId: cls.id,
    teacherId: teacher.id,
    answerMode: opts.answerMode ?? "SINGLE_SELECT",
    published: opts.published ?? true,
  });
  const optionId = (text: string) =>
    mod.question.options.find((o) => o.text === text)!.id;
  return { teacher, cls, studentUser, student, ...mod, optionId };
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/quiz (start attempt)", () => {
  it("rejects a non-student with 401", async () => {
    mockAuth.mockResolvedValue({ user: { id: "x", role: "TEACHER" } } as never);
    const res = await POST(jsonReq({ classId: "c", quizId: "q" }));
    expect(res.status).toBe(401);
  });

  it("requires classId and quizId", async () => {
    const { studentUser } = await setup();
    asStudent(studentUser.id);
    const res = await POST(jsonReq({ classId: "c" }));
    expect(res.status).toBe(400);
  });

  it("rejects a student not enrolled in the class with 403", async () => {
    const { cls, quiz } = await setup();
    const { user: outsider } = await createStudent();
    asStudent(outsider.id);
    const res = await POST(jsonReq({ classId: cls.id, quizId: quiz.id }));
    expect(res.status).toBe(403);
  });

  it("rejects an unpublished quiz with 403", async () => {
    const { studentUser, cls, quiz } = await setup({ published: false });
    asStudent(studentUser.id);
    const res = await POST(jsonReq({ classId: cls.id, quizId: quiz.id }));
    expect(res.status).toBe(403);
  });

  it("starts an attempt without leaking teacher feedback or answer keys", async () => {
    const { studentUser, cls, quiz, question } = await setup();
    await prisma.question.update({
      where: { id: question.id },
      data: {
        feedbackGeneral: "Teacher feedback",
        feedbackCorrect: "Explanation for a correct answer",
        feedbackIncorrect: "Explanation for an incorrect answer",
        answerNumeric: 4,
        answerTolerance: 0.01,
      },
    });
    asStudent(studentUser.id);
    const res = await POST(jsonReq({ classId: cls.id, quizId: quiz.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attemptId).toBeTruthy();
    expect(body.questions).toHaveLength(1);
    const [startedQuestion] = body.questions;
    for (const field of [
      "feedbackGeneral",
      "feedbackCorrect",
      "feedbackIncorrect",
      "answerNumeric",
      "answerTolerance",
      "isCorrect",
    ]) {
      expect(startedQuestion).not.toHaveProperty(field);
    }
    expect(startedQuestion.options).toHaveLength(question.options.length);
    for (const option of startedQuestion.options) {
      expect(option).not.toHaveProperty("isCorrect");
    }

    // Progress is marked IN_PROGRESS.
    const progress = await prisma.quizProgress.findFirst({
      where: { quizId: quiz.id },
    });
    expect(progress?.status).toBe("IN_PROGRESS");
  });
});

describe("POST /api/quiz (per-class settings enforcement)", () => {
  const HOUR = 60 * 60 * 1000;

  it("rejects with 403 before the availability window opens", async () => {
    const { studentUser, cls, quiz } = await setup();
    await prisma.classQuiz.updateMany({
      where: { classId: cls.id, quizId: quiz.id },
      data: { availableFrom: new Date(Date.now() + HOUR) },
    });
    asStudent(studentUser.id);
    const res = await POST(jsonReq({ classId: cls.id, quizId: quiz.id }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/isn't open/i);
  });

  it("rejects with 403 after the availability window closes", async () => {
    const { studentUser, cls, quiz } = await setup();
    await prisma.classQuiz.updateMany({
      where: { classId: cls.id, quizId: quiz.id },
      data: { availableUntil: new Date(Date.now() - HOUR) },
    });
    asStudent(studentUser.id);
    const res = await POST(jsonReq({ classId: cls.id, quizId: quiz.id }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/closed/i);
  });

  it("allows starting inside an open window", async () => {
    const { studentUser, cls, quiz } = await setup();
    await prisma.classQuiz.updateMany({
      where: { classId: cls.id, quizId: quiz.id },
      data: {
        availableFrom: new Date(Date.now() - HOUR),
        availableUntil: new Date(Date.now() + HOUR),
      },
    });
    asStudent(studentUser.id);
    const res = await POST(jsonReq({ classId: cls.id, quizId: quiz.id }));
    expect(res.status).toBe(200);
  });

  it("rejects with 403 once maxAttempts completed attempts have been used", async () => {
    const { studentUser, student, cls, quiz } = await setup();
    await prisma.classQuiz.updateMany({
      where: { classId: cls.id, quizId: quiz.id },
      data: { maxAttempts: 1 },
    });
    // One completed attempt already exists.
    await prisma.quizAttempt.create({
      data: {
        studentId: student.id,
        classId: cls.id,
        quizId: quiz.id,
        completedAt: new Date(),
        score: 50,
      },
    });
    asStudent(studentUser.id);
    const res = await POST(jsonReq({ classId: cls.id, quizId: quiz.id }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/all 1 attempts/i);
  });

  it("resumes an unfinished attempt instead of allocating a second slot", async () => {
    const { studentUser, student, cls, quiz } = await setup();
    await prisma.classQuiz.updateMany({
      where: { classId: cls.id, quizId: quiz.id },
      data: { maxAttempts: 1 },
    });
    // Left mid-quiz — closed the tab, lost the network, hit reload. Coming back
    // must return the SAME attempt, not burn the student's only slot.
    const pending = await prisma.quizAttempt.create({
      data: { studentId: student.id, classId: cls.id, quizId: quiz.id },
    });
    asStudent(studentUser.id);
    const res = await POST(jsonReq({ classId: cls.id, quizId: quiz.id }));

    expect(res.status).toBe(200);
    expect((await res.json()).attemptId).toBe(pending.id);
    // Reusing the pending attempt is also what stops a student stockpiling
    // attempt IDs to submit one at a time against the correctness feedback.
    expect(
      await prisma.quizAttempt.count({
        where: { studentId: student.id, quizId: quiz.id },
      }),
    ).toBe(1);
  });

  it("refuses to grade a stockpiled attempt once the cap is spent", async () => {
    const { studentUser, student, cls, quiz } = await setup();
    await prisma.classQuiz.updateMany({
      where: { classId: cls.id, quizId: quiz.id },
      data: { maxAttempts: 1 },
    });
    // Rows like these exist in databases written before starting a quiz reused
    // the pending attempt: several unfinished attempts, whose ids the student
    // still holds and can PATCH directly without going through POST.
    const stockpiled = await prisma.quizAttempt.create({
      data: { studentId: student.id, classId: cls.id, quizId: quiz.id },
    });
    await prisma.quizAttempt.create({
      data: {
        studentId: student.id,
        classId: cls.id,
        quizId: quiz.id,
        completedAt: new Date(),
        score: 50,
      },
    });
    asStudent(studentUser.id);

    const res = await PATCH(jsonReq({ attemptId: stockpiled.id, answers: [] }));
    expect(res.status).toBe(403);
    const stored = await prisma.quizAttempt.findUnique({
      where: { id: stockpiled.id },
    });
    expect(stored?.completedAt).toBeNull();
  });
});

describe("PATCH /api/quiz (submit answers)", () => {
  async function startAttempt(
    studentId: string,
    classId: string,
    quizId: string,
  ) {
    return prisma.quizAttempt.create({ data: { studentId, classId, quizId } });
  }

  it("scores a correct single-select answer as 100 and persists a JSON-string selection", async () => {
    const s = await setup({ answerMode: "SINGLE_SELECT" });
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);

    const res = await PATCH(
      jsonReq({
        attemptId: attempt.id,
        answers: [
          { questionId: s.question.id, selectedOptionId: s.optionId("4") },
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.score).toBe(100);
    expect(body.incorrectQuestionIds).toEqual([]);
    // Student-safe results identify misses but never leak answer-key data.
    expect(body.correct).toBeUndefined();
    expect(body.total).toBeUndefined();
    expect(body).not.toHaveProperty("questions");
    expect(body).not.toHaveProperty("answers");

    // Regression guard: selectedOptionIds is stored as a JSON string, not a raw array.
    const saved = await prisma.quizAnswer.findFirst({
      where: { quizAttemptId: attempt.id },
    });
    expect(typeof saved?.selectedOptionIds).toBe("string");
    expect(JSON.parse(saved!.selectedOptionIds)).toEqual([s.optionId("4")]);
    expect(saved?.isCorrect).toBe(true);

    // Attempt + progress updated.
    const updated = await prisma.quizAttempt.findUnique({
      where: { id: attempt.id },
    });
    expect(updated?.score).toBe(100);
    expect(updated?.completedAt).not.toBeNull();
    const progress = await prisma.quizProgress.findFirst({
      where: { quizId: s.quiz.id },
    });
    expect(progress?.status).toBe("COMPLETED");
    expect(progress?.bestScore).toBe(100);
  });

  it("scores a wrong single-select answer as 0", async () => {
    const s = await setup({ answerMode: "SINGLE_SELECT" });
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);
    const res = await PATCH(
      jsonReq({
        attemptId: attempt.id,
        answers: [
          { questionId: s.question.id, selectedOptionId: s.optionId("3") },
        ],
      }),
    );
    const body = await res.json();
    expect(body.score).toBe(0);
    expect(body.incorrectQuestionIds).toEqual([s.question.id]);
  });

  it("requires the exact correct set for multi-select", async () => {
    const s = await setup({ answerMode: "MULTI_SELECT" });
    asStudent(s.studentUser.id);

    // Exact set -> correct.
    const a1 = await startAttempt(s.student.id, s.cls.id, s.quiz.id);
    const exact = await PATCH(
      jsonReq({
        attemptId: a1.id,
        answers: [
          {
            questionId: s.question.id,
            selectedOptionIds: [s.optionId("4"), s.optionId("5")],
          },
        ],
      }),
    );
    expect(await exact.json()).toMatchObject({
      score: 100,
      incorrectQuestionIds: [],
    });

    // Partial set -> wrong.
    const a2 = await startAttempt(s.student.id, s.cls.id, s.quiz.id);
    const partial = await PATCH(
      jsonReq({
        attemptId: a2.id,
        answers: [
          { questionId: s.question.id, selectedOptionIds: [s.optionId("4")] },
        ],
      }),
    );
    expect(await partial.json()).toMatchObject({
      score: 0,
      incorrectQuestionIds: [s.question.id],
    });
  });

  it("returns an incorrect id for a wrong numeric response without the solution", async () => {
    const s = await setup();
    await prisma.question.update({
      where: { id: s.question.id },
      data: {
        answerMode: "NUMERIC",
        answerNumeric: 5,
        answerTolerance: 0.1,
        answerUnit: "m",
      },
    });
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);

    const res = await PATCH(
      jsonReq({
        attemptId: attempt.id,
        answers: [{ questionId: s.question.id, numericValue: 0 }],
      }),
    );
    const body = await res.json();

    expect(body).toEqual({
      score: 0,
      incorrectQuestionIds: [s.question.id],
    });
    expect(body).not.toHaveProperty("answerNumeric");
    expect(body).not.toHaveProperty("answerTolerance");
  });

  it("keeps the best score across attempts", async () => {
    const s = await setup({ answerMode: "SINGLE_SELECT" });
    asStudent(s.studentUser.id);

    const good = await startAttempt(s.student.id, s.cls.id, s.quiz.id);
    await PATCH(
      jsonReq({
        attemptId: good.id,
        answers: [
          { questionId: s.question.id, selectedOptionId: s.optionId("4") },
        ],
      }),
    );

    const bad = await startAttempt(s.student.id, s.cls.id, s.quiz.id);
    await PATCH(
      jsonReq({
        attemptId: bad.id,
        answers: [
          { questionId: s.question.id, selectedOptionId: s.optionId("3") },
        ],
      }),
    );

    const progress = await prisma.quizProgress.findFirst({
      where: { quizId: s.quiz.id },
    });
    expect(progress?.bestScore).toBe(100); // not overwritten by the later 0
  });

  it("rejects submitting to another student's attempt with 404", async () => {
    const s = await setup();
    const other = await createStudent();
    const attempt = await startAttempt(other.student.id, s.cls.id, s.quiz.id);
    asStudent(s.studentUser.id);
    const res = await PATCH(
      jsonReq({
        attemptId: attempt.id,
        answers: [
          { questionId: s.question.id, selectedOptionId: s.optionId("4") },
        ],
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 404 when an answer references an unknown question", async () => {
    const s = await setup();
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);
    const res = await PATCH(
      jsonReq({
        attemptId: attempt.id,
        answers: [{ questionId: "ghost", selectedOptionId: "x" }],
      }),
    );
    expect(res.status).toBe(404);
  });
});

// Regression tests for the submission-integrity fixes. Each of these was
// exploitable by a student against their own attempt.
describe("PATCH /api/quiz (submission integrity)", () => {
  const startAttempt = (studentId: string, classId: string, quizId: string) =>
    prisma.quizAttempt.create({ data: { studentId, classId, quizId } });

  it("refuses to re-grade an already-submitted attempt", async () => {
    const s = await setup();
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);

    const first = await PATCH(
      jsonReq({
        attemptId: attempt.id,
        answers: [
          { questionId: s.question.id, selectedOptionId: s.optionId("3") },
        ],
      }),
    );
    expect((await first.json()).score).toBe(0);

    // Replaying the same attempt is what turned the response's
    // incorrectQuestionIds into an answer-key oracle, and it sidestepped the
    // per-class maxAttempts cap (which only counts completed attempts).
    const replay = await PATCH(
      jsonReq({
        attemptId: attempt.id,
        answers: [
          { questionId: s.question.id, selectedOptionId: s.optionId("4") },
        ],
      }),
    );
    expect(replay.status).toBe(409);

    const stored = await prisma.quizAttempt.findUnique({
      where: { id: attempt.id },
    });
    expect(stored?.score).toBe(0); // the replay did not overwrite the real score
  });

  it("atomically accepts only one of two parallel submissions", async () => {
    const s = await setup();
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);

    const [one, two] = await Promise.all([
      PATCH(
        jsonReq({
          attemptId: attempt.id,
          answers: [
            { questionId: s.question.id, selectedOptionId: s.optionId("3") },
          ],
        }),
      ),
      PATCH(
        jsonReq({
          attemptId: attempt.id,
          answers: [
            { questionId: s.question.id, selectedOptionId: s.optionId("4") },
          ],
        }),
      ),
    ]);

    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(
      await prisma.quizAnswer.count({ where: { quizAttemptId: attempt.id } }),
    ).toBe(1);
    expect(
      await prisma.examResult.count({ where: { quizAttemptId: attempt.id } }),
    ).toBe(1);
  });

  it("scores against the quiz's question count, not the submitted subset", async () => {
    const s = await setup();
    // A second question the student simply won't answer.
    const unanswered = await prisma.question.create({
      data: {
        text: "What is 3 + 3?",
        quizId: s.quiz.id,
        answerMode: "SINGLE_SELECT",
        options: {
          create: [
            { text: "6", isCorrect: true },
            { text: "7", isCorrect: false },
          ],
        },
      },
    });
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);

    const res = await PATCH(
      jsonReq({
        attemptId: attempt.id,
        answers: [
          { questionId: s.question.id, selectedOptionId: s.optionId("4") },
        ],
      }),
    );
    // 1 of the quiz's 2 questions correct. Deriving the denominator from the
    // client's array would have scored this 100.
    const body = await res.json();
    expect(body.score).toBe(50);
    expect(body.incorrectQuestionIds).toContain(unanswered.id);
    expect(
      await prisma.quizAnswer.count({ where: { quizAttemptId: attempt.id } }),
    ).toBe(2);
  });

  it("rejects an answer for a question belonging to another quiz", async () => {
    const s = await setup();
    const other = await createPublishedQuiz({
      classId: s.cls.id,
      teacherId: s.teacher.id,
    });
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);

    const res = await PATCH(
      jsonReq({
        attemptId: attempt.id,
        answers: [
          {
            questionId: other.question.id,
            selectedOptionId: other.question.options.find((o) => o.isCorrect)!
              .id,
          },
        ],
      }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects the same question answered twice", async () => {
    const s = await setup();
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);

    // Repeating a known-correct answer would otherwise push `correct` past the
    // question count and score above 100.
    const res = await PATCH(
      jsonReq({
        attemptId: attempt.id,
        answers: [
          { questionId: s.question.id, selectedOptionId: s.optionId("4") },
          { questionId: s.question.id, selectedOptionId: s.optionId("4") },
        ],
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("unified quiz overview and question opt-out", () => {
  const overview = (classId: string, quizId: string) =>
    GET(
      new NextRequest(
        `http://localhost/api/quiz?${new URLSearchParams({ classId, quizId })}`,
      ),
    );
  const practiceReq = (body: object) =>
    new NextRequest("http://localhost/api/quiz/practice", {
      method: "POST",
      body: JSON.stringify(body),
    });

  it("allows only students enrolled in an active class with a published quiz", async () => {
    const { cls, quiz, studentUser } = await setup({ published: false });
    expect((await overview(cls.id, quiz.id)).status).toBe(401);
    const { user: stranger } = await createStudent();
    asStudent(stranger.id);
    expect((await overview(cls.id, quiz.id)).status).toBe(403);
    asStudent(studentUser.id);
    expect((await overview(cls.id, quiz.id)).status).toBe(403);
    await prisma.classQuiz.updateMany({ data: { published: true } });
    await prisma.class.update({
      where: { id: cls.id },
      data: { disabledAt: new Date() },
    });
    const paused = await overview(cls.id, quiz.id);
    expect(paused.status).toBe(403);
    expect(await paused.json()).toMatchObject({ code: "PLATFORM_PAUSED" });
  });

  it("caps the merged attempt history at thirty and reports the official attempt limit", async () => {
    const { cls, quiz, studentUser, student } = await setup();
    asStudent(studentUser.id);
    await prisma.classQuiz.updateMany({ data: { maxAttempts: 2 } });
    const attempts = Array.from({ length: 32 }, (_, index) => ({
      id: `overview-attempt-${index}`,
      studentId: student.id,
      classId: cls.id,
      quizId: quiz.id,
      practiceVersionId: index % 2 ? "alternative" : null,
      practiceVersionName: index % 2 ? "Alternative" : null,
      startedAt: new Date(2026, 0, index + 1),
      completedAt: new Date(2026, 0, index + 1),
    }));
    await prisma.quizAttempt.createMany({ data: attempts });
    const data: UnifiedQuizOverview = await (
      await overview(cls.id, quiz.id)
    ).json();
    expect(data.recentAttempts.map((attempt) => attempt.id)).toEqual(
      attempts
        .reverse()
        .slice(0, 30)
        .map((attempt) => attempt.id),
    );
    expect(data.gradedAttemptCount).toBe(16);
    expect(data.availability).toMatchObject({
      attemptsExhausted: true,
      locked: true,
    });
  });

  it("uses latest source correctness across both modes and preserves exclusions through resume, scoring, and review", async () => {
    const { cls, quiz, topic, question, studentUser, student, optionId } =
      await setup();
    asStudent(studentUser.id);
    const target = { classId: cls.id, quizId: quiz.id };
    const who = { ...target, studentId: student.id };
    const [second, third] = await Promise.all([
      prisma.question.create({
        data: {
          quizId: quiz.id,
          order: 2,
          text: "Second question. ".repeat(14),
        },
      }),
      prisma.question.create({
        data: { quizId: quiz.id, order: 3, text: "Third question" },
      }),
    ]);
    const official = await prisma.quizAttempt.create({
      data: {
        ...who,
        startedAt: new Date("2026-01-01"),
        completedAt: new Date("2026-01-01"),
        score: 33.33,
        answers: {
          create: [
            { questionId: question.id, isCorrect: true },
            { questionId: second.id, isCorrect: false },
          ],
        },
      },
    });
    const variants: VariantQuestion[] = [question.id, second.id, third.id].map(
      (sourceQuestionId, index) => ({
        id: `v${index}`,
        sourceQuestionId,
        text: `Variant ${index}`,
        answerMode: "SINGLE_SELECT",
        answerUnit: null,
        answerNumeric: null,
        answerTolerance: null,
        options: [
          { id: `v${index}-right`, text: "right", isCorrect: true },
          { id: `v${index}-wrong`, text: "wrong", isCorrect: false },
        ],
        solution: "Reasoning",
        intentExplanation: "Same skill",
      }),
    );
    await prisma.quizPracticeVersion.create({
      data: {
        quizId: quiz.id,
        name: "Alternative",
        variation: "NUMBERS",
        status: "PUBLISHED",
        sourceSnapshot: "[]",
        objectives: "[]",
        questions: JSON.stringify(variants),
      },
    });

    const started = await startAlternative(
      practiceReq({
        ...target,
        excludedQuestionIds: [question.id, second.id, "unknown"],
      }),
    );
    expect(started.status).toBe(200);
    const alternative = await started.json();
    expect(alternative).toMatchObject({
      excludedCount: 1,
      exclusionIgnored: false,
      questions: [{ id: "v1" }, { id: "v2" }],
    });
    const duringPractice = (await (
      await overview(cls.id, quiz.id)
    ).json()) as UnifiedQuizOverview;
    expect(duringPractice.practiceAttempt).toMatchObject({
      id: alternative.attemptId,
      quizAttemptId: alternative.quizAttemptId,
    });
    const resumedAlternative = await (
      await startAlternative(
        practiceReq({ ...target, excludedQuestionIds: [] }),
      )
    ).json();
    expect(resumedAlternative).toEqual(alternative);
    const practiced = await submitAlternative(
      practiceReq({
        attemptId: alternative.attemptId,
        answers: [
          { questionId: "v1", selectedOptionId: "v1-right" },
          { questionId: "v2", selectedOptionId: "v2-wrong" },
        ],
      }),
    );
    expect(practiced.status).toBe(200);

    const response = await overview(cls.id, quiz.id);
    const quizOverview: UnifiedQuizOverview = await response.json();
    expect(quizOverview).toMatchObject({
      quiz: { id: quiz.id, name: quiz.name, topicName: topic.name },
      availability: { locked: false },
      gradedAttemptCount: 1,
      gradedAttempt: null,
      practiceAvailableCount: 1,
      practiceCanStart: true,
      practiceAttempt: null,
      previouslyCorrect: [question.id, second.id],
      recentAttempts: [
        {
          id: alternative.quizAttemptId,
          kind: "alternative",
          versionName: "Alternative",
          excludedCount: 1,
        },
        { id: official.id, kind: "official", score: 33.33 },
      ],
    });
    expect(quizOverview.questions).toEqual([
      { number: 1, id: question.id, previewText: question.text },
      { number: 2, id: second.id, previewText: expect.stringMatching(/…$/) },
      { number: 3, id: third.id, previewText: third.text },
    ]);
    expect(quizOverview.questions[1].previewText).toHaveLength(140);

    const start = await POST(
      jsonReq({
        ...target,
        excludeCorrect: true,
        excludedQuestionIds: [second.id, third.id, "unknown"],
      }),
    );
    expect(start.status).toBe(200);
    const attempt = await start.json();
    expect(attempt).toMatchObject({
      excludedCount: 1,
      exclusionIgnored: false,
      questions: [{ id: question.id }, { id: third.id }],
    });
    expect(await (await overview(cls.id, quiz.id)).json()).toMatchObject({
      gradedAttempt: {
        id: attempt.attemptId,
        excludedQuestionIds: [second.id],
      },
    });
    const resume = await POST(jsonReq({ ...target, excludeCorrect: true }));
    expect(await resume.json()).toEqual(attempt);

    const submit = (
      answers: { questionId: string; selectedOptionId?: string }[],
    ) => PATCH(jsonReq({ attemptId: attempt.attemptId, answers }));
    expect((await submit([{ questionId: second.id }])).status).toBe(404);
    expect((await submit([{ questionId: "none" }])).status).toBe(404);
    const submitted = await submit([
      { questionId: question.id, selectedOptionId: optionId("4") },
    ]);
    expect(await submitted.json()).toEqual({
      score: 50,
      incorrectQuestionIds: [third.id],
    });
    expect(
      await prisma.quizAnswer.findMany({
        where: { quizAttemptId: attempt.attemptId },
        select: { questionId: true, isCorrect: true },
        orderBy: { isCorrect: "desc" },
      }),
    ).toEqual([
      { questionId: question.id, isCorrect: true },
      { questionId: third.id, isCorrect: false },
    ]);
    expect(
      await prisma.quizAnswer.count({
        where: {
          quizAttemptId: alternative.quizAttemptId,
          questionId: second.id,
          isCorrect: true,
        },
      }),
    ).toBe(1);
    expect(
      await prisma.examResult.findUnique({
        where: { quizAttemptId: attempt.attemptId },
      }),
    ).toMatchObject({
      totalCount: 2,
      correctCount: 1,
      excludedCount: 1,
      score: 50,
    });
    const storedAttempt = await prisma.quizAttempt.findUniqueOrThrow({
      where: { id: attempt.attemptId },
    });
    expect(storedAttempt.score).toBe(66.67);
    expect(await prisma.quizProgress.findFirst({ where: who })).toMatchObject({
      status: "COMPLETED",
      bestScore: storedAttempt.score,
    });
  });

  it("clears stored exclusions if quiz edits leave a resumed attempt empty", async () => {
    const { cls, quiz, question, studentUser, student } = await setup();
    asStudent(studentUser.id);
    const target = { classId: cls.id, quizId: quiz.id };
    const active = await prisma.question.create({
      data: { quizId: quiz.id, order: 2, text: "Active question" },
    });
    const attempt = await prisma.quizAttempt.create({
      data: {
        ...target,
        studentId: student.id,
        excludedQuestionIds: JSON.stringify([question.id]),
      },
    });
    await prisma.question.delete({ where: { id: active.id } });

    const resumed = await POST(jsonReq(target));
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      attemptId: attempt.id,
      questions: [{ id: question.id }],
      excludedCount: 0,
      exclusionIgnored: true,
    });
    expect(
      await prisma.quizAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
    ).toMatchObject({ excludedQuestionIds: "[]", completedAt: null });
  });

  it("ignores inline cards for full retake history and version rotation", async () => {
    const { cls, quiz, question, studentUser, student } = await setup();
    asStudent(studentUser.id);
    const target = { classId: cls.id, quizId: quiz.id };
    const questions = JSON.stringify([
      {
        id: "v",
        sourceQuestionId: question.id,
        text: "Variant",
        answerMode: "NUMERIC",
        answerUnit: null,
        answerNumeric: 4,
        answerTolerance: 0.01,
        options: [],
        solution: "4",
        intentExplanation: "Same skill",
      } satisfies VariantQuestion,
    ]);
    const createVersion = (name: string, createdAt: Date) =>
      prisma.quizPracticeVersion.create({
        data: {
          quizId: quiz.id,
          name,
          createdAt,
          variation: "NUMBERS",
          status: "PUBLISHED",
          sourceSnapshot: "[]",
          objectives: "[]",
          questions,
        },
      });
    const legacy = await createVersion("Legacy", new Date("2026-01-01"));
    const next = await createVersion("Next", new Date("2026-01-02"));
    await prisma.quizPracticeAttempt.createMany({
      data: [
        { versionId: legacy.id, versionName: legacy.name },
        { versionId: next.id, versionName: "Next (Coach practice)" },
        { versionId: next.id, versionName: "Next (Study assistant practice)" },
      ].map((attempt) => ({
        ...target,
        ...attempt,
        studentId: student.id,
        questions,
        completedAt: new Date(),
      })),
    });
    const history = await alternativeHistory(
      new NextRequest(
        "http://localhost/api/quiz/practice?" + new URLSearchParams(target),
      ),
    );
    expect(history.status).toBe(200);
    expect((await history.json()).attempts).toMatchObject([
      { versionName: legacy.name, quizAttemptId: null },
    ]);

    const started = await startAlternative(practiceReq(target));
    expect(started.status).toBe(200);
    expect(await started.json()).toMatchObject({ versionName: next.name });
  });

  it("falls back to the full quiz or version if every question would be excluded", async () => {
    const { cls, quiz, question, studentUser, student } = await setup();
    asStudent(studentUser.id);
    const target = { classId: cls.id, quizId: quiz.id };
    await prisma.quizAttempt.create({
      data: {
        ...target,
        studentId: student.id,
        completedAt: new Date(),
        answers: { create: { questionId: question.id, isCorrect: true } },
      },
    });
    await prisma.quizPracticeVersion.create({
      data: {
        quizId: quiz.id,
        name: "Alternative",
        variation: "NUMBERS",
        status: "PUBLISHED",
        sourceSnapshot: "[]",
        objectives: "[]",
        questions: JSON.stringify([
          {
            id: "v",
            sourceQuestionId: question.id,
            text: "Variant",
            answerMode: "NUMERIC",
            answerUnit: null,
            answerNumeric: 4,
            answerTolerance: 0.01,
            options: [],
            solution: "4",
            intentExplanation: "Same skill",
          } satisfies VariantQuestion,
        ]),
      },
    });
    const body = { ...target, excludedQuestionIds: [question.id] };
    const [official, practice] = await Promise.all([
      POST(jsonReq(body)),
      startAlternative(practiceReq(body)),
    ]);
    expect(await official.json()).toMatchObject({
      excludedCount: 0,
      exclusionIgnored: true,
      questions: [{ id: question.id }],
    });
    expect(await practice.json()).toMatchObject({
      excludedCount: 0,
      exclusionIgnored: true,
      questions: [{ id: "v" }],
    });
  });
});
