import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueExamResult: vi.fn() }));

import { POST, PATCH } from "@/app/api/quiz/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher, createStudent, createClass, createPublishedQuiz } from "./db";

const mockAuth = vi.mocked(auth);

function jsonReq(body: unknown) {
  return new Request("http://localhost/api/quiz", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function asStudent(userId: string) {
  mockAuth.mockResolvedValue({ user: { id: userId, role: "STUDENT" } } as never);
}

async function setup(opts: { published?: boolean; answerMode?: "SINGLE_SELECT" | "MULTI_SELECT" } = {}) {
  const { teacher } = await createTeacher();
  const cls = await createClass(teacher.id);
  const { user: studentUser, student } = await createStudent();
  await prisma.classEnrollment.create({ data: { classId: cls.id, studentId: student.id } });
  const mod = await createPublishedQuiz({
    classId: cls.id,
    teacherId: teacher.id,
    answerMode: opts.answerMode ?? "SINGLE_SELECT",
    published: opts.published ?? true,
  });
  const optionId = (text: string) => mod.question.options.find((o) => o.text === text)!.id;
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

  it("starts an attempt and returns questions without leaking isCorrect", async () => {
    const { studentUser, cls, quiz } = await setup();
    asStudent(studentUser.id);
    const res = await POST(jsonReq({ classId: cls.id, quizId: quiz.id }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attemptId).toBeTruthy();
    expect(body.questions).toHaveLength(1);
    // Options must expose only id + text, never the correct flag.
    expect(body.questions[0].options[0]).not.toHaveProperty("isCorrect");

    // Progress is marked IN_PROGRESS.
    const progress = await prisma.quizProgress.findFirst({ where: { quizId: quiz.id } });
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
      data: { availableFrom: new Date(Date.now() - HOUR), availableUntil: new Date(Date.now() + HOUR) },
    });
    asStudent(studentUser.id);
    const res = await POST(jsonReq({ classId: cls.id, quizId: quiz.id }));
    expect(res.status).toBe(200);
  });

  it("rejects with 403 once maxAttempts attempt slots have been allocated", async () => {
    const { studentUser, student, cls, quiz } = await setup();
    await prisma.classQuiz.updateMany({
      where: { classId: cls.id, quizId: quiz.id },
      data: { maxAttempts: 1 },
    });
    // One completed attempt already exists.
    await prisma.quizAttempt.create({
      data: { studentId: student.id, classId: cls.id, quizId: quiz.id, completedAt: new Date(), score: 50 },
    });
    asStudent(studentUser.id);
    const res = await POST(jsonReq({ classId: cls.id, quizId: quiz.id }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/all 1 attempts/i);
  });

  it("counts incomplete attempts so slots cannot be stockpiled before grading", async () => {
    const { studentUser, student, cls, quiz } = await setup();
    await prisma.classQuiz.updateMany({
      where: { classId: cls.id, quizId: quiz.id },
      data: { maxAttempts: 1 },
    });
    // A pending attempt consumes the slot; otherwise a student can pre-create
    // many IDs, then submit them sequentially after seeing correctness feedback.
    await prisma.quizAttempt.create({
      data: { studentId: student.id, classId: cls.id, quizId: quiz.id },
    });
    asStudent(studentUser.id);
    const res = await POST(jsonReq({ classId: cls.id, quizId: quiz.id }));
    expect(res.status).toBe(403);
  });
});

describe("PATCH /api/quiz (submit answers)", () => {
  async function startAttempt(studentId: string, classId: string, quizId: string) {
    return prisma.quizAttempt.create({ data: { studentId, classId, quizId } });
  }

  it("scores a correct single-select answer as 100 and persists a JSON-string selection", async () => {
    const s = await setup({ answerMode: "SINGLE_SELECT" });
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);

    const res = await PATCH(
      jsonReq({ attemptId: attempt.id, answers: [{ questionId: s.question.id, selectedOptionId: s.optionId("4") }] })
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
    const saved = await prisma.quizAnswer.findFirst({ where: { quizAttemptId: attempt.id } });
    expect(typeof saved?.selectedOptionIds).toBe("string");
    expect(JSON.parse(saved!.selectedOptionIds)).toEqual([s.optionId("4")]);
    expect(saved?.isCorrect).toBe(true);

    // Attempt + progress updated.
    const updated = await prisma.quizAttempt.findUnique({ where: { id: attempt.id } });
    expect(updated?.score).toBe(100);
    expect(updated?.completedAt).not.toBeNull();
    const progress = await prisma.quizProgress.findFirst({ where: { quizId: s.quiz.id } });
    expect(progress?.status).toBe("COMPLETED");
    expect(progress?.bestScore).toBe(100);
  });

  it("scores a wrong single-select answer as 0", async () => {
    const s = await setup({ answerMode: "SINGLE_SELECT" });
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);
    const res = await PATCH(
      jsonReq({ attemptId: attempt.id, answers: [{ questionId: s.question.id, selectedOptionId: s.optionId("3") }] })
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
      jsonReq({ attemptId: a1.id, answers: [{ questionId: s.question.id, selectedOptionIds: [s.optionId("4"), s.optionId("5")] }] })
    );
    expect(await exact.json()).toMatchObject({
      score: 100,
      incorrectQuestionIds: [],
    });

    // Partial set -> wrong.
    const a2 = await startAttempt(s.student.id, s.cls.id, s.quiz.id);
    const partial = await PATCH(
      jsonReq({ attemptId: a2.id, answers: [{ questionId: s.question.id, selectedOptionIds: [s.optionId("4")] }] })
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
      })
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
    await PATCH(jsonReq({ attemptId: good.id, answers: [{ questionId: s.question.id, selectedOptionId: s.optionId("4") }] }));

    const bad = await startAttempt(s.student.id, s.cls.id, s.quiz.id);
    await PATCH(jsonReq({ attemptId: bad.id, answers: [{ questionId: s.question.id, selectedOptionId: s.optionId("3") }] }));

    const progress = await prisma.quizProgress.findFirst({ where: { quizId: s.quiz.id } });
    expect(progress?.bestScore).toBe(100); // not overwritten by the later 0
  });

  it("rejects submitting to another student's attempt with 404", async () => {
    const s = await setup();
    const other = await createStudent();
    const attempt = await startAttempt(other.student.id, s.cls.id, s.quiz.id);
    asStudent(s.studentUser.id);
    const res = await PATCH(jsonReq({ attemptId: attempt.id, answers: [{ questionId: s.question.id, selectedOptionId: s.optionId("4") }] }));
    expect(res.status).toBe(404);
  });

  it("returns 404 when an answer references an unknown question", async () => {
    const s = await setup();
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);
    const res = await PATCH(jsonReq({ attemptId: attempt.id, answers: [{ questionId: "ghost", selectedOptionId: "x" }] }));
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
      jsonReq({ attemptId: attempt.id, answers: [{ questionId: s.question.id, selectedOptionId: s.optionId("3") }] })
    );
    expect((await first.json()).score).toBe(0);

    // Replaying the same attempt is what turned the response's
    // incorrectQuestionIds into an answer-key oracle, and it sidestepped the
    // per-class maxAttempts cap (which only counts completed attempts).
    const replay = await PATCH(
      jsonReq({ attemptId: attempt.id, answers: [{ questionId: s.question.id, selectedOptionId: s.optionId("4") }] })
    );
    expect(replay.status).toBe(409);

    const stored = await prisma.quizAttempt.findUnique({ where: { id: attempt.id } });
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
          answers: [{ questionId: s.question.id, selectedOptionId: s.optionId("3") }],
        })
      ),
      PATCH(
        jsonReq({
          attemptId: attempt.id,
          answers: [{ questionId: s.question.id, selectedOptionId: s.optionId("4") }],
        })
      ),
    ]);

    expect([one.status, two.status].sort()).toEqual([200, 409]);
    expect(await prisma.quizAnswer.count({ where: { quizAttemptId: attempt.id } })).toBe(1);
    expect(
      await prisma.examResult.count({ where: { quizAttemptId: attempt.id } })
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
        options: { create: [{ text: "6", isCorrect: true }, { text: "7", isCorrect: false }] },
      },
    });
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);

    const res = await PATCH(
      jsonReq({ attemptId: attempt.id, answers: [{ questionId: s.question.id, selectedOptionId: s.optionId("4") }] })
    );
    // 1 of the quiz's 2 questions correct. Deriving the denominator from the
    // client's array would have scored this 100.
    const body = await res.json();
    expect(body.score).toBe(50);
    expect(body.incorrectQuestionIds).toContain(unanswered.id);
    expect(await prisma.quizAnswer.count({ where: { quizAttemptId: attempt.id } })).toBe(2);
  });

  it("rejects an answer for a question belonging to another quiz", async () => {
    const s = await setup();
    const other = await createPublishedQuiz({ classId: s.cls.id, teacherId: s.teacher.id });
    asStudent(s.studentUser.id);
    const attempt = await startAttempt(s.student.id, s.cls.id, s.quiz.id);

    const res = await PATCH(
      jsonReq({
        attemptId: attempt.id,
        answers: [{ questionId: other.question.id, selectedOptionId: other.question.options.find((o) => o.isCorrect)!.id }],
      })
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
      })
    );
    expect(res.status).toBe(400);
  });
});
