import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as EXPORT } from "@/app/api/classes/[id]/quizzes/[quizId]/grades-export/route";
import { buildGradesCsv, formatGrade } from "@/lib/grades-csv";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher, createClass, createPublishedQuiz, createStudent } from "./db";

const mockAuth = vi.mocked(auth);

function asUser(userId: string, role: string) {
  mockAuth.mockResolvedValue({ user: { id: userId, role } } as never);
}

function call(classId: string, quizId: string, header?: string) {
  const qs = header !== undefined ? `?header=${encodeURIComponent(header)}` : "";
  return EXPORT(
    new NextRequest(`http://localhost/api/classes/${classId}/quizzes/${quizId}/grades-export${qs}`),
    { params: Promise.resolve({ id: classId, quizId }) }
  );
}

async function addRoster(
  classId: string,
  orgDefinedId: string,
  lastName: string,
  firstName: string
) {
  return prisma.classStudentList.create({
    data: { classId, orgDefinedId, lastName, firstName },
  });
}

async function addCompletedAttempt(
  studentId: string,
  classId: string,
  quizId: string,
  score: number
) {
  return prisma.quizAttempt.create({
    data: { studentId, classId, quizId, score, completedAt: new Date() },
  });
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("buildGradesCsv", () => {
  it("reproduces the eLC format: CRLF, # prefixes, custom column before the end marker", () => {
    const csv = buildGradesCsv("Quiz 3 Points Grade <Numeric MaxPoints:100>", [
      { orgDefinedId: "811947904", lastName: "Nash", firstName: "Aaron", grade: "95" },
      { orgDefinedId: "811107402", lastName: "Sherer", firstName: "Aaron", grade: "" },
    ]);
    expect(csv).toBe(
      "OrgDefinedId,Last Name,First Name,Quiz 3 Points Grade <Numeric MaxPoints:100>,End-of-Line Indicator\r\n" +
        "#811947904,Nash,Aaron,95,#\r\n" +
        "#811107402,Sherer,Aaron,,#\r\n"
    );
  });

  it("quotes fields containing commas or quotes", () => {
    const csv = buildGradesCsv('My "special", header', [
      { orgDefinedId: "1", lastName: "Diaz, Jr.", firstName: "Al", grade: "80" },
    ]);
    const [header, row] = csv.split("\r\n");
    expect(header).toContain('"My ""special"", header"');
    expect(row).toBe('#1,"Diaz, Jr.",Al,80,#');
  });
});

describe("formatGrade", () => {
  it("renders blanks, integers, and trimmed decimals", () => {
    expect(formatGrade(null)).toBe("");
    expect(formatGrade(95)).toBe("95");
    expect(formatGrade(87.5)).toBe("87.5");
    expect(formatGrade(66.666_67)).toBe("66.67");
  });
});

describe("GET /api/classes/[id]/quizzes/[quizId]/grades-export", () => {
  it("401s a non-teacher", async () => {
    asUser("s", "STUDENT");
    expect((await call("c", "q")).status).toBe(401);
  });

  it("404s a teacher who doesn't own the class", async () => {
    const { user: owner, teacher } = await createTeacher();
    void owner;
    const cls = await createClass(teacher.id);
    const { quiz } = await createPublishedQuiz({ classId: cls.id });
    const { user: intruder } = await createTeacher();

    asUser(intruder.id, "TEACHER");
    expect((await call(cls.id, quiz.id)).status).toBe(404);
  });

  it("404s when the quiz is not assigned to the class", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const otherClass = await createClass(teacher.id, "Other");
    const { quiz } = await createPublishedQuiz({ classId: otherClass.id });

    asUser(user.id, "TEACHER");
    expect((await call(cls.id, quiz.id)).status).toBe(404);
  });

  it("exports roster rows with best scores matched by name, blanks for the rest", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { quiz } = await createPublishedQuiz({ classId: cls.id });

    // Aaron Nash: account matching the roster name, two attempts (best 87.5).
    const { user: nashUser, student: nash } = await createStudent();
    await prisma.user.update({
      where: { id: nashUser.id },
      data: { firstName: "Aaron", lastName: "Nash" },
    });
    await addCompletedAttempt(nash.id, cls.id, quiz.id, 40);
    await addCompletedAttempt(nash.id, cls.id, quiz.id, 87.5);

    // An incomplete attempt must not count.
    const { user: shererUser, student: sherer } = await createStudent();
    await prisma.user.update({
      where: { id: shererUser.id },
      data: { firstName: "Aaron", lastName: "Sherer" },
    });
    await prisma.quizAttempt.create({
      data: { studentId: sherer.id, classId: cls.id, quizId: quiz.id, score: null },
    });

    await addRoster(cls.id, "811947904", "Nash", "Aaron");
    await addRoster(cls.id, "811107402", "Sherer", "Aaron");
    await addRoster(cls.id, "811888945", "Boggavarapu", "Abhi"); // no account at all

    asUser(user.id, "TEACHER");
    const res = await call(cls.id, quiz.id, "Quiz 3 Points Grade <Numeric MaxPoints:100>");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename=".+\.csv"/);

    const body = await res.text();
    expect(body).toBe(
      "OrgDefinedId,Last Name,First Name,Quiz 3 Points Grade <Numeric MaxPoints:100>,End-of-Line Indicator\r\n" +
        "#811888945,Boggavarapu,Abhi,,#\r\n" +
        "#811947904,Nash,Aaron,87.5,#\r\n" +
        "#811107402,Sherer,Aaron,,#\r\n"
    );
  });

  it("falls back to a quiz-name grade header when none is given", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { quiz } = await createPublishedQuiz({ classId: cls.id });

    asUser(user.id, "TEACHER");
    const body = await (await call(cls.id, quiz.id)).text();
    expect(body.split("\r\n")[0]).toBe(
      `OrgDefinedId,Last Name,First Name,${quiz.name} Points Grade,End-of-Line Indicator`
    );
  });
});
