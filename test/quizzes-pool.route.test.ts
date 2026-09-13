import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as POOL_LIST } from "@/app/api/quizzes/pool/route";
import { POST as IMPORT } from "@/app/api/quizzes/pool/[id]/import/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher } from "./db";

const mockAuth = vi.mocked(auth);

function asTeacher(userId: string) {
  mockAuth.mockResolvedValue({ user: { id: userId, role: "TEACHER" } } as never);
}
function asAdmin() {
  mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } } as never);
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/quizzes/pool", () => {
  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await POOL_LIST()).status).toBe(401);
  });

  it("returns only pool quizzes (teacherId null)", async () => {
    const { teacher } = await createTeacher();
    await prisma.quiz.create({ data: { name: "Pool 1", teacherId: null } });
    await prisma.quiz.create({ data: { name: "Private", teacherId: teacher.id } });

    asAdmin();
    const body = await (await POOL_LIST()).json();
    expect(body.map((q: { name: string }) => q.name)).toEqual(["Pool 1"]);
  });

  it("flags pool quizzes the teacher has already imported", async () => {
    const { user, teacher } = await createTeacher();
    const pool = await prisma.quiz.create({ data: { name: "Pool", teacherId: null } });
    const fresh = await prisma.quiz.create({ data: { name: "Fresh", teacherId: null } });
    // Teacher's own copy linked back to `pool` via sourceQuizId.
    await prisma.quiz.create({ data: { name: "Imported", teacherId: teacher.id, sourceQuizId: pool.id } });

    asTeacher(user.id);
    const body = await (await POOL_LIST()).json();
    const byId = Object.fromEntries(body.map((q: { id: string; alreadyImported: boolean }) => [q.id, q.alreadyImported]));
    expect(byId[pool.id]).toBe(true);
    expect(byId[fresh.id]).toBe(false);
  });
});

describe("POST /api/quizzes/pool/[id]/import", () => {
  it("401s an admin (import is a teacher action)", async () => {
    const pool = await prisma.quiz.create({ data: { name: "Pool", teacherId: null } });
    asAdmin();
    expect((await IMPORT({} as never, params(pool.id))).status).toBe(401);
  });

  it("404s when the id is not a pool quiz", async () => {
    const { user, teacher } = await createTeacher();
    const priv = await prisma.quiz.create({ data: { name: "Private", teacherId: teacher.id } });
    asTeacher(user.id);
    expect((await IMPORT({} as never, params(priv.id))).status).toBe(404);
  });

  it("deep-copies a pool quiz into the teacher's scope", async () => {
    const { user, teacher } = await createTeacher();
    const pool = await prisma.quiz.create({ data: { name: "Pool Quiz", teacherId: null } });
    await prisma.question.create({ data: { text: "Q?", quizId: pool.id } });

    asTeacher(user.id);
    const res = await IMPORT({} as never, params(pool.id));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.teacherId).toBe(teacher.id);
    expect(body.sourceQuizId).toBe(pool.id);
    expect(body.id).not.toBe(pool.id);
    expect(await prisma.question.count({ where: { quizId: body.id } })).toBe(1);
  });
});
