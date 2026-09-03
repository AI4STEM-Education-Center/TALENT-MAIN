import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as LIST, POST } from "@/app/api/quizzes/route";
import { GET as DETAIL, PATCH, DELETE } from "@/app/api/quizzes/[id]/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher, createStudent, createClass } from "./db";

const mockAuth = vi.mocked(auth);

function jsonReq(body: unknown) {
  return new Request("http://localhost/api/quizzes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function asTeacher(userId: string) {
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "TEACHER" },
  } as never);
}
function asAdmin(userId = "admin-1") {
  mockAuth.mockResolvedValue({ user: { id: userId, role: "ADMIN" } } as never);
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/quizzes (list)", () => {
  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await LIST()).status).toBe(401);
  });

  it("lists the teacher's own quizzes only", async () => {
    const { user, teacher } = await createTeacher();
    const other = await createTeacher();
    await prisma.quiz.create({ data: { name: "Mine", teacherId: teacher.id } });
    await prisma.quiz.create({
      data: { name: "Theirs", teacherId: other.teacher.id },
    });
    await prisma.quiz.create({ data: { name: "Pool", teacherId: null } });

    asTeacher(user.id);
    const body = await (await LIST()).json();
    expect(body.map((q: { name: string }) => q.name)).toEqual(["Mine"]);
  });

  it("lists the global pool for an admin", async () => {
    const { teacher } = await createTeacher();
    await prisma.quiz.create({ data: { name: "Pool", teacherId: null } });
    await prisma.quiz.create({
      data: { name: "Private", teacherId: teacher.id },
    });

    asAdmin();
    const body = await (await LIST()).json();
    expect(body.map((q: { name: string }) => q.name)).toEqual(["Pool"]);
  });
});

describe("POST /api/quizzes (create)", () => {
  it("requires a name", async () => {
    const { user } = await createTeacher();
    asTeacher(user.id);
    expect((await POST(jsonReq({ name: "" }))).status).toBe(400);
  });

  it("creates a quiz in the teacher's scope", async () => {
    const { user, teacher } = await createTeacher();
    asTeacher(user.id);
    const res = await POST(jsonReq({ name: " Quiz One " }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Quiz One");
    expect(body.teacherId).toBe(teacher.id);
  });

  it("rejects a topicId owned by another scope", async () => {
    const owner = await createTeacher();
    const topic = await prisma.topic.create({
      data: { name: "Other's", teacherId: owner.teacher.id },
    });
    const { user } = await createTeacher();
    asTeacher(user.id);
    expect((await POST(jsonReq({ name: "Q", topicId: topic.id }))).status).toBe(
      400,
    );
  });

  it("creates a quiz grouped under an owned topic", async () => {
    const { user, teacher } = await createTeacher();
    const topic = await prisma.topic.create({
      data: { name: "Mine", teacherId: teacher.id },
    });
    asTeacher(user.id);
    const body = await (
      await POST(jsonReq({ name: "Q", topicId: topic.id }))
    ).json();
    expect(body.topicId).toBe(topic.id);
    expect(body.topic.name).toBe("Mine");
  });

  it("409s with dedupeByName when a same-named quiz exists under the topic (case/space-insensitive)", async () => {
    const topic = await prisma.topic.create({
      data: { name: "T", teacherId: null },
    });
    const existing = await prisma.quiz.create({
      data: { name: "Chapter 1", topicId: topic.id, teacherId: null },
    });
    asAdmin();
    const res = await POST(
      jsonReq({ name: "  chapter 1 ", topicId: topic.id, dedupeByName: true }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.duplicate).toBe(true);
    expect(body.existingQuizId).toBe(existing.id);
  });

  it("dedupeByName only matches within the same topic and scope", async () => {
    const topicA = await prisma.topic.create({
      data: { name: "A", teacherId: null },
    });
    const topicB = await prisma.topic.create({
      data: { name: "B", teacherId: null },
    });
    await prisma.quiz.create({
      data: { name: "Chapter 1", topicId: topicA.id, teacherId: null },
    });
    const { teacher } = await createTeacher();
    // Same name under a teacher's scope must not block the admin pool either.
    await prisma.quiz.create({
      data: { name: "Chapter 1", teacherId: teacher.id },
    });

    asAdmin();
    const res = await POST(
      jsonReq({ name: "Chapter 1", topicId: topicB.id, dedupeByName: true }),
    );
    expect(res.status).toBe(201);
  });

  it("allows duplicate names without the dedupeByName flag (existing behavior)", async () => {
    const topic = await prisma.topic.create({
      data: { name: "T", teacherId: null },
    });
    await prisma.quiz.create({
      data: { name: "Chapter 1", topicId: topic.id, teacherId: null },
    });
    asAdmin();
    expect(
      (await POST(jsonReq({ name: "Chapter 1", topicId: topic.id }))).status,
    ).toBe(201);
  });
});

describe("GET /api/quizzes/[id] (detail)", () => {
  it("404s a quiz the teacher cannot read", async () => {
    const owner = await createTeacher();
    const quiz = await prisma.quiz.create({
      data: { name: "Secret", teacherId: owner.teacher.id },
    });
    const intruder = await createTeacher();
    asTeacher(intruder.user.id);
    expect((await DETAIL({} as never, params(quiz.id))).status).toBe(404);
  });

  it("returns an owned quiz with questions and editable=true, no figure keys leaked", async () => {
    const { user, teacher } = await createTeacher();
    const quiz = await prisma.quiz.create({
      data: { name: "Q", teacherId: teacher.id },
    });
    await prisma.question.create({
      data: {
        text: "hi",
        quizId: quiz.id,
        figureStorageKey: null,
        figureBucket: null,
      },
    });
    asTeacher(user.id);
    const res = await DETAIL({} as never, params(quiz.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.editable).toBe(true);
    expect(body.questions).toHaveLength(1);
    expect(body.questions[0]).not.toHaveProperty("figureStorageKey");
    expect(body.questions[0]).toHaveProperty("figureUrl", null);
  });

  it("lets a teacher preview a pool quiz with editable=false", async () => {
    const pool = await prisma.quiz.create({
      data: { name: "Pool", teacherId: null },
    });
    const { user } = await createTeacher();
    asTeacher(user.id);
    const body = await (await DETAIL({} as never, params(pool.id))).json();
    expect(body.editable).toBe(false);
  });
});

describe("PATCH /api/quizzes/[id]", () => {
  it("404s when patching a quiz the teacher does not own", async () => {
    const pool = await prisma.quiz.create({
      data: { name: "Pool", teacherId: null },
    });
    const { user } = await createTeacher();
    asTeacher(user.id);
    const res = await PATCH(jsonReq({ name: "x" }), params(pool.id));
    expect(res.status).toBe(404);
  });

  it("renames an owned quiz and can ungroup it from a topic", async () => {
    const { user, teacher } = await createTeacher();
    const topic = await prisma.topic.create({
      data: { name: "T", teacherId: teacher.id },
    });
    const quiz = await prisma.quiz.create({
      data: { name: "Old", topicId: topic.id, teacherId: teacher.id },
    });
    asTeacher(user.id);
    const body = await (
      await PATCH(jsonReq({ name: "New", topicId: "" }), params(quiz.id))
    ).json();
    expect(body.name).toBe("New");
    expect(body.topicId).toBeNull();
  });

  it("does not let an admin edit a teacher quiz", async () => {
    const { teacher } = await createTeacher();
    const quiz = await prisma.quiz.create({
      data: { name: "Teacher Quiz", teacherId: teacher.id },
    });
    asAdmin();
    expect(
      (await PATCH(jsonReq({ name: "Admin Rename" }), params(quiz.id))).status,
    ).toBe(404);
    expect(
      await prisma.quiz.findUnique({ where: { id: quiz.id } }),
    ).toMatchObject({
      name: "Teacher Quiz",
    });
  });
});

describe("DELETE /api/quizzes/[id]", () => {
  it("404s a quiz the teacher does not own", async () => {
    const pool = await prisma.quiz.create({
      data: { name: "Pool", teacherId: null },
    });
    const { user } = await createTeacher();
    asTeacher(user.id);
    expect((await DELETE({} as never, params(pool.id))).status).toBe(404);
  });

  it("deletes an owned quiz", async () => {
    const { user, teacher } = await createTeacher();
    const quiz = await prisma.quiz.create({
      data: { name: "Q", teacherId: teacher.id },
    });
    asTeacher(user.id);
    expect((await DELETE({} as never, params(quiz.id))).status).toBe(200);
    expect(await prisma.quiz.findUnique({ where: { id: quiz.id } })).toBeNull();
  });

  it("lets an admin delete a teacher quiz while preserving history and an independent pool copy", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { student } = await createStudent();
    const quiz = await prisma.quiz.create({
      data: { name: "Teacher Quiz", teacherId: teacher.id },
    });
    const question = await prisma.question.create({
      data: { text: "Q", quizId: quiz.id },
    });
    await prisma.classQuiz.create({
      data: { classId: cls.id, quizId: quiz.id },
    });
    const attempt = await prisma.quizAttempt.create({
      data: {
        studentId: student.id,
        classId: cls.id,
        quizId: quiz.id,
        completedAt: new Date(),
        score: 80,
      },
    });
    const poolCopy = await prisma.quiz.create({
      data: { name: "Teacher Quiz", teacherId: null, sourceQuizId: quiz.id },
    });

    asAdmin();
    expect((await DELETE({} as never, params(quiz.id))).status).toBe(200);

    expect(await prisma.quiz.findUnique({ where: { id: quiz.id } })).toBeNull();
    expect(
      await prisma.question.findUnique({ where: { id: question.id } }),
    ).toBeNull();
    expect(await prisma.classQuiz.count({ where: { quizId: quiz.id } })).toBe(
      0,
    );
    expect(
      await prisma.quiz.findUnique({ where: { id: poolCopy.id } }),
    ).not.toBeNull();
    expect(
      await prisma.quizAttempt.findUnique({ where: { id: attempt.id } }),
    ).toMatchObject({
      quizId: null,
      score: 80,
    });
  });
});
