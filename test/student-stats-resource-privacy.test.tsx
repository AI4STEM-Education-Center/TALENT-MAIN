import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import { StudentStatsView } from "@/components/stats/student-stats-view";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  createAdmin,
  createClass,
  createStudent,
  createTeacher,
  resetDb,
} from "./db";

beforeEach(async () => {
  await resetDb();
  vi.restoreAllMocks();
});
afterAll(() => prisma.$disconnect());

/**
 * LearningResourceSession rows exist only for students who consented to
 * research, so showing any of them to the student's teacher would reveal
 * participation — which the consent form promises instructors won't learn.
 */
describe("student stats: learning-resource telemetry privacy", () => {
  async function setup() {
    const { user: teacherUser, teacher } = await createTeacher();
    const { student } = await createStudent();
    const cls = await createClass(teacher.id);
    await prisma.classEnrollment.create({
      data: { classId: cls.id, studentId: student.id },
    });
    await prisma.learningResourceSession.create({
      data: {
        studentId: student.id,
        materialId: "mat-1",
        materialTitle: "Secret participation notes",
        classId: cls.id,
        surface: "materials_library",
        dwellMs: 12_000,
      },
    });
    const params = Promise.resolve({ id: cls.id, studentId: student.id });
    return { teacherUser, params };
  }

  it("teacher page neither queries nor renders the sessions", async () => {
    const { teacherUser, params } = await setup();
    vi.mocked(auth).mockResolvedValue({
      user: { id: teacherUser.id, role: "TEACHER" },
    } as never);
    const findMany = vi.spyOn(prisma.learningResourceSession, "findMany");
    const html = renderToStaticMarkup(
      await StudentStatsView({ params, audience: "teacher" }),
    );
    expect(findMany).not.toHaveBeenCalled();
    expect(html).not.toContain("Learning materials opened");
    expect(html).not.toContain("Secret participation notes");
  });

  it("admin page shows them", async () => {
    const { params } = await setup();
    const admin = await createAdmin();
    vi.mocked(auth).mockResolvedValue({
      user: { id: admin.id, role: "ADMIN" },
    } as never);
    const html = renderToStaticMarkup(
      await StudentStatsView({ params, audience: "admin" }),
    );
    expect(html).toContain("Learning materials opened");
    expect(html).toContain("Secret participation notes");
  });
});
