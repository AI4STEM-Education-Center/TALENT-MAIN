import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as STATS } from "@/app/api/admin/stats/route";
import { GET as USERS } from "@/app/api/admin/users/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher, createStudent, createClass } from "./db";

const mockAuth = vi.mocked(auth);

function asAdmin() {
  mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN" } } as never);
}
function asTeacher(userId = "t") {
  mockAuth.mockResolvedValue({ user: { id: userId, role: "TEACHER" } } as never);
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/admin/stats", () => {
  it("401s a non-admin", async () => {
    asTeacher();
    expect((await STATS()).status).toBe(401);
  });

  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await STATS()).status).toBe(401);
  });

  it("counts users by role and total classes", async () => {
    const { teacher } = await createTeacher();
    await createTeacher();
    await createStudent();
    await prisma.user.create({
      data: {
        email: "boss@example.com",
        username: "boss",
        hashedPassword: "x",
        firstName: "Big",
        lastName: "Boss",
        role: "ADMIN",
      },
    });
    await createClass(teacher.id);

    asAdmin();
    const body = await (await STATS()).json();
    expect(body).toEqual({ students: 1, teachers: 2, admins: 1, classes: 1 });
  });
});

describe("GET /api/admin/users", () => {
  it("401s a non-admin", async () => {
    asTeacher();
    expect((await USERS()).status).toBe(401);
  });

  it("lists users without exposing password hashes", async () => {
    await createTeacher();
    await createStudent();

    asAdmin();
    const res = await USERS();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length).toBeGreaterThanOrEqual(2);
    for (const u of body) {
      expect(u).not.toHaveProperty("hashedPassword");
      expect(u).toHaveProperty("role");
      expect(u).toHaveProperty("email");
    }
  });
});
