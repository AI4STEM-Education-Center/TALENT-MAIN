import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { PUT as REORDER } from "@/app/api/quizzes/[id]/question-order/route";
import { POST as DUPLICATE } from "@/app/api/quizzes/[id]/duplicate/route";
import { GET as QUIZ_DETAIL } from "@/app/api/quizzes/[id]/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { QUESTION_ORDER, nextQuestionOrder } from "@/lib/question-order";
import { resetDb, createTeacher } from "./db";

const mockAuth = vi.mocked(auth);
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const reorderRequest = (questionIds: string[]) =>
  new Request("http://localhost/api/quizzes/x/question-order", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ questionIds }),
  }) as never;

function asTeacher(userId: string) {
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "TEACHER" },
  } as never);
}
function asAdmin() {
  mockAuth.mockResolvedValue({
    user: { id: "admin-1", role: "ADMIN" },
  } as never);
}

async function quizWithQuestions(teacherId: string | null, texts: string[]) {
  const quiz = await prisma.quiz.create({
    data: { name: "Bank", teacherId },
  });
  const ids: string[] = [];
  for (const text of texts) {
    const q = await prisma.question.create({
      data: {
        quizId: quiz.id,
        text,
        options: {
          create: [
            { text: "Right", isCorrect: true },
            { text: "Wrong", isCorrect: false },
          ],
        },
      },
    });
    ids.push(q.id);
  }
  return { quiz, ids };
}

async function orderedTexts(quizId: string) {
  const rows = await prisma.question.findMany({
    where: { quizId },
    orderBy: QUESTION_ORDER,
    select: { text: true },
  });
  return rows.map((r) => r.text);
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("PUT /api/quizzes/[id]/question-order", () => {
  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await REORDER(reorderRequest([]), params("nope"));
    expect(res.status).toBe(401);
  });

  it("reorders the owner's questions and the quiz detail follows", async () => {
    const { user, teacher } = await createTeacher();
    const { quiz, ids } = await quizWithQuestions(teacher.id, ["A", "B", "C"]);
    asTeacher(user.id);

    const res = await REORDER(
      reorderRequest([ids[2], ids[0], ids[1]]),
      params(quiz.id),
    );
    expect(res.status).toBe(200);
    expect(await orderedTexts(quiz.id)).toEqual(["C", "A", "B"]);

    const detail = await (
      await QUIZ_DETAIL(
        new Request("http://localhost") as never,
        params(quiz.id),
      )
    ).json();
    expect(detail.questions.map((q: { text: string }) => q.text)).toEqual([
      "C",
      "A",
      "B",
    ]);
  });

  it("404s another teacher's quiz and a pool quiz", async () => {
    const owner = await createTeacher();
    const other = await createTeacher();
    const own = await quizWithQuestions(owner.teacher.id, ["A", "B"]);
    const pool = await quizWithQuestions(null, ["A", "B"]);
    asTeacher(other.user.id);

    for (const { quiz, ids } of [own, pool]) {
      const res = await REORDER(reorderRequest(ids.reverse()), params(quiz.id));
      expect(res.status).toBe(404);
    }
    expect(await orderedTexts(own.quiz.id)).toEqual(["A", "B"]);
  });

  it("409s a partial, duplicated or foreign id list", async () => {
    const { user, teacher } = await createTeacher();
    const { quiz, ids } = await quizWithQuestions(teacher.id, ["A", "B", "C"]);
    const elsewhere = await quizWithQuestions(teacher.id, ["X"]);
    asTeacher(user.id);

    for (const list of [
      [ids[1], ids[0]],
      [ids[1], ids[1], ids[0]],
      [ids[1], ids[0], elsewhere.ids[0]],
    ]) {
      const res = await REORDER(reorderRequest(list), params(quiz.id));
      expect(res.status).toBe(409);
    }
    expect(await orderedTexts(quiz.id)).toEqual(["A", "B", "C"]);
  });

  it("appends newly created questions after a reordered list", async () => {
    const { user, teacher } = await createTeacher();
    const { quiz, ids } = await quizWithQuestions(teacher.id, ["A", "B"]);
    asTeacher(user.id);
    await REORDER(reorderRequest([ids[1], ids[0]]), params(quiz.id));

    await prisma.question.create({
      data: {
        quizId: quiz.id,
        text: "New",
        order: await nextQuestionOrder(prisma, quiz.id),
      },
    });
    expect(await orderedTexts(quiz.id)).toEqual(["B", "A", "New"]);
  });
});

describe("POST /api/quizzes/[id]/duplicate", () => {
  it("copies a teacher's quiz, in its current order, into their own scope", async () => {
    const { user, teacher } = await createTeacher();
    const topic = await prisma.topic.create({
      data: { name: "Kinematics", teacherId: teacher.id, contentType: "QUIZ" },
    });
    const { quiz, ids } = await quizWithQuestions(teacher.id, ["A", "B", "C"]);
    await prisma.quiz.update({
      where: { id: quiz.id },
      data: { topicId: topic.id },
    });
    asTeacher(user.id);
    await REORDER(reorderRequest([ids[2], ids[0], ids[1]]), params(quiz.id));

    const res = await DUPLICATE(
      new Request("http://localhost") as never,
      params(quiz.id),
    );
    expect(res.status).toBe(201);
    const copy = await res.json();
    expect(copy.id).not.toBe(quiz.id);
    expect(copy.name).toBe("Bank (copy)");
    expect(copy.teacherId).toBe(teacher.id);
    expect(copy.topicId).toBe(topic.id);
    expect(copy._count.questions).toBe(3);
    expect(await orderedTexts(copy.id)).toEqual(["C", "A", "B"]);

    // Independent: reordering the copy leaves the source alone.
    const copyIds = (
      await prisma.question.findMany({
        where: { quizId: copy.id },
        orderBy: QUESTION_ORDER,
      })
    ).map((q) => q.id);
    await REORDER(reorderRequest([...copyIds].reverse()), params(copy.id));
    expect(await orderedTexts(copy.id)).toEqual(["B", "A", "C"]);
    expect(await orderedTexts(quiz.id)).toEqual(["C", "A", "B"]);
    // No new topic was minted for the copy.
    expect(await prisma.topic.count({ where: { teacherId: teacher.id } })).toBe(
      1,
    );
  });

  it("404s a quiz the caller doesn't manage (incl. pool quizzes for teachers)", async () => {
    const owner = await createTeacher();
    const other = await createTeacher();
    const own = await quizWithQuestions(owner.teacher.id, ["A"]);
    const pool = await quizWithQuestions(null, ["A"]);
    asTeacher(other.user.id);

    for (const { quiz } of [own, pool]) {
      const res = await DUPLICATE(
        new Request("http://localhost") as never,
        params(quiz.id),
      );
      expect(res.status).toBe(404);
    }
    expect(await prisma.quiz.count()).toBe(2);
  });

  it("lets an admin duplicate a pool quiz within the pool", async () => {
    const pool = await quizWithQuestions(null, ["A", "B"]);
    asAdmin();
    const res = await DUPLICATE(
      new Request("http://localhost") as never,
      params(pool.quiz.id),
    );
    expect(res.status).toBe(201);
    const copy = await res.json();
    expect(copy.teacherId).toBeNull();
    expect(await orderedTexts(copy.id)).toEqual(["A", "B"]);
  });
});
