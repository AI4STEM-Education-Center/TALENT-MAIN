import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    signObjectReadUrl: vi.fn(async (_bucket: string, key: string) => `https://signed.test/${key}`),
  };
});

import { GET as MATERIAL_FILE } from "@/app/api/student/materials/[materialId]/file/route";
import { GET as PAGE_IMAGE } from "@/app/api/student/materials/[materialId]/pages/[pageId]/image/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  getStudentMaterial,
  listStudentMaterials,
  listStudentSimulations,
} from "@/lib/student-content";
import { createClass, createStudent, createTeacher, resetDb } from "./db";

const mockAuth = vi.mocked(auth);

function asStudent(userId: string) {
  mockAuth.mockResolvedValue({ user: { id: userId, role: "STUDENT" } } as never);
}

const req = () => new Request("http://localhost/api/student/materials/x") as never;

async function enroll(classId: string, studentId: string) {
  await prisma.classEnrollment.create({ data: { classId, studentId } });
}

/** A READY material, optionally linked to classes and given `pageCount` pages. */
async function createMaterial(
  teacherId: string,
  opts: { classIds?: string[]; title?: string; pageCount?: number; uploadStatus?: string } = {}
) {
  const material = await prisma.learningMaterial.create({
    data: {
      teacherId,
      title: opts.title ?? "Kinematics notes",
      originalName: "notes.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      storageKey: `learning-materials/${teacherId}/notes.pdf`,
      bucket: "test-bucket",
      uploadStatus: opts.uploadStatus ?? "READY",
      totalPages: opts.pageCount ?? 0,
      classLinks: { create: (opts.classIds ?? []).map((classId) => ({ classId })) },
    },
  });
  for (let i = 1; i <= (opts.pageCount ?? 0); i += 1) {
    await prisma.materialPage.create({
      data: {
        materialId: material.id,
        pageNumber: i,
        storageKey: `learning-materials/${teacherId}/pages/${i}.png`,
      },
    });
  }
  return material;
}

/**
 * A quiz owned by `teacherId` whose single question carries a READY simulation,
 * assigned to `classIds`. This is the shape the whole feature turns on: the
 * simulation reaches a student only through Question -> Quiz -> ClassQuiz.
 */
async function createQuizWithSimulation(opts: {
  teacherId: string;
  name: string;
  classIds?: string[];
  published?: boolean;
  simTitle?: string;
  status?: string;
  order?: number;
}) {
  const quiz = await prisma.quiz.create({
    // Explicit order: quizzes created in the same millisecond would otherwise
    // tie on the createdAt fallback and make the expected ordering flaky.
    data: { name: opts.name, teacherId: opts.teacherId, order: opts.order ?? 0 },
  });
  for (const classId of opts.classIds ?? []) {
    await prisma.classQuiz.create({
      data: { classId, quizId: quiz.id, published: opts.published ?? true },
    });
  }
  const question = await prisma.question.create({
    data: { text: `${opts.name} Q1`, quizId: quiz.id },
  });
  const simulation = await prisma.questionSimulation.create({
    data: {
      questionId: question.id,
      status: opts.status ?? "READY",
      title: opts.simTitle ?? `${opts.name} simulation`,
      topic: opts.name,
      storageKey: `simulations/${question.id}/v1.html`,
      bucket: "test-bucket",
      version: 1,
    },
  });
  return { quiz, question, simulation };
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("listStudentMaterials", () => {
  it("lists materials shared with the student's classes and nothing else", async () => {
    const { teacher } = await createTeacher();
    const mine = await createClass(teacher.id, "Physics 1");
    const theirs = await createClass(teacher.id, "Physics 2");
    const { student } = await createStudent();
    await enroll(mine.id, student.id);

    await createMaterial(teacher.id, { classIds: [mine.id], title: "Mine" });
    await createMaterial(teacher.id, { classIds: [theirs.id], title: "Not mine" });

    const materials = await listStudentMaterials(student.id);
    expect(materials.map((m) => m.title)).toEqual(["Mine"]);
    expect(materials[0].classes).toEqual([{ id: mine.id, name: "Physics 1" }]);
  });

  it("lists a material shared with two enrolled classes once, naming both", async () => {
    const { teacher } = await createTeacher();
    const a = await createClass(teacher.id, "Section A");
    const b = await createClass(teacher.id, "Section B");
    const { student } = await createStudent();
    await enroll(a.id, student.id);
    await enroll(b.id, student.id);

    await createMaterial(teacher.id, { classIds: [a.id, b.id] });

    const materials = await listStudentMaterials(student.id);
    expect(materials).toHaveLength(1);
    expect(materials[0].classes.map((c) => c.name).toSorted()).toEqual(["Section A", "Section B"]);
  });

  it("hides a material whose upload never completed", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { student } = await createStudent();
    await enroll(cls.id, student.id);

    await createMaterial(teacher.id, { classIds: [cls.id], uploadStatus: "PENDING" });

    expect(await listStudentMaterials(student.id)).toEqual([]);
  });

  it("hides a teacher's unshared material even when it names the class as its origin", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { student } = await createStudent();
    await enroll(cls.id, student.id);

    // classId set, but no MaterialClass link — the junction is the source of truth.
    await prisma.learningMaterial.create({
      data: {
        teacherId: teacher.id,
        classId: cls.id,
        originalName: "draft.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        storageKey: "k",
        bucket: "test-bucket",
        uploadStatus: "READY",
      },
    });

    expect(await listStudentMaterials(student.id)).toEqual([]);
  });
});

describe("getStudentMaterial", () => {
  it("returns the material with its pages for an enrolled student", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { student } = await createStudent();
    await enroll(cls.id, student.id);
    const material = await createMaterial(teacher.id, { classIds: [cls.id], pageCount: 3 });

    const found = await getStudentMaterial(student.id, material.id);
    expect(found?.pages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(found?.classes).toHaveLength(1);
  });

  it("returns null for a material in a class the student is not enrolled in", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { student } = await createStudent();
    const material = await createMaterial(teacher.id, { classIds: [cls.id] });

    expect(await getStudentMaterial(student.id, material.id)).toBeNull();
  });
});

describe("listStudentSimulations", () => {
  /**
   * The scenario from the feature request: one teacher, quizzes 1-10, assigned
   * 1-3 to class one, 4 to class two, 7-10 to class three. Each class must see
   * exactly its own quizzes' simulations.
   */
  async function seedThreeClasses() {
    const { teacher } = await createTeacher();
    const one = await createClass(teacher.id, "Class One");
    const two = await createClass(teacher.id, "Class Two");
    const three = await createClass(teacher.id, "Class Three");
    const assignment: Record<number, string[]> = {
      1: [one.id],
      2: [one.id],
      3: [one.id],
      4: [two.id],
      7: [three.id],
      8: [three.id],
      9: [three.id],
      10: [three.id],
    };
    for (let n = 1; n <= 10; n += 1) {
      await createQuizWithSimulation({
        teacherId: teacher.id,
        name: `Quiz ${n}`,
        classIds: assignment[n] ?? [],
        simTitle: `Sim ${n}`,
        order: n,
      });
    }
    return { teacher, one, two, three };
  }

  const titles = (groups: Awaited<ReturnType<typeof listStudentSimulations>>) =>
    groups.flatMap((g) => g.quizzes.flatMap((q) => q.simulations.map((s) => s.title)));

  it("gives each class only the simulations for the quizzes assigned to it", async () => {
    const { one, two, three } = await seedThreeClasses();

    const inOne = await createStudent();
    const inTwo = await createStudent();
    const inThree = await createStudent();
    await enroll(one.id, inOne.student.id);
    await enroll(two.id, inTwo.student.id);
    await enroll(three.id, inThree.student.id);

    expect(titles(await listStudentSimulations(inOne.student.id))).toEqual([
      "Sim 1",
      "Sim 2",
      "Sim 3",
    ]);
    expect(titles(await listStudentSimulations(inTwo.student.id))).toEqual(["Sim 4"]);
    expect(titles(await listStudentSimulations(inThree.student.id))).toEqual([
      "Sim 7",
      "Sim 8",
      "Sim 9",
      "Sim 10",
    ]);
  });

  it("never surfaces the quizzes assigned to no class (5, 6)", async () => {
    const { one, two, three } = await seedThreeClasses();
    const { student } = await createStudent();
    await enroll(one.id, student.id);
    await enroll(two.id, student.id);
    await enroll(three.id, student.id);

    const seen = titles(await listStudentSimulations(student.id));
    expect(seen).not.toContain("Sim 5");
    expect(seen).not.toContain("Sim 6");
    expect(seen).toHaveLength(8);
  });

  it("groups a student enrolled in several classes by class and quiz", async () => {
    const { one, two } = await seedThreeClasses();
    const { student } = await createStudent();
    await enroll(one.id, student.id);
    await enroll(two.id, student.id);

    const groups = await listStudentSimulations(student.id);
    expect(groups.map((g) => g.className)).toEqual(["Class One", "Class Two"]);
    expect(groups[0].quizzes.map((q) => q.quizName)).toEqual(["Quiz 1", "Quiz 2", "Quiz 3"]);
    expect(groups[1].quizzes.map((q) => q.quizName)).toEqual(["Quiz 4"]);
  });

  it("skips unpublished assignments and simulations that are not READY", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { student } = await createStudent();
    await enroll(cls.id, student.id);

    await createQuizWithSimulation({
      teacherId: teacher.id,
      name: "Unpublished",
      classIds: [cls.id],
      published: false,
    });
    await createQuizWithSimulation({
      teacherId: teacher.id,
      name: "Pending",
      classIds: [cls.id],
      status: "PENDING",
    });

    expect(await listStudentSimulations(student.id)).toEqual([]);
  });

  it("collapses same-topic simulations within one quiz", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { student } = await createStudent();
    await enroll(cls.id, student.id);

    const { quiz } = await createQuizWithSimulation({
      teacherId: teacher.id,
      name: "Waves",
      classIds: [cls.id],
      simTitle: "Wave interference",
    });
    // A second question of the same quiz whose simulation reads identically.
    const twin = await prisma.question.create({ data: { text: "Q2", quizId: quiz.id } });
    await prisma.questionSimulation.create({
      data: {
        questionId: twin.id,
        status: "READY",
        title: "Wave interference",
        topic: "Waves",
        storageKey: "simulations/twin/v1.html",
        bucket: "test-bucket",
        version: 1,
      },
    });

    const groups = await listStudentSimulations(student.id);
    expect(groups[0].quizzes[0].simulations).toHaveLength(1);
  });
});

describe("GET /api/student/materials/[materialId]/file", () => {
  const params = (materialId: string) => ({ params: Promise.resolve({ materialId }) });

  it("redirects an enrolled student to a signed URL", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { user, student } = await createStudent();
    await enroll(cls.id, student.id);
    const material = await createMaterial(teacher.id, { classIds: [cls.id] });

    asStudent(user.id);
    const res = await MATERIAL_FILE(req(), params(material.id));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("https://signed.test/");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("404s a student who is not enrolled in any class the material is shared with", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { user } = await createStudent();
    const material = await createMaterial(teacher.id, { classIds: [cls.id] });

    asStudent(user.id);
    expect((await MATERIAL_FILE(req(), params(material.id))).status).toBe(404);
  });

  it("401s a teacher (this endpoint is the student library's)", async () => {
    const { user, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const material = await createMaterial(teacher.id, { classIds: [cls.id] });

    mockAuth.mockResolvedValue({ user: { id: user.id, role: "TEACHER" } } as never);
    expect((await MATERIAL_FILE(req(), params(material.id))).status).toBe(401);
  });
});

describe("GET /api/student/materials/[materialId]/pages/[pageId]/image", () => {
  const params = (materialId: string, pageId: string) => ({
    params: Promise.resolve({ materialId, pageId }),
  });

  it("signs a page of a material shared with the student's class", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { user, student } = await createStudent();
    await enroll(cls.id, student.id);
    const material = await createMaterial(teacher.id, { classIds: [cls.id], pageCount: 2 });
    const page = await prisma.materialPage.findFirstOrThrow({
      where: { materialId: material.id, pageNumber: 1 },
    });

    asStudent(user.id);
    const res = await PAGE_IMAGE(req(), params(material.id, page.id));
    expect(res.status).toBe(200);
    expect((await res.json()).url).toContain("pages/1.png");
  });

  it("404s a page id belonging to a different material", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { user, student } = await createStudent();
    await enroll(cls.id, student.id);
    const mine = await createMaterial(teacher.id, { classIds: [cls.id], pageCount: 1 });
    const other = await createMaterial(teacher.id, { pageCount: 1, title: "Other" });
    const otherPage = await prisma.materialPage.findFirstOrThrow({
      where: { materialId: other.id },
    });

    asStudent(user.id);
    expect((await PAGE_IMAGE(req(), params(mine.id, otherPage.id))).status).toBe(404);
  });

  it("404s a student with no enrollment granting the material", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const { user } = await createStudent();
    const material = await createMaterial(teacher.id, { classIds: [cls.id], pageCount: 1 });
    const page = await prisma.materialPage.findFirstOrThrow({ where: { materialId: material.id } });

    asStudent(user.id);
    expect((await PAGE_IMAGE(req(), params(material.id, page.id))).status).toBe(404);
  });
});
