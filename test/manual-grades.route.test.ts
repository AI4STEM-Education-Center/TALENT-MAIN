import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import {
  DELETE as CLEAR_GRADE,
  PUT as SET_GRADE,
} from "@/app/api/classes/[id]/quizzes/[quizId]/manual-grades/[studentId]/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createClass, createPublishedQuiz, createStudent, createTeacher, resetDb } from "./db";

const mockAuth = vi.mocked(auth);

function asUser(userId: string, role: string) {
  mockAuth.mockResolvedValue({ user: { id: userId, role } } as never);
}

function params(classId: string, quizId: string, studentId: string) {
  return { params: Promise.resolve({ id: classId, quizId, studentId }) };
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("manual quiz grades", () => {
  it("lets the owning teacher set and clear a percentage for an enrolled student", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { quiz } = await createPublishedQuiz({ classId: cls.id });
    const { student } = await createStudent();
    await prisma.classEnrollment.create({ data: { classId: cls.id, studentId: student.id } });
    asUser(user.id, "TEACHER");

    const setResponse = await SET_GRADE(
      new NextRequest("http://localhost/manual-grade", {
        method: "PUT",
        body: JSON.stringify({ grade: 92.5 }),
        headers: { "Content-Type": "application/json" },
      }),
      params(cls.id, quiz.id, student.id)
    );
    expect(setResponse.status).toBe(200);
    expect(await setResponse.json()).toEqual({ manualGrade: 92.5 });

    const saved = await prisma.quizProgress.findUnique({
      where: {
        studentId_classId_quizId: { studentId: student.id, classId: cls.id, quizId: quiz.id },
      },
    });
    expect(saved?.manualGrade).toBe(92.5);

    const clearResponse = await CLEAR_GRADE(
      new NextRequest("http://localhost/manual-grade", { method: "DELETE" }),
      params(cls.id, quiz.id, student.id)
    );
    expect(clearResponse.status).toBe(204);
    expect(
      await prisma.quizProgress.findUnique({
        where: {
          studentId_classId_quizId: { studentId: student.id, classId: cls.id, quizId: quiz.id },
        },
      })
    ).toMatchObject({ manualGrade: null });
  });

  it("rejects out-of-range values and students who are not enrolled", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { quiz } = await createPublishedQuiz({ classId: cls.id });
    const { student } = await createStudent();
    asUser(user.id, "TEACHER");

    const missing = await SET_GRADE(
      new NextRequest("http://localhost/manual-grade", {
        method: "PUT",
        body: JSON.stringify({ grade: 50 }),
      }),
      params(cls.id, quiz.id, student.id)
    );
    expect(missing.status).toBe(404);

    await prisma.classEnrollment.create({ data: { classId: cls.id, studentId: student.id } });
    const invalid = await SET_GRADE(
      new NextRequest("http://localhost/manual-grade", {
        method: "PUT",
        body: JSON.stringify({ grade: 101 }),
      }),
      params(cls.id, quiz.id, student.id)
    );
    expect(invalid.status).toBe(400);
  });

  it("does not let another teacher change the grade", async () => {
    const owner = await createTeacher();
    const intruder = await createTeacher();
    const cls = await createClass(owner.teacher.id);
    const { quiz } = await createPublishedQuiz({ classId: cls.id });
    const { student } = await createStudent();
    await prisma.classEnrollment.create({ data: { classId: cls.id, studentId: student.id } });
    asUser(intruder.user.id, "TEACHER");

    const response = await SET_GRADE(
      new NextRequest("http://localhost/manual-grade", {
        method: "PUT",
        body: JSON.stringify({ grade: 80 }),
      }),
      params(cls.id, quiz.id, student.id)
    );
    expect(response.status).toBe(404);
  });
});
