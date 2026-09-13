import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as GET_CLASS } from "@/app/api/classes/[id]/route";
import { GET as GET_QUIZZES } from "@/app/api/classes/[id]/quizzes/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher, createStudent, createClass } from "./db";

const mockAuth = vi.mocked(auth);

function asTeacher(userId: string) {
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "TEACHER" },
  } as never);
}
function asStudent(userId: string) {
  mockAuth.mockResolvedValue({
    user: { id: userId, role: "STUDENT" },
  } as never);
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function enroll(classId: string, studentId: string) {
  await prisma.classEnrollment.create({ data: { classId, studentId } });
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/classes/[id] — owner-only (F-02)", () => {
  it("401s an unauthenticated caller", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id, "Mine");
    mockAuth.mockResolvedValue(null as never);
    expect((await GET_CLASS({} as never, ctx(cls.id))).status).toBe(401);
  });

  it("returns the class to its owning teacher", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id, "Mine");
    asTeacher(user.id);
    const res = await GET_CLASS({} as never, ctx(cls.id));
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Mine");
  });

  it("404s a teacher who does not own the class", async () => {
    const owner = await createTeacher();
    const cls = await createClass(owner.teacher.id, "Theirs");
    const intruder = await createTeacher();
    asTeacher(intruder.user.id);
    expect((await GET_CLASS({} as never, ctx(cls.id))).status).toBe(404);
  });

  it("404s an enrolled student (payload exposes roster + invite tokens)", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id, "Physics");
    const { user, student } = await createStudent();
    await enroll(cls.id, student.id);
    asStudent(user.id);
    expect((await GET_CLASS({} as never, ctx(cls.id))).status).toBe(404);
  });
});

describe("GET /api/classes/[id]/quizzes — owner or enrolled (F-03)", () => {
  it("returns quizzes to the owning teacher", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id, "Mine");
    asTeacher(user.id);
    expect((await GET_QUIZZES({} as never, ctx(cls.id))).status).toBe(200);
  });

  it("404s a teacher who does not own the class", async () => {
    const owner = await createTeacher();
    const cls = await createClass(owner.teacher.id, "Theirs");
    const intruder = await createTeacher();
    asTeacher(intruder.user.id);
    expect((await GET_QUIZZES({} as never, ctx(cls.id))).status).toBe(404);
  });

  it("returns quizzes to an enrolled student", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id, "Physics");
    const { user, student } = await createStudent();
    await enroll(cls.id, student.id);
    asStudent(user.id);
    expect((await GET_QUIZZES({} as never, ctx(cls.id))).status).toBe(200);
  });

  it("404s a student not enrolled in the class", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id, "Physics");
    const { user } = await createStudent();
    asStudent(user.id);
    expect((await GET_QUIZZES({} as never, ctx(cls.id))).status).toBe(404);
  });
});
