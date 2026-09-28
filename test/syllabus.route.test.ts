import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Auth is mocked per test. Storage keeps its PURE key builders real (the exact
// key checks are under test) with the network helpers stubbed; the queue and
// the model call are stubbed so the engine can be driven directly.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage")>();
  return {
    ...actual,
    presignPutUpload: vi.fn(async () => "https://s3.example/put"),
    headS3Object: vi.fn(async () => ({ contentLength: 1024 })),
    resolveModelImageUrl: vi.fn(async () => "https://s3.example/page.webp"),
  };
});
vi.mock("@/lib/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queue")>()),
  enqueueSyllabusExtraction: vi.fn(),
}));
vi.mock("@/lib/ai-provider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-provider")>()),
  resolveProvider: vi.fn(),
  createOpenAIClient: vi.fn(async () => ({})),
}));
vi.mock("@/lib/ai-streaming", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ai-streaming")>()),
  streamJsonCompletion: vi.fn(),
}));

import {
  DELETE as syllabusDelete,
  GET as syllabusGet,
  POST as syllabusPost,
  PUT as syllabusPut,
} from "@/app/api/classes/[id]/syllabus/route";
import { POST as pagesPost } from "@/app/api/classes/[id]/syllabus/pages/route";
import { POST as completePost } from "@/app/api/classes/[id]/syllabus/complete/route";
import { POST as retryPost } from "@/app/api/classes/[id]/syllabus/retry/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { enqueueSyllabusExtraction } from "@/lib/queue";
import { resolveProvider } from "@/lib/ai-provider";
import { streamJsonCompletion } from "@/lib/ai-streaming";
import { runSyllabusExtraction } from "@/lib/syllabus-engine";
import { addDays, isoDay } from "@/lib/syllabus";
import { listSkills } from "@/lib/assistant/skills";
import type { AssistantToolContext } from "@/lib/assistant/types";
import { createClass, createStudent, createTeacher, resetDb } from "./db";

const mockAuth = vi.mocked(auth);
const as = (userId: string, role: "TEACHER" | "STUDENT") =>
  mockAuth.mockResolvedValue({ user: { id: userId, role } } as never);

function req(method: string, body?: unknown) {
  return new Request("http://localhost/api/classes/c/syllabus", {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }) as never;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const EXTRACTED = {
  course_title: "Intro Physics",
  course_code: "PHYS 1111",
  term: "Fall 2026",
  meeting_info: null,
  description: null,
  contacts: [],
  learning_objectives: [],
  required_materials: [],
  grading: [{ component: "Midterm", weight: "30%" }],
  grading_scale: null,
  policies: [{ title: "Late work", body: "10% off per day." }],
  schedule: [
    {
      date: "2026-10-20",
      end_date: null,
      date_text: null,
      title: "Midterm exam",
      type: "exam",
      details: null,
    },
  ],
  other_info: [],
  warnings: ["Year inferred from the term."],
};

/** Walk a teacher through POST -> pages -> complete for a 2-page PDF. */
async function uploadSyllabus(classId: string) {
  const init = await (
    await syllabusPost(
      req("POST", { originalName: "syllabus.pdf", sizeBytes: 2048 }),
      ctx(classId),
    )
  ).json();
  const pages = await (
    await pagesPost(
      req("POST", {
        revision: init.revision,
        pages: [1, 2].map((pageNumber) => ({
          pageNumber,
          sizeBytes: 512,
          contentType: "image/webp",
        })),
      }),
      ctx(classId),
    )
  ).json();
  const complete = await completePost(
    req("POST", {
      revision: init.revision,
      pages: pages.pages.map(
        (p: { pageNumber: number; storageKey: string }) => ({
          pageNumber: p.pageNumber,
          storageKey: p.storageKey,
        }),
      ),
    }),
    ctx(classId),
  );
  return { init, pages: pages.pages, complete };
}

async function setup() {
  const { user: teacherUser, teacher } = await createTeacher();
  const cls = await createClass(teacher.id);
  const { user: studentUser, student } = await createStudent();
  await prisma.classEnrollment.create({
    data: { classId: cls.id, studentId: student.id },
  });
  return { teacherUser, teacher, cls, studentUser, student };
}

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  process.env.AWS_S3_BUCKET = "test-bucket";
  process.env.AWS_REGION = "us-east-1";
  vi.mocked(resolveProvider).mockResolvedValue({
    providerType: "openai",
    apiKey: "sk-test",
    baseUrl: null,
    model: "vision-model",
    serviceTier: null,
    thinkingLevel: null,
  } as never);
  vi.mocked(streamJsonCompletion).mockResolvedValue({
    value: EXTRACTED,
    metrics: { model: "vision-model", completionTokens: 100 },
  } as never);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("syllabus upload lifecycle", () => {
  it("uploads, queues extraction, and lands READY content", async () => {
    const { teacherUser, cls } = await setup();
    as(teacherUser.id, "TEACHER");

    const { init, complete } = await uploadSyllabus(cls.id);
    expect(init.revision).toBe(1);
    expect(complete.status).toBe(202);
    expect(enqueueSyllabusExtraction).toHaveBeenCalledWith(
      expect.any(String),
      1,
    );

    const row = await prisma.classSyllabus.findUniqueOrThrow({
      where: { classId: cls.id },
    });
    expect(row).toMatchObject({
      status: "EXTRACTING",
      sourceRevision: 1,
      totalPages: 2,
      originalName: "syllabus.pdf",
      pendingStorageKey: null,
    });

    await runSyllabusExtraction(row.id, 1);
    const view = await (await syllabusGet(req("GET"), ctx(cls.id))).json();
    expect(view.syllabus.status).toBe("READY");
    expect(view.syllabus.content.courseCode).toBe("PHYS 1111");
    expect(view.syllabus.warnings).toEqual(["Year inferred from the term."]);
  });

  it("rejects a page key outside this revision's directory", async () => {
    const { teacherUser, cls } = await setup();
    as(teacherUser.id, "TEACHER");
    const init = await (
      await syllabusPost(
        req("POST", { originalName: "s.pdf", sizeBytes: 10 }),
        ctx(cls.id),
      )
    ).json();
    const res = await completePost(
      req("POST", {
        revision: init.revision,
        pages: [
          { pageNumber: 1, storageKey: "learning-materials/x/y/z/page-1.png" },
        ],
      }),
      ctx(cls.id),
    );
    expect(res.status).toBe(400);
    expect(enqueueSyllabusExtraction).not.toHaveBeenCalled();
  });

  it("refuses to finish an upload a newer one replaced", async () => {
    const { teacherUser, cls } = await setup();
    as(teacherUser.id, "TEACHER");
    const first = await (
      await syllabusPost(
        req("POST", { originalName: "a.pdf", sizeBytes: 10 }),
        ctx(cls.id),
      )
    ).json();
    await syllabusPost(
      req("POST", { originalName: "b.pdf", sizeBytes: 10 }),
      ctx(cls.id),
    );
    const res = await pagesPost(
      req("POST", {
        revision: first.revision,
        pages: [{ pageNumber: 1, sizeBytes: 5, contentType: "image/webp" }],
      }),
      ctx(cls.id),
    );
    expect(res.status).toBe(409);
  });

  it("keeps the current content until a new version finishes extracting", async () => {
    const { teacherUser, cls } = await setup();
    as(teacherUser.id, "TEACHER");
    await uploadSyllabus(cls.id);
    const row = await prisma.classSyllabus.findUniqueOrThrow({
      where: { classId: cls.id },
    });
    await runSyllabusExtraction(row.id, 1);

    // A second version: upload completes, extraction is queued but not run.
    const second = await uploadSyllabus(cls.id);
    expect(second.init.revision).toBe(2);
    const mid = await prisma.classSyllabus.findUniqueOrThrow({
      where: { classId: cls.id },
    });
    expect(mid.status).toBe("EXTRACTING");
    expect(mid.content).toContain("PHYS 1111");

    // The stale revision-1 job waking up late must not touch revision 2.
    vi.mocked(streamJsonCompletion).mockResolvedValue({
      value: { ...EXTRACTED, course_code: "STALE" },
      metrics: {},
    } as never);
    await runSyllabusExtraction(row.id, 1);
    expect(
      (await prisma.classSyllabus.findUniqueOrThrow({ where: { id: row.id } }))
        .content,
    ).not.toContain("STALE");
  });

  it("records a failure without losing the previous content", async () => {
    const { teacherUser, cls } = await setup();
    as(teacherUser.id, "TEACHER");
    await uploadSyllabus(cls.id);
    const row = await prisma.classSyllabus.findUniqueOrThrow({
      where: { classId: cls.id },
    });
    await runSyllabusExtraction(row.id, 1);

    await retryPost(req("POST"), ctx(cls.id));
    vi.mocked(streamJsonCompletion).mockRejectedValue(
      new Error("upstream 500"),
    );
    await runSyllabusExtraction(row.id, 1);

    const after = await prisma.classSyllabus.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe("FAILED");
    expect(after.errorMessage).toContain("upstream 500");
    expect(after.content).toContain("PHYS 1111");
  });

  it("fails clearly when no model is assigned", async () => {
    const { teacherUser, cls } = await setup();
    as(teacherUser.id, "TEACHER");
    vi.mocked(resolveProvider).mockResolvedValue(null);
    await uploadSyllabus(cls.id);
    const row = await prisma.classSyllabus.findUniqueOrThrow({
      where: { classId: cls.id },
    });
    await runSyllabusExtraction(row.id, 1);
    const after = await prisma.classSyllabus.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe("FAILED");
    expect(after.errorMessage).toMatch(/Syllabus PDF Extraction/);
  });
});

describe("syllabus access and edits", () => {
  async function withContent() {
    const s = await setup();
    await prisma.classSyllabus.create({
      data: {
        classId: s.cls.id,
        teacherId: s.teacher.id,
        bucket: "test-bucket",
        status: "READY",
        sourceRevision: 1,
        storageKey: "syllabi/t/c/s/r1/syllabus.pdf",
        errorMessage: "internal detail",
        content: JSON.stringify({ courseTitle: "Intro Physics" }),
        extractedAt: new Date(),
      },
    });
    return s;
  }

  it("shows an enrolled student the content and none of the pipeline", async () => {
    const { studentUser, cls } = await withContent();
    as(studentUser.id, "STUDENT");
    const body = await (await syllabusGet(req("GET"), ctx(cls.id))).json();
    expect(body.syllabus.content.courseTitle).toBe("Intro Physics");
    expect(body.syllabus).not.toHaveProperty("errorMessage");
    expect(body.syllabus).not.toHaveProperty("status");
  });

  it("hides the syllabus from a student who isn't enrolled", async () => {
    const { cls } = await withContent();
    const { user } = await createStudent();
    as(user.id, "STUDENT");
    expect((await syllabusGet(req("GET"), ctx(cls.id))).status).toBe(404);
  });

  it("hides it from another teacher, and refuses them every write", async () => {
    const { cls } = await withContent();
    const { user } = await createTeacher();
    as(user.id, "TEACHER");
    expect((await syllabusGet(req("GET"), ctx(cls.id))).status).toBe(404);
    expect(
      (await syllabusPut(req("PUT", { content: {} }), ctx(cls.id))).status,
    ).toBe(404);
    expect((await syllabusDelete(req("DELETE"), ctx(cls.id))).status).toBe(404);
  });

  it("refuses edits from a student", async () => {
    const { studentUser, cls } = await withContent();
    as(studentUser.id, "STUDENT");
    expect(
      (await syllabusPut(req("PUT", { content: {} }), ctx(cls.id))).status,
    ).toBe(401);
  });

  it("normalizes and stores a teacher's edit", async () => {
    const { teacherUser, cls } = await withContent();
    as(teacherUser.id, "TEACHER");
    const res = await syllabusPut(
      req("PUT", {
        content: {
          courseTitle: "  Physics I  ",
          schedule: [
            { title: "Final", date: "2026-12-10", type: "exam" },
            { title: "" },
          ],
          injected: "ignored",
        },
      }),
      ctx(cls.id),
    );
    expect(res.status).toBe(200);
    const { syllabus } = await res.json();
    expect(syllabus.content.courseTitle).toBe("Physics I");
    expect(syllabus.content.schedule).toHaveLength(1);
    expect(syllabus.content).not.toHaveProperty("injected");
    expect(syllabus.editedAt).not.toBeNull();
  });

  it("won't take an edit while an extraction is about to replace it", async () => {
    const { teacherUser, cls } = await withContent();
    await prisma.classSyllabus.update({
      where: { classId: cls.id },
      data: { status: "EXTRACTING" },
    });
    as(teacherUser.id, "TEACHER");
    expect(
      (await syllabusPut(req("PUT", { content: {} }), ctx(cls.id))).status,
    ).toBe(409);
  });
});

describe("syllabus assistant tools", () => {
  function tool(audience: "student" | "teacher", name: string) {
    const found = listSkills(audience)
      .flatMap((skill) => skill.tools)
      .find((t) => t.name === name);
    if (!found) throw new Error(`no tool ${name}`);
    return (args: unknown, context: AssistantToolContext) =>
      found.handler(found.input.parse(args) as never, context) as Promise<
        Record<string, unknown>
      >;
  }

  async function seeded() {
    const s = await setup();
    const today = isoDay(new Date());
    await prisma.classSyllabus.create({
      data: {
        classId: s.cls.id,
        teacherId: s.teacher.id,
        bucket: "b",
        status: "READY",
        content: JSON.stringify({
          courseTitle: "Intro Physics",
          schedule: [
            { title: "Quiz 2", date: addDays(today, 3), type: "quiz" },
            { title: "Final", date: addDays(today, 60), type: "exam" },
          ],
        }),
      },
    });
    const studentCtx: AssistantToolContext = {
      userId: s.studentUser.id,
      audience: "student",
      studentId: s.student.id,
      teacherId: null,
    };
    const teacherCtx: AssistantToolContext = {
      userId: s.teacherUser.id,
      audience: "teacher",
      studentId: null,
      teacherId: s.teacher.id,
    };
    return { ...s, studentCtx, teacherCtx };
  }

  it("lets an enrolled student read the syllabus and upcoming dates", async () => {
    const { cls, studentCtx } = await seeded();
    const listed = await tool("student", "list_syllabi")({}, studentCtx);
    expect(listed.classes).toEqual([
      expect.objectContaining({ classId: cls.id, hasSyllabus: true }),
    ]);
    const full = await tool("student", "get_syllabus")(
      { classId: cls.id },
      studentCtx,
    );
    expect(full.found).toBe(true);
    const dates = await tool("student", "get_syllabus_dates")({}, studentCtx);
    expect(
      (dates.events as Array<{ title: string }>).map((e) => e.title),
    ).toEqual(["Quiz 2"]);
  });

  it("won't read a class the student isn't enrolled in", async () => {
    const { cls } = await seeded();
    const { user, student } = await createStudent();
    const out = await tool("student", "get_syllabus")(
      { classId: cls.id },
      {
        userId: user.id,
        audience: "student",
        studentId: student.id,
        teacherId: null,
      },
    );
    expect(out.found).toBe(false);
    expect(out).not.toHaveProperty("syllabus");
  });

  it("scopes the teacher tools to the teacher's own classes", async () => {
    const { cls, teacherCtx } = await seeded();
    const own = await tool("teacher", "get_class_syllabus")(
      { classId: cls.id },
      teacherCtx,
    );
    expect(own.found).toBe(true);

    const { teacher } = await createTeacher();
    const other = await tool("teacher", "get_class_syllabus")(
      { classId: cls.id },
      { ...teacherCtx, teacherId: teacher.id },
    );
    expect(other.found).toBe(false);
  });
});
