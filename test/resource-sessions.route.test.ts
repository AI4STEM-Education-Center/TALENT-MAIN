import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { POST as openSession } from "@/app/api/student/materials/[materialId]/sessions/route";
import {
  PATCH as patchSession,
  POST as beaconSession,
} from "@/app/api/student/materials/[materialId]/sessions/[sessionId]/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveRecommendationMaterialIds } from "@/lib/exam-results-engine";
import {
  getAdminResourceEngagement,
  getStudentResourceSessions,
} from "@/lib/resource-engagement-server";
import { createClass, createStudent, createTeacher, resetDb } from "./db";

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});
afterAll(() => prisma.$disconnect());

const json = (body: unknown, method = "POST") =>
  new NextRequest("http://localhost/api/student/materials/m/sessions", {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const openParams = (materialId: string) => ({
  params: Promise.resolve({ materialId }),
});
const batchParams = (materialId: string, sessionId: string) => ({
  params: Promise.resolve({ materialId, sessionId }),
});

function as(userId: string, role = "STUDENT") {
  vi.mocked(auth).mockResolvedValue({ user: { id: userId, role } } as never);
}

async function consent(userId: string, email: string, decision = "AGREE") {
  const form =
    (await prisma.consentFormVersion.findFirst({
      where: { isActive: true },
    })) ??
    (await prisma.consentFormVersion.create({
      data: {
        role: "STUDENT",
        version: "v1",
        title: "Consent",
        bodyHtml: "<p>Consent</p>",
        isActive: true,
      },
    }));
  await prisma.consentRecord.create({
    data: {
      userId,
      formVersionId: form.id,
      decision,
      role: "STUDENT",
      signatureTypedName: "Stu",
      ipAddress: "127.0.0.1",
      userAgent: "test",
      deviceType: "desktop",
      signerNameSnapshot: "Stu",
      signerEmailSnapshot: email,
    },
  });
}

async function createMaterial(teacherId: string, classIds: string[]) {
  const material = await prisma.learningMaterial.create({
    data: {
      teacherId,
      title: "Kinematics notes",
      originalName: "notes.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
      storageKey: `materials/${teacherId}/${Math.random()}.pdf`,
      bucket: "test-bucket",
      uploadStatus: "READY",
      totalPages: 3,
      classLinks: { create: classIds.map((classId) => ({ classId })) },
    },
  });
  for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
    await prisma.materialPage.create({
      data: {
        materialId: material.id,
        pageNumber,
        storageKey: `pages/${material.id}/${pageNumber}.png`,
      },
    });
  }
  return material;
}

async function examResult(opts: {
  attemptId: string;
  studentId: string;
  classId: string;
  items: unknown[];
}) {
  return prisma.examResult.create({
    data: {
      quizAttemptId: opts.attemptId,
      studentId: opts.studentId,
      classId: opts.classId,
      quizId: "quiz-1",
      className: "Physics",
      topicName: "Motion",
      quizName: "Forces",
      score: 50,
      correctCount: 1,
      totalCount: 2,
      completedAt: new Date(),
      reviewSnapshot: "[]",
      recommendations: JSON.stringify({ items: opts.items, truncated: false }),
      recommendationsStatus: "READY",
    },
  });
}

async function setup() {
  const { user, student } = await createStudent();
  const { teacher } = await createTeacher();
  const cls = await createClass(teacher.id);
  await prisma.classEnrollment.create({
    data: { classId: cls.id, studentId: student.id },
  });
  const material = await createMaterial(teacher.id, [cls.id]);
  as(user.id);
  return { user, student, teacher, cls, material };
}

describe("opening a learning-resource session", () => {
  it("records nothing for a student without research consent", async () => {
    const { material } = await setup();
    const res = await openSession(
      json({ surface: "materials_library" }),
      openParams(material.id),
    );
    expect(await res.json()).toEqual({ sessionId: null });
    expect(await prisma.learningResourceSession.count()).toBe(0);
  });

  it("rejects staff: teacher/admin reading is never recorded", async () => {
    const { material } = await setup();
    const { user: teacherUser } = await createTeacher();
    as(teacherUser.id, "TEACHER");
    const res = await openSession(
      json({ surface: "materials_library" }),
      openParams(material.id),
    );
    expect(res.status).toBe(403);
  });

  it("records a self-directed library open with the class context and ignores attemptId", async () => {
    const { user, student, cls, material } = await setup();
    await consent(user.id, user.email);
    const res = await openSession(
      json({ surface: "materials_library", attemptId: "someone-elses" }),
      openParams(material.id),
    );
    expect(res.status).toBe(201);
    const { sessionId } = await res.json();
    const row = await prisma.learningResourceSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(row).toMatchObject({
      studentId: student.id,
      materialId: material.id,
      materialTitle: "Kinematics notes",
      classId: cls.id,
      attemptId: null,
      surface: "materials_library",
      recommended: false,
      pageStart: null,
    });
  });

  it("404s a library open of a material outside the student's classes", async () => {
    const { user, teacher } = await setup();
    await consent(user.id, user.email);
    const otherClass = await createClass(teacher.id, "Chemistry");
    const foreign = await createMaterial(teacher.id, [otherClass.id]);
    const res = await openSession(
      json({ surface: "materials_library" }),
      openParams(foreign.id),
    );
    expect(res.status).toBe(404);
    expect(await prisma.learningResourceSession.count()).toBe(0);
  });

  it("records a verified recommendation with range, class and quiz from the snapshot", async () => {
    const { user, student, cls, material } = await setup();
    await consent(user.id, user.email);
    await examResult({
      attemptId: "attempt-1",
      studentId: student.id,
      classId: cls.id,
      items: [
        {
          materialId: material.id,
          materialTitle: "Kinematics notes",
          pageRange: { start: 2, end: 3 },
          reason: "Review motion",
          pages: [{ pageNumber: 2, storageKey: `pages/${material.id}/2.png` }],
        },
      ],
    });
    const res = await openSession(
      json({ surface: "history_recommendation", attemptId: "attempt-1" }),
      openParams(material.id),
    );
    expect(res.status).toBe(201);
    const row = await prisma.learningResourceSession.findFirstOrThrow();
    expect(row).toMatchObject({
      recommended: true,
      surface: "history_recommendation",
      attemptId: "attempt-1",
      classId: cls.id,
      quizId: "quiz-1",
      pageStart: 2,
      pageEnd: 3,
    });
  });

  it("verifies legacy snapshots (no materialId) through page storage keys", async () => {
    const { user, student, cls, material } = await setup();
    await consent(user.id, user.email);
    const items = [
      {
        materialTitle: "Kinematics notes",
        pageRange: { start: 1, end: 1 },
        reason: "",
        pages: [{ pageNumber: 1, storageKey: `pages/${material.id}/1.png` }],
      },
    ];
    await examResult({
      attemptId: "attempt-legacy",
      studentId: student.id,
      classId: cls.id,
      items,
    });
    expect(await resolveRecommendationMaterialIds(items)).toEqual([
      material.id,
    ]);
    const res = await openSession(
      json({ surface: "results_recommendation", attemptId: "attempt-legacy" }),
      openParams(material.id),
    );
    expect(res.status).toBe(201);
  });

  it("refuses to record a recommendation the attempt never made, or someone else's attempt", async () => {
    const { user, student, teacher, cls, material } = await setup();
    await consent(user.id, user.email);
    const other = await createMaterial(teacher.id, [cls.id]);
    await examResult({
      attemptId: "attempt-1",
      studentId: student.id,
      classId: cls.id,
      items: [
        {
          materialId: other.id,
          materialTitle: "Other",
          pageRange: { start: 1, end: 1 },
          reason: "",
          pages: [],
        },
      ],
    });
    const { student: classmate } = await createStudent();
    await examResult({
      attemptId: "attempt-classmate",
      studentId: classmate.id,
      classId: cls.id,
      items: [
        {
          materialId: material.id,
          materialTitle: "Kinematics notes",
          pageRange: { start: 1, end: 1 },
          reason: "",
          pages: [],
        },
      ],
    });
    for (const body of [
      { surface: "results_recommendation", attemptId: "attempt-1" },
      { surface: "results_recommendation", attemptId: "attempt-classmate" },
      { surface: "results_recommendation" },
    ]) {
      const res = await openSession(json(body), openParams(material.id));
      expect(res.status).toBe(404);
    }
    expect(await prisma.learningResourceSession.count()).toBe(0);
  });

  it("rejects unknown surfaces", async () => {
    const { user, material } = await setup();
    await consent(user.id, user.email);
    const res = await openSession(
      json({ surface: "class_page" }),
      openParams(material.id),
    );
    expect(res.status).toBe(400);
  });
});

describe("recording telemetry batches", () => {
  async function opened() {
    const ctx = await setup();
    await consent(ctx.user.id, ctx.user.email);
    const res = await openSession(
      json({ surface: "materials_library" }),
      openParams(ctx.material.id),
    );
    const { sessionId } = await res.json();
    // Backdate the open so the wall-clock bound allows a minute of dwell.
    await prisma.learningResourceSession.update({
      where: { id: sessionId },
      data: { openedAt: new Date(Date.now() - 60_000) },
    });
    return { ...ctx, sessionId: sessionId as string };
  }

  const batch = {
    dwellMs: 30_000,
    activeMs: 20_000,
    clickCount: 4,
    pdfOpenCount: 1,
    pages: { "1": 10_000, "2": 20_000 },
  };

  it("merges cumulative totals monotonically via PATCH and beacon POST", async () => {
    const { material, sessionId } = await opened();
    expect(
      (
        await patchSession(
          json(batch, "PATCH"),
          batchParams(material.id, sessionId),
        )
      ).status,
    ).toBe(200);
    // A stale batch arriving late (fetch/beacon race) must not move it back.
    await beaconSession(
      json({
        ...batch,
        dwellMs: 10_000,
        clickCount: 1,
        pages: { "3": 500 },
        ended: true,
      }),
      batchParams(material.id, sessionId),
    );
    const row = await prisma.learningResourceSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(row).toMatchObject({
      dwellMs: 30_000,
      activeMs: 20_000,
      clickCount: 4,
      pdfOpenCount: 1,
      pagesViewed: 3,
    });
    expect(JSON.parse(row.pagesViewedJson!)).toEqual({
      "1": 10_000,
      "2": 20_000,
      "3": 500,
    });
    expect(row.endedAt).not.toBeNull();
  });

  it("clamps dwell to the time since the session opened", async () => {
    const { material, sessionId } = await opened();
    await patchSession(
      json({ ...batch, dwellMs: 3_000_000, activeMs: 3_000_000 }, "PATCH"),
      batchParams(material.id, sessionId),
    );
    const row = await prisma.learningResourceSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(row.dwellMs).toBeLessThan(70_000);
    expect(row.activeMs).toBe(row.dwellMs);
  });

  it("404s another student's session and a mismatched material", async () => {
    const { material, sessionId } = await opened();
    const { user: other } = await createStudent();
    await consent(other.id, other.email);
    as(other.id);
    expect(
      (
        await patchSession(
          json(batch, "PATCH"),
          batchParams(material.id, sessionId),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await patchSession(
          json(batch, "PATCH"),
          batchParams("other-material", sessionId),
        )
      ).status,
    ).toBe(404);
  });

  it("stops recording once consent is withdrawn", async () => {
    const { user, material, sessionId } = await opened();
    await consent(user.id, user.email, "DECLINE");
    const res = await patchSession(
      json(batch, "PATCH"),
      batchParams(material.id, sessionId),
    );
    expect(await res.json()).toEqual({ ok: true });
    const row = await prisma.learningResourceSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(row.dwellMs).toBe(0);
  });
});

describe("engagement reports", () => {
  it("aggregates per material and scopes a student's sessions to the class's materials", async () => {
    const { student, teacher, cls, material } = await setup();
    const otherClass = await createClass(teacher.id, "Chemistry");
    const otherMaterial = await createMaterial(teacher.id, [otherClass.id]);
    await prisma.learningResourceSession.createMany({
      data: [
        {
          studentId: student.id,
          materialId: material.id,
          materialTitle: "Kinematics notes",
          classId: cls.id,
          surface: "results_recommendation",
          recommended: true,
          pageStart: 1,
          pageEnd: 2,
          dwellMs: 12_000,
          clickCount: 2,
        },
        {
          // Library open of a material shared with several classes.
          studentId: student.id,
          materialId: material.id,
          surface: "materials_library",
          dwellMs: 4_000,
        },
        {
          studentId: student.id,
          materialId: otherMaterial.id,
          classId: otherClass.id,
          surface: "materials_library",
        },
      ],
    });

    const report = await getAdminResourceEngagement("all");
    expect(report).toMatchObject({
      opens: 3,
      uniqueStudents: 1,
      recommendedOpens: 1,
    });
    expect(report.materials[0]).toMatchObject({
      materialId: material.id,
      opens: 2,
      recommendedOpens: 1,
      selfDirectedOpens: 1,
    });

    const rows = await getStudentResourceSessions(cls.id, student.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.title === "Kinematics notes")).toBe(true);
    expect(rows.find((r) => r.recommended)?.pageRange).toBe("pp. 1–2");
  });
});
