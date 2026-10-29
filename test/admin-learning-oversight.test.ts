import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
  notFound: () => {
    throw new Error("not-found");
  },
}));
vi.mock("@/lib/storage", () => ({
  getS3ObjectAsString: vi
    .fn()
    .mockResolvedValue(
      "<!doctype html><html><body>Simulation preview</body></html>",
    ),
}));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireStatsClass } from "@/lib/stats-access";
import { getAdminUsage, PAGE_SIZE } from "@/lib/admin-usage";
import {
  GET as quizDetail,
  PATCH as updateQuiz,
} from "@/app/api/quizzes/[id]/route";
import { GET as simulations } from "@/app/api/admin/simulations/route";
import { GET as simulationContent } from "@/app/api/simulations/[id]/content/route";
import {
  createClass,
  createStudent,
  createTeacher,
  createPublishedQuiz,
  resetDb,
} from "./db";

const asRole = (role: string, id = "admin") =>
  vi.mocked(auth).mockResolvedValue({ user: { id, role } } as never);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(async () => {
  await resetDb();
  vi.mocked(auth).mockReset();
});
afterAll(() => prisma.$disconnect());

async function seed() {
  const { teacher, user } = await createTeacher();
  const cls = await createClass(teacher.id);
  const { student } = await createStudent();
  const { quiz, question } = await createPublishedQuiz({
    classId: cls.id,
    teacherId: teacher.id,
  });
  return { teacher, user, cls, student, quiz, question };
}

describe("admin learning oversight access", () => {
  it("opens teacher uploads read-only with question answers and simulation metadata", async () => {
    const { quiz, question } = await seed();
    const sim = await prisma.questionSimulation.create({
      data: {
        questionId: question.id,
        status: "READY",
        title: "Teacher lab",
        storageKey: "private.html",
        bucket: "test",
        version: 1,
      },
    });
    asRole("ADMIN");
    const response = await quizDetail({} as never, params(quiz.id));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.editable).toBe(false);
    expect(
      body.questions[0].options.some(
        (option: { isCorrect: boolean }) => option.isCorrect,
      ),
    ).toBe(true);
    expect(body.questions[0].simulation).toMatchObject({
      id: sim.id,
      title: "Teacher lab",
      hasContent: true,
    });
    expect(body.questions[0].simulation).not.toHaveProperty("storageKey");
    const update = await updateQuiz(
      new NextRequest("http://localhost/api/quizzes/x", {
        method: "PATCH",
        body: JSON.stringify({ name: "Changed" }),
      }),
      params(quiz.id),
    );
    expect(update.status).toBe(404);
    expect(
      (await prisma.quiz.findUniqueOrThrow({ where: { id: quiz.id } })).name,
    ).toBe(quiz.name);
  });

  it("includes pool and teacher simulations with owner identity and correct totals", async () => {
    const { quiz, question, user } = await seed();
    await prisma.questionSimulation.create({
      data: { questionId: question.id, status: "READY" },
    });
    await prisma.quiz.create({
      data: { name: "Pool", questions: { create: { text: "Pool question" } } },
    });
    asRole("ADMIN");
    const body = await (
      await simulations(
        new NextRequest("http://localhost/api/admin/simulations"),
      )
    ).json();
    expect(body.quizzes).toHaveLength(2);
    expect(
      body.quizzes.find((row: { id: string }) => row.id === quiz.id).teacher
        .email,
    ).toBe(user.email);
    expect(body.totals).toMatchObject({ ready: 1, missing: 1 });
    const detail = await (
      await simulations(
        new NextRequest(
          `http://localhost/api/admin/simulations?quizId=${quiz.id}`,
        ),
      )
    ).json();
    expect(detail.questions[0].simulation.status).toBe("READY");
  });

  it("serves teacher simulation previews to admins without recording student usage", async () => {
    const { question } = await seed();
    const sim = await prisma.questionSimulation.create({
      data: {
        questionId: question.id,
        status: "READY",
        storageKey: "private.html",
        bucket: "test",
        version: 1,
      },
    });
    asRole("ADMIN");
    const response = await simulationContent(
      new NextRequest(`http://localhost/api/simulations/${sim.id}/content`),
      params(sim.id),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Simulation preview");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'self'",
    );
    expect(await prisma.simulationSession.count()).toBe(0);
  });

  it.each(["TEACHER", "STUDENT"])(
    "rejects %s from admin records and simulation coverage",
    async (role) => {
      asRole(role);
      await expect(getAdminUsage({})).rejects.toThrow("redirect:/login");
      await expect(requireStatsClass("any", "admin")).rejects.toThrow(
        "redirect:/login",
      );
      expect(
        (
          await simulations(
            new NextRequest("http://localhost/api/admin/simulations"),
          )
        ).status,
      ).toBe(403);
    },
  );

  it("rejects anonymous readers", async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    await expect(getAdminUsage({})).rejects.toThrow("redirect:/login");
    await expect(requireStatsClass("any", "admin")).rejects.toThrow(
      "redirect:/login",
    );
  });

  it("allows admins across classes but retains teacher ownership checks", async () => {
    const { cls, user } = await seed();
    asRole("ADMIN");
    expect((await requireStatsClass(cls.id, "admin")).id).toBe(cls.id);
    await expect(requireStatsClass("missing", "admin")).rejects.toThrow(
      "not-found",
    );
    asRole("TEACHER", user.id);
    expect((await requireStatsClass(cls.id, "teacher")).id).toBe(cls.id);
    const other = await createTeacher();
    asRole("TEACHER", other.user.id);
    await expect(requireStatsClass(cls.id, "teacher")).rejects.toThrow(
      "not-found",
    );
  });
});

describe("admin student usage records", () => {
  it("paginates every simulation record and scopes filters without losing outside-class activity", async () => {
    const { cls, student, quiz } = await seed();
    const other = await createStudent();
    await prisma.simulationSession.createMany({
      data: Array.from({ length: PAGE_SIZE + 1 }, (_, index) => ({
        id: `session-${String(index).padStart(3, "0")}`,
        simulationId: "removed-sim",
        studentId: student.id,
        classId: cls.id,
        quizId: quiz.id,
        surface: "rail",
        startedAt: new Date("2026-01-01"),
        activeMs: 12000,
        interactionCount: 2,
      })),
    });
    await prisma.simulationSession.create({
      data: {
        simulationId: "removed-sim",
        studentId: other.student.id,
        surface: "library",
      },
    });
    asRole("ADMIN");
    const first = await getAdminUsage({
      kind: "simulations",
      classId: cls.id,
      studentId: student.id,
    });
    const second = await getAdminUsage({
      kind: "simulations",
      classId: cls.id,
      studentId: student.id,
      page: "2",
    });
    expect(first.total).toBe(51);
    expect(first.records).toHaveLength(50);
    expect(second.records).toHaveLength(1);
    expect(
      new Set([...first.records, ...second.records].map((row) => row.id)).size,
    ).toBe(51);
    expect(first.records[0].detail).toContain("2 interactions");
    // Legacy surface values render through the label map, never raw.
    expect(first.records[0].detail).toContain(
      "Results rail (legacy, desktop) (Desktop)",
    );
    expect((await getAdminUsage({ kind: "simulations" })).total).toBe(52);
    const library = (
      await getAdminUsage({
        kind: "simulations",
        studentId: other.student.id,
      })
    ).records[0];
    expect(library.className).toBe("Simulations library");
    expect(library.classHref).toBeNull();
    expect(library.classNote).toBe(
      "Self-directed open, not tied to a class. Student is not enrolled in any class",
    );
    expect(
      (await getAdminUsage({ kind: "simulations", q: other.user.email })).total,
    ).toBe(1);
    expect(
      (
        await getAdminUsage({
          kind: "simulations",
          q: other.user.email,
          studentId: student.id,
        })
      ).total,
    ).toBe(0);
  });

  it("keeps durable results discoverable after deletion of student, class and quiz", async () => {
    await prisma.examResult.create({
      data: {
        quizAttemptId: "deleted-attempt",
        studentId: "deleted-student",
        classId: "deleted-class",
        quizId: "deleted-quiz",
        studentName: "Archived Learner",
        className: "Archived Physics",
        topicName: "Forces",
        quizName: "Archived Quiz",
        score: 75,
        correctCount: 3,
        totalCount: 4,
        completedAt: new Date(),
        reviewSnapshot: "{}",
      },
    });
    asRole("ADMIN");
    const usage = await getAdminUsage({ q: "Archived Learner" });
    expect(usage.total).toBe(1);
    expect(usage.records[0]).toMatchObject({
      studentName: "Archived Learner",
      className: "Archived Physics",
      title: "Archived Quiz",
      classHref: null,
      href: "/admin/classes/deleted-class/students/deleted-student/attempts/deleted-attempt",
    });
  });

  it("shows unfinished quizzes and both active and completed practice without exposing answers", async () => {
    const { cls, student, quiz } = await seed();
    await prisma.quizAttempt.create({
      data: { studentId: student.id, classId: cls.id, quizId: quiz.id },
    });
    await prisma.quizAttempt.create({
      data: {
        studentId: student.id,
        classId: cls.id,
        quizId: quiz.id,
        completedAt: new Date(),
        score: 80,
      },
    });
    await prisma.quizPracticeAttempt.createMany({
      data: [
        {
          studentId: student.id,
          classId: cls.id,
          quizId: quiz.id,
          versionId: "version",
          versionName: "Practice 1",
          questions: "[]",
        },
        {
          studentId: student.id,
          classId: cls.id,
          quizId: quiz.id,
          versionId: "version",
          versionName: "Practice 1",
          questions: "[]",
          completedAt: new Date(),
          score: 90,
        },
      ],
    });
    asRole("ADMIN");
    expect((await getAdminUsage({ kind: "attempts" })).total).toBe(1);
    const practice = await getAdminUsage({ kind: "practice" });
    expect(practice.total).toBe(2);
    expect(practice.records.map((row) => row.detail)).toEqual(
      expect.arrayContaining(["In progress", "Completed · 90%"]),
    );
    expect(practice.records[0]).not.toHaveProperty("questions");
  });

  it("explains class-less simulation sessions and lists the student's current classes", async () => {
    const { cls, student, quiz } = await seed();
    await prisma.classEnrollment.create({
      data: { classId: cls.id, studentId: student.id },
    });
    await prisma.simulationSession.createMany({
      data: [
        {
          id: "s-library",
          simulationId: "sim",
          studentId: student.id,
          quizId: quiz.id,
          surface: "library",
          startedAt: new Date("2026-01-03"),
        },
        {
          id: "s-unverified",
          simulationId: "sim",
          studentId: student.id,
          quizId: quiz.id,
          surface: "rail",
          startedAt: new Date("2026-01-02"),
        },
        {
          id: "s-class",
          simulationId: "sim",
          studentId: student.id,
          classId: cls.id,
          quizId: quiz.id,
          surface: "quiz_results",
          startedAt: new Date("2026-01-01"),
        },
      ],
    });
    asRole("ADMIN");
    const { records } = await getAdminUsage({ kind: "simulations" });
    expect(
      records.map(({ id, className, classNote }) => ({
        id,
        className,
        classNote,
      })),
    ).toEqual([
      {
        id: "s-library",
        className: "Simulations library",
        classNote: `Self-directed open, not tied to a class. Student's classes: ${cls.name}`,
      },
      {
        id: "s-unverified",
        className: "No class recorded",
        classNote: `Opened from quiz results without a verified attempt. Student's classes: ${cls.name}`,
      },
      { id: "s-class", className: cls.name, classNote: null },
    ]);
    expect(records[0]).not.toHaveProperty("surface");
  });

  it.each([
    [
      "library",
      null,
      "Simulations library",
      "Self-directed open, not tied to a class",
    ],
    [
      "quiz_results",
      null,
      "No class recorded",
      "Opened from quiz results without a verified attempt",
    ],
    [
      "results_page",
      "attempt",
      "No class recorded",
      "Opened from quiz results whose class no longer assigns this quiz",
    ],
    [
      "rail",
      null,
      "No class recorded",
      "Opened from quiz results without a verified attempt",
    ],
    [
      "mobile",
      "attempt",
      "No class recorded",
      "Opened from quiz results whose class no longer assigns this quiz",
    ],
  ])(
    "labels a class-less %s simulation session (attempt %s)",
    async (surface, attemptId, className, note) => {
      const { student } = await createStudent();
      await prisma.simulationSession.create({
        data: {
          simulationId: "sim",
          studentId: student.id,
          surface,
          attemptId,
        },
      });
      asRole("ADMIN");
      const [row] = (await getAdminUsage({ kind: "simulations" })).records;
      expect(row.className).toBe(className);
      expect(row.classNote).toBe(
        `${note}. Student is not enrolled in any class`,
      );
    },
  );

  it("limits learning material views to admins and research scientists", async () => {
    const { student } = await createStudent();
    await prisma.learningResourceSession.create({
      data: {
        studentId: student.id,
        materialId: "material",
        surface: "materials_library",
      },
    });
    for (const role of ["ADMIN", "RESEARCHER"]) {
      asRole(role);
      expect((await getAdminUsage({ kind: "materials" })).total).toBe(1);
    }
    for (const role of ["TEACHER", "STUDENT"]) {
      asRole(role);
      await expect(getAdminUsage({ kind: "materials" })).rejects.toThrow(
        "redirect:/login",
      );
    }
    vi.mocked(auth).mockResolvedValue(null as never);
    await expect(getAdminUsage({ kind: "materials" })).rejects.toThrow(
      "redirect:/login",
    );
  });

  it("lists learning material views with recommendation context and reading detail", async () => {
    const { teacher, cls, student, quiz } = await seed();
    const other = await createStudent();
    const material = await prisma.learningMaterial.create({
      data: {
        teacherId: teacher.id,
        classId: cls.id,
        title: "Forces handout",
        originalName: "forces.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: "forces.pdf",
        bucket: "test",
      },
    });
    await prisma.learningResourceSession.createMany({
      data: [
        {
          id: "m-rec",
          studentId: student.id,
          materialId: material.id,
          materialTitle: "Old title",
          classId: cls.id,
          quizId: quiz.id,
          attemptId: "attempt",
          surface: "results_recommendation",
          recommended: true,
          pageStart: 2,
          pageEnd: 4,
          openedAt: new Date("2026-01-03"),
          endedAt: new Date("2026-01-03T00:05:00Z"),
          activeMs: 60_000,
          dwellMs: 90_000,
          clickCount: 7,
          pdfOpenCount: 1,
          pagesViewed: 3,
        },
        {
          id: "m-library",
          studentId: student.id,
          materialId: material.id,
          surface: "materials_library",
          openedAt: new Date("2026-01-02"),
          pagesViewed: 1,
        },
        {
          id: "m-removed",
          studentId: other.student.id,
          materialId: "gone",
          materialTitle: "Deleted notes",
          classId: cls.id,
          surface: "materials_library",
          openedAt: new Date("2026-01-01"),
        },
      ],
    });
    asRole("ADMIN");
    const usage = await getAdminUsage({ kind: "materials" });
    expect(usage.kind).toBe("materials");
    expect(usage.total).toBe(3);
    const [rec, library, removed] = usage.records;
    expect(rec).toMatchObject({
      title: "Forces handout",
      href: `/admin/materials/${material.id}`,
      className: cls.name,
      classHref: `/admin/classes/${cls.id}/stats`,
      subtitle: `Recommended pp. 2–4 after ${quiz.name}`,
      completedAt: new Date("2026-01-03T00:05:00Z"),
    });
    expect(rec.detail).toBe(
      "1m 00s active / 1m 30s visible · 3 pages viewed · 7 clicks · 1 PDF opens · Quiz results (recommended)",
    );
    expect(library).toMatchObject({
      className: "Course materials library",
      subtitle: "Self-directed reading",
      quizName: "—",
    });
    expect(library.detail).toContain("1 page viewed");
    expect(library.classNote).toContain("Student is not enrolled in any class");
    expect(removed).toMatchObject({
      title: "Deleted notes (removed)",
      href: undefined,
    });
    expect(
      (await getAdminUsage({ kind: "materials", q: other.user.email })).total,
    ).toBe(1);
    expect(
      (
        await getAdminUsage({
          kind: "materials",
          classId: cls.id,
          studentId: student.id,
        })
      ).total,
    ).toBe(1);
  });

  it("normalizes malformed kinds and pagination", async () => {
    asRole("ADMIN");
    const usage = await getAdminUsage({ kind: "toString", page: "-Infinity" });
    expect(usage.kind).toBe("results");
    expect(usage.page).toBe(1);
    expect((await getAdminUsage({ page: "1.2" })).page).toBe(1);
  });
});
