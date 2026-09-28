import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { GET, PUT } from "@/app/api/classes/[id]/modules/route";
import { DELETE as removeAssignment } from "@/app/api/classes/[id]/quizzes/route";
import {
  resetDb,
  createTeacher,
  createStudent,
  createClass,
  createPublishedQuiz,
} from "./db";
import type { ModuleLayout } from "@/lib/class-modules";
const mockAuth = vi.mocked(auth);
const request = (body?: unknown) =>
  new Request("http://localhost/api/classes/x/modules", {
    method: body === undefined ? "GET" : "PUT",
    ...(body === undefined
      ? {}
      : {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        }),
  }) as never;
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const module = (id: string, quizIds: string[]) => ({
  id,
  name: id,
  description: "Preparation",
  quizIds,
});
async function fixture() {
  const { user, teacher } = await createTeacher();
  const cls = await createClass(teacher.id);
  const { quiz } = await createPublishedQuiz({
    classId: cls.id,
    teacherId: teacher.id,
  });
  mockAuth.mockResolvedValue({
    user: { id: user.id, role: "TEACHER" },
  } as never);
  return { user, teacher, cls, quiz };
}
beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("Class quiz modules", () => {
  it("denies anonymous and student reads and writes", async () => {
    const { cls } = await fixture();
    for (const session of [
      null,
      { user: { id: "student", role: "STUDENT" } },
    ]) {
      mockAuth.mockResolvedValue(session as never);
      expect((await GET(request(), context(cls.id))).status).toBe(401);
      expect(
        (await PUT(request({ revision: 0, modules: [] }), context(cls.id)))
          .status,
      ).toBe(401);
    }
  });
  it("hides other teachers' classes", async () => {
    const { cls } = await fixture();
    const other = await createTeacher();
    mockAuth.mockResolvedValue({
      user: { id: other.user.id, role: "TEACHER" },
    } as never);
    expect((await GET(request(), context(cls.id))).status).toBe(404);
    expect(
      (await PUT(request({ revision: 0, modules: [] }), context(cls.id)))
        .status,
    ).toBe(404);
  });
  it("starts empty and persists ordered modules, descriptions and shared membership", async () => {
    const { cls, quiz, teacher } = await fixture();
    expect(await (await GET(request(), context(cls.id))).json()).toEqual({
      revision: 0,
      modules: [],
    });
    const second = await prisma.quiz.create({
      data: { name: "Earlier quiz", teacherId: teacher.id },
    });
    const modules = [
      module("final", [second.id, quiz.id]),
      module("midterm", [quiz.id]),
    ];
    expect(
      (await PUT(request({ revision: 0, modules }), context(cls.id))).status,
    ).toBe(200);
    expect(await (await GET(request(), context(cls.id))).json()).toEqual({
      revision: 1,
      modules,
    });
    expect(
      await prisma.classQuiz.count({
        where: { classId: cls.id, quizId: quiz.id },
      }),
    ).toBe(1);
    expect(
      await prisma.classQuiz.findUnique({
        where: { classId_quizId: { classId: cls.id, quizId: second.id } },
      }),
    ).toMatchObject({ published: false });
  });
  it("moving, deleting and undoing organization preserves questions, settings and student history", async () => {
    const { cls, quiz } = await fixture();
    const { student } = await createStudent();
    const settings = {
      published: true,
      maxAttempts: 2,
      availableUntil: new Date("2026-06-01T00:00:00Z"),
    };
    await prisma.classQuiz.update({
      where: { classId_quizId: { classId: cls.id, quizId: quiz.id } },
      data: settings,
    });
    const progress = await prisma.quizProgress.create({
      data: {
        classId: cls.id,
        quizId: quiz.id,
        studentId: student.id,
        status: "COMPLETED",
        bestScore: 90,
      },
    });
    const attempt = await prisma.quizAttempt.create({
      data: {
        classId: cls.id,
        quizId: quiz.id,
        studentId: student.id,
        completedAt: new Date(),
        score: 90,
      },
    });
    const layouts = [
      [module("midterm", [quiz.id])],
      [module("final", [quiz.id])],
      [],
      [module("midterm", [quiz.id])],
    ];
    for (const [revision, modules] of layouts.entries())
      expect(
        (await PUT(request({ revision, modules }), context(cls.id))).status,
      ).toBe(200);
    expect(
      await prisma.classQuiz.findUnique({
        where: { classId_quizId: { classId: cls.id, quizId: quiz.id } },
      }),
    ).toMatchObject(settings);
    expect(
      await prisma.quizProgress.findUnique({ where: { id: progress.id } }),
    ).toEqual(progress);
    expect(
      await prisma.quizAttempt.findUnique({ where: { id: attempt.id } }),
    ).toEqual(attempt);
    expect(await prisma.question.count({ where: { quizId: quiz.id } })).toBe(1);
  });
  it("rejects stale saves without losing the newer layout", async () => {
    const { cls, quiz } = await fixture();
    const modules = [module("midterm", [quiz.id])];
    await PUT(request({ revision: 0, modules }), context(cls.id));
    expect(
      (await PUT(request({ revision: 0, modules: [] }), context(cls.id)))
        .status,
    ).toBe(409);
    expect(await (await GET(request(), context(cls.id))).json()).toEqual({
      revision: 1,
      modules,
    });
  });
  it("rejects missing or foreign quizzes atomically", async () => {
    const { cls, quiz } = await fixture();
    const other = await createTeacher();
    const foreign = await prisma.quiz.create({
      data: { name: "Private", teacherId: other.teacher.id },
    });
    for (const quizId of ["missing", foreign.id]) {
      expect(
        (
          await PUT(
            request({
              revision: 0,
              modules: [module("bad", [quiz.id, quizId])],
            }),
            context(cls.id),
          )
        ).status,
      ).toBe(400);
      expect(await (await GET(request(), context(cls.id))).json()).toEqual({
        revision: 0,
        modules: [],
      });
    }
  });
  it("rejects borrowing a module ID from another class", async () => {
    const { cls, teacher, quiz } = await fixture();
    const otherClass = await createClass(teacher.id);
    await prisma.classModule.create({
      data: {
        id: "taken",
        classId: otherClass.id,
        name: "Private",
        position: 0,
      },
    });
    expect(
      (
        await PUT(
          request({ revision: 0, modules: [module("taken", [quiz.id])] }),
          context(cls.id),
        )
      ).status,
    ).toBe(400);
    expect(
      await prisma.classModule.count({ where: { classId: otherClass.id } }),
    ).toBe(1);
  });
  it("validates names, revisions, duplicates and malformed JSON", async () => {
    const { cls, quiz } = await fixture();
    const good = module("midterm", [quiz.id]);
    for (const body of [
      null,
      { revision: -1, modules: [] },
      { revision: 0, modules: [{ ...good, name: "  " }] },
      { revision: 0, modules: [good, good] },
      { revision: 0, modules: [{ ...good, quizIds: [quiz.id, quiz.id] }] },
    ]) {
      expect((await PUT(request(body), context(cls.id))).status).toBe(400);
    }
    expect(
      (
        await PUT(
          new Request("http://localhost", {
            method: "PUT",
            body: "{",
          }) as never,
          context(cls.id),
        )
      ).status,
    ).toBe(400);
  });
  it("class removal invalidates a stale organizer even when the quiz survives elsewhere", async () => {
    const { cls, teacher, quiz } = await fixture();
    const otherClass = await createClass(teacher.id);
    await prisma.classQuiz.create({
      data: { classId: otherClass.id, quizId: quiz.id },
    });
    const modules = [module("midterm", [quiz.id])];
    await PUT(request({ revision: 0, modules }), context(cls.id));
    expect(
      (await removeAssignment(request({ quizId: quiz.id }), context(cls.id)))
        .status,
    ).toBe(200);
    expect(
      (await PUT(request({ revision: 1, modules }), context(cls.id))).status,
    ).toBe(409);
    const layout: ModuleLayout = await (
      await GET(request(), context(cls.id))
    ).json();
    expect(layout.modules[0].quizIds).toEqual([]);
    expect(await prisma.classQuiz.count({ where: { classId: cls.id } })).toBe(
      0,
    );
  });
});
