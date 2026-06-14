import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET, POST } from "@/app/api/classes/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher, createStudent, createClass } from "./db";

const mockAuth = vi.mocked(auth);

function jsonReq(body: unknown) {
  return new Request("http://localhost/api/classes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function asTeacher(userId: string) {
  mockAuth.mockResolvedValue({ user: { id: userId, role: "TEACHER" } } as never);
}
function asStudent(userId: string) {
  mockAuth.mockResolvedValue({ user: { id: userId, role: "STUDENT" } } as never);
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/classes", () => {
  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await GET()).status).toBe(401);
  });

  it("returns a teacher's own classes with counts", async () => {
    const { user, teacher } = await createTeacher();
    const other = await createTeacher();
    await createClass(teacher.id, "Mine");
    await createClass(other.teacher.id, "Theirs");

    asTeacher(user.id);
    const body = await (await GET()).json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Mine");
    expect(body[0]._count).toHaveProperty("enrollments");
  });

  it("returns 404 when a teacher user has no Teacher row", async () => {
    const user = await prisma.user.create({
      data: {
        email: "noteacher@example.com",
        username: "noteacher",
        hashedPassword: "x",
        firstName: "No",
        lastName: "Row",
        role: "TEACHER",
      },
    });
    asTeacher(user.id);
    expect((await GET()).status).toBe(404);
  });

  it("returns the classes a student is enrolled in", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id, "Physics");
    const { user: studentUser, student } = await createStudent();
    await prisma.classEnrollment.create({ data: { classId: cls.id, studentId: student.id } });
    // A class the student is NOT in.
    await createClass(teacher.id, "Chemistry");

    asStudent(studentUser.id);
    const body = await (await GET()).json();
    expect(body.map((c: { name: string }) => c.name)).toEqual(["Physics"]);
  });
});

describe("POST /api/classes", () => {
  it("401s a non-teacher", async () => {
    const { user } = await createStudent();
    asStudent(user.id);
    expect((await POST(jsonReq({ name: "X" }))).status).toBe(401);
  });

  it("requires a class name", async () => {
    const { user } = await createTeacher();
    asTeacher(user.id);
    expect((await POST(jsonReq({ name: "  " }))).status).toBe(400);
  });

  it("creates a class for the teacher", async () => {
    const { user, teacher } = await createTeacher();
    asTeacher(user.id);
    const res = await POST(jsonReq({ name: " Algebra ", description: " intro " }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Algebra");
    expect(body.description).toBe("intro");
    expect(body.teacherId).toBe(teacher.id);
  });

  it("seeds the class roster and strips a leading # from org ids", async () => {
    const { user } = await createTeacher();
    asTeacher(user.id);
    const res = await POST(
      jsonReq({
        name: "Roster Class",
        studentList: [
          { orgDefinedId: "#811947904", firstName: " Ada ", lastName: " Lovelace ", email: "Ada@Example.com" },
          { orgDefinedId: "222", firstName: "Alan", lastName: "Turing", email: "alan@example.com" },
        ],
      })
    );
    const body = await res.json();
    const roster = await prisma.classStudentList.findMany({
      where: { classId: body.id },
      orderBy: { lastName: "asc" },
    });
    expect(roster).toHaveLength(2);
    expect(roster[0]).toMatchObject({
      orgDefinedId: "811947904",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    });
    expect(roster[1].orgDefinedId).toBe("222");
  });
});
