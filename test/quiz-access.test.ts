import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import {
  ownScope,
  canManage,
  canRead,
  getContentActor,
  deepCopyQuiz,
  type ContentActor,
} from "@/lib/quiz-access";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher } from "./db";

const mockAuth = vi.mocked(auth);

const teacherActor: ContentActor = {
  role: "TEACHER",
  teacherId: "t1",
  userId: "u1",
};
const adminActor: ContentActor = {
  role: "ADMIN",
  teacherId: null,
  userId: "uA",
};

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("ownScope", () => {
  it("is the teacher's id for a teacher", () => {
    expect(ownScope(teacherActor)).toBe("t1");
  });
  it("is null (the pool) for an admin", () => {
    expect(ownScope(adminActor)).toBeNull();
  });
});

describe("canManage", () => {
  it("lets a teacher manage their own content", () => {
    expect(canManage(teacherActor, { teacherId: "t1" })).toBe(true);
  });
  it("forbids a teacher from managing another teacher's or the pool's content", () => {
    expect(canManage(teacherActor, { teacherId: "t2" })).toBe(false);
    expect(canManage(teacherActor, { teacherId: null })).toBe(false);
  });
  it("lets an admin manage pool content only", () => {
    expect(canManage(adminActor, { teacherId: null })).toBe(true);
    expect(canManage(adminActor, { teacherId: "t1" })).toBe(false);
  });
});

describe("canRead", () => {
  it("lets anyone read the pool", () => {
    expect(canRead(teacherActor, { teacherId: null })).toBe(true);
    expect(canRead(adminActor, { teacherId: null })).toBe(true);
  });
  it("lets a teacher read their own content but not another teacher's", () => {
    expect(canRead(teacherActor, { teacherId: "t1" })).toBe(true);
    expect(canRead(teacherActor, { teacherId: "t2" })).toBe(false);
  });
  it("forbids an admin from reading a teacher's private content", () => {
    expect(canRead(adminActor, { teacherId: "t1" })).toBe(false);
  });
});

describe("getContentActor", () => {
  it("returns null when there is no session", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect(await getContentActor()).toBeNull();
  });

  it("returns null for a student", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u", role: "STUDENT" } } as never);
    expect(await getContentActor()).toBeNull();
  });

  it("returns an ADMIN actor scoped to the pool", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN" },
    } as never);
    expect(await getContentActor()).toEqual({
      role: "ADMIN",
      teacherId: null,
      userId: "admin-1",
    });
  });

  it("returns a TEACHER actor carrying their Teacher row id", async () => {
    const { user, teacher } = await createTeacher();
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "TEACHER" },
    } as never);
    expect(await getContentActor()).toEqual({
      role: "TEACHER",
      teacherId: teacher.id,
      userId: user.id,
    });
  });

  it("returns null for a TEACHER user missing their Teacher row", async () => {
    const user = await prisma.user.create({
      data: {
        email: "orphan@example.com",
        username: "orphan",
        hashedPassword: "x",
        firstName: "No",
        lastName: "Teacher",
        role: "TEACHER",
      },
    });
    mockAuth.mockResolvedValue({
      user: { id: user.id, role: "TEACHER" },
    } as never);
    expect(await getContentActor()).toBeNull();
  });
});

describe("deepCopyQuiz", () => {
  async function seedSourceQuiz(teacherId: string | null) {
    const topic = await prisma.topic.create({
      data: { name: "Forces", order: 2, teacherId },
    });
    const quiz = await prisma.quiz.create({
      data: { name: "Quiz A", order: 5, topicId: topic.id, teacherId },
    });
    await prisma.question.create({
      data: {
        text: "What is 2 + 2?",
        quizId: quiz.id,
        answerMode: "SINGLE_SELECT",
        answerNumeric: 4,
        answerTolerance: 0.1,
        answerUnit: "units",
        figureStorageKey: "figs/q1.png",
        figureBucket: "bucket-x",
        figureAlt: "a diagram",
        options: {
          create: [
            { text: "3", isCorrect: false },
            { text: "4", isCorrect: true },
          ],
        },
      },
    });
    return { topic, quiz };
  }

  it("returns null when the source quiz does not exist", async () => {
    expect(await deepCopyQuiz("missing", null)).toBeNull();
  });

  it("copies a quiz, its questions and options into the target scope", async () => {
    const { teacher } = await createTeacher();
    const { quiz: source } = await seedSourceQuiz(teacher.id);

    // Teacher quiz promoted into the pool (target scope = null).
    const copy = await deepCopyQuiz(source.id, null);
    expect(copy).not.toBeNull();
    expect(copy!.id).not.toBe(source.id);
    expect(copy!.teacherId).toBeNull();
    expect(copy!.sourceQuizId).toBe(source.id);
    expect(copy!.name).toBe("Quiz A");
    expect(copy!._count.questions).toBe(1);

    const copiedQuestion = await prisma.question.findFirstOrThrow({
      where: { quizId: copy!.id },
      include: { options: true },
    });
    // Numeric grading data and figure references carry over.
    expect(copiedQuestion.answerNumeric).toBe(4);
    expect(copiedQuestion.answerTolerance).toBeCloseTo(0.1);
    expect(copiedQuestion.answerUnit).toBe("units");
    expect(copiedQuestion.figureStorageKey).toBe("figs/q1.png");
    expect(copiedQuestion.figureBucket).toBe("bucket-x");
    expect(copiedQuestion.options).toHaveLength(2);
    expect(copiedQuestion.options.find((o) => o.text === "4")!.isCorrect).toBe(
      true,
    );
  });

  it("creates the topic in the target scope rather than sharing the source topic row", async () => {
    const { teacher } = await createTeacher();
    const { topic: sourceTopic, quiz: source } = await seedSourceQuiz(null);

    const copy = await deepCopyQuiz(source.id, teacher.id);
    expect(copy!.topic).not.toBeNull();
    expect(copy!.topic!.id).not.toBe(sourceTopic.id);
    expect(copy!.topic!.name).toBe("Forces");
    expect(copy!.topic!.teacherId).toBe(teacher.id);
  });

  it("reuses an existing same-named topic in the target scope", async () => {
    const { teacher } = await createTeacher();
    const existing = await prisma.topic.create({
      data: { name: "Forces", teacherId: teacher.id },
    });
    const { quiz: source } = await seedSourceQuiz(null);

    const copy = await deepCopyQuiz(source.id, teacher.id);
    expect(copy!.topic!.id).toBe(existing.id);
    const topicCount = await prisma.topic.count({
      where: { name: "Forces", teacherId: teacher.id },
    });
    expect(topicCount).toBe(1);
  });

  it("carries complete simulation generation metrics into a teacher copy", async () => {
    const { quiz: source } = await seedSourceQuiz(null);
    const sourceQuestion = await prisma.question.findFirstOrThrow({
      where: { quizId: source.id },
    });
    await prisma.questionSimulation.create({
      data: {
        questionId: sourceQuestion.id,
        status: "READY",
        title: "Force Lab",
        storageKey: "simulations/pool/source/q/v1.html",
        version: 1,
        aiModel: "openai/gpt-5.5",
        aiTtftMs: 43_787,
        aiGenerationMs: 45_465,
        aiTotalMs: 89_252,
        aiTokens: 2_776,
        aiTokensEstimated: false,
      },
    });
    const { teacher } = await createTeacher();

    const copy = await deepCopyQuiz(source.id, teacher.id);
    const copiedQuestion = await prisma.question.findFirstOrThrow({
      where: { quizId: copy!.id },
      include: { simulation: true },
    });

    expect(copiedQuestion.simulation).toMatchObject({
      status: "READY",
      aiModel: "openai/gpt-5.5",
      aiTtftMs: 43_787,
      aiGenerationMs: 45_465,
      aiTotalMs: 89_252,
      aiTokens: 2_776,
      aiTokensEstimated: false,
    });
  });

  it("produces an independent copy — deleting the source leaves the copy intact", async () => {
    const { quiz: source } = await seedSourceQuiz(null);
    const { teacher } = await createTeacher();
    const copy = await deepCopyQuiz(source.id, teacher.id);

    await prisma.quiz.delete({ where: { id: source.id } });

    const stillThere = await prisma.quiz.findUnique({
      where: { id: copy!.id },
    });
    expect(stillThere).not.toBeNull();
    const questions = await prisma.question.count({
      where: { quizId: copy!.id },
    });
    expect(questions).toBe(1);
  });
});
