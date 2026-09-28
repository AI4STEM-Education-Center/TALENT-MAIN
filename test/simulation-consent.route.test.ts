import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  getS3ObjectAsString: vi.fn(
    async () => "<html><body><button>Run simulation</button></body></html>",
  ),
}));

import { GET as content } from "@/app/api/simulations/[id]/content/route";
import { POST as openSession } from "@/app/api/simulations/[id]/sessions/route";
import { POST as updateSession } from "@/app/api/simulations/[id]/sessions/[sessionId]/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createStudent, createTeacher, resetDb } from "./db";

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});
afterAll(() => prisma.$disconnect());
const request = (body: unknown) =>
  new NextRequest("http://localhost/api/simulations/s/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const batch = {
  dwellMs: 1000,
  activeMs: 500,
  interactionCount: 2,
  paramChanges: 1,
  ended: true,
};

async function setup(decision: "AGREE" | "DECLINE" | null) {
  const { user, student } = await createStudent();
  const { teacher } = await createTeacher();
  const cls = await prisma.class.create({
    data: { name: "Physics", teacherId: teacher.id },
  });
  const quiz = await prisma.quiz.create({
    data: { name: "Forces", teacherId: teacher.id },
  });
  const question = await prisma.question.create({
    data: { text: "Forces?", quizId: quiz.id },
  });
  const sim = await prisma.questionSimulation.create({
    data: {
      questionId: question.id,
      status: "READY",
      storageKey: "sim.html",
      bucket: "test-bucket",
    },
  });
  await prisma.classQuiz.create({ data: { classId: cls.id, quizId: quiz.id } });
  await prisma.classEnrollment.create({
    data: { classId: cls.id, studentId: student.id },
  });
  const form = await prisma.consentFormVersion.create({
    data: {
      role: "STUDENT",
      version: "v1",
      title: "Consent",
      bodyHtml: "<p>Consent</p>",
      isActive: true,
    },
  });
  if (decision)
    await prisma.consentRecord.create({
      data: {
        userId: user.id,
        formVersionId: form.id,
        decision,
        role: "STUDENT",
        signatureTypedName: "Stu",
        ipAddress: "127.0.0.1",
        userAgent: "test",
        deviceType: "desktop",
        signerNameSnapshot: "Stu",
        signerEmailSnapshot: user.email,
      },
    });
  vi.mocked(auth).mockResolvedValue({
    user: { id: user.id, role: "STUDENT" },
  } as never);
  return {
    user,
    sim,
    form,
    params: { params: Promise.resolve({ id: sim.id }) },
  };
}

describe("simulation access without research collection", () => {
  it.each(["DECLINE", null] as const)(
    "serves interactive content but collects no telemetry for %s",
    async (decision) => {
      const { sim, params } = await setup(decision);
      const response = await content(
        new NextRequest(`http://localhost/api/simulations/${sim.id}/content`),
        params,
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Run simulation");
      expect(html).not.toContain("__simTelemetryInstalled");
      expect(
        await (
          await openSession(request({ surface: "library" }), params)
        ).json(),
      ).toEqual({ sessionId: null });
      expect(await prisma.simulationSession.count()).toBe(0);
    },
  );

  it("collects for agreement and stops accepting batches once consent is declined", async () => {
    const { user, sim, params } = await setup("AGREE");
    const response = await content(
      new NextRequest(`http://localhost/api/simulations/${sim.id}/content`),
      params,
    );
    expect(await response.text()).toContain("__simTelemetryInstalled");
    const opened = await openSession(request({ surface: "library" }), params);
    expect(opened.status).toBe(201);
    const { sessionId } = await opened.json();
    const context = { params: Promise.resolve({ id: sim.id, sessionId }) };
    expect((await updateSession(request(batch), context)).status).toBe(200);
    const before = await prisma.simulationSession.findUniqueOrThrow({
      where: { id: sessionId },
    });
    expect(before.interactionCount).toBe(2);
    await prisma.consentRecord.updateMany({
      where: { userId: user.id },
      data: { decision: "DECLINE" },
    });
    expect(
      (
        await updateSession(
          request({ ...batch, dwellMs: 2000, interactionCount: 10 }),
          context,
        )
      ).status,
    ).toBe(200);
    expect(
      await prisma.simulationSession.findUniqueOrThrow({
        where: { id: sessionId },
      }),
    ).toEqual(before);
  });
});
