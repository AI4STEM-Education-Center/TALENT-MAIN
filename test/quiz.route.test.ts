import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

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

  it("rejects with 403 once maxAttempts completed attempts have been used", async () => {
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

  it("does not count incomplete attempts toward the cap", async () => {
    const { studentUser, student, cls, quiz } = await setup();
    await prisma.classQuiz.updateMany({
      where: { classId: cls.id, quizId: quiz.id },
      data: { maxAttempts: 1 },
    });
    // An in-progress (not completed) attempt must not block a new one.
    await prisma.quizAttempt.create({
      data: { studentId: student.id, classId: cls.id, quizId: quiz.id },
    });
    asStudent(studentUser.id);
    const res = await POST(jsonReq({ classId: cls.id, quizId: quiz.id }));
    expect(res.status).toBe(200);
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
    // Blind results: the submit response must never leak grading data.
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
  });

  it("requires the exact correct set for multi-select", async () => {
    const s = await setup({ answerMode: "MULTI_SELECT" });
    asStudent(s.studentUser.id);

    // Exact set -> correct.
    const a1 = await startAttempt(s.student.id, s.cls.id, s.quiz.id);
    const exact = await PATCH(
      jsonReq({ attemptId: a1.id, answers: [{ questionId: s.question.id, selectedOptionIds: [s.optionId("4"), s.optionId("5")] }] })
    );
    expect((await exact.json()).score).toBe(100);

    // Partial set -> wrong.
    const a2 = await startAttempt(s.student.id, s.cls.id, s.quiz.id);
    const partial = await PATCH(
      jsonReq({ attemptId: a2.id, answers: [{ questionId: s.question.id, selectedOptionIds: [s.optionId("4")] }] })
    );
    expect((await partial.json()).score).toBe(0);
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
