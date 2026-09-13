import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));

import { POST as SUBMIT } from "@/app/api/pool-submissions/route";
import { PATCH as DECIDE } from "@/app/api/pool-submissions/[id]/route";
import { auth } from "@/lib/auth";
import { sendEmail } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { createAdmin, createTeacher, resetDb } from "./db";

const mockAuth = vi.mocked(auth);
const mockSendEmail = vi.mocked(sendEmail);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

function request(body: unknown) {
  return new Request("https://talent.example/api/pool-submissions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockSendEmail.mockReset();
  mockSendEmail.mockResolvedValue({ sent: 1, failed: 0, errors: [] });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("global-pool approval requests", () => {
  it("lets a teacher choose an admin and emails a direct review link", async () => {
    const { user, teacher } = await createTeacher();
    const admin = await createAdmin({ email: "reviewer@example.com" });
    const quiz = await prisma.quiz.create({ data: { name: "For review", teacherId: teacher.id } });
    mockAuth.mockResolvedValue({ user: { id: user.id, role: "TEACHER" } } as never);

    const response = await SUBMIT(request({ contentType: "QUIZ", contentId: quiz.id, reviewerId: admin.id }));
    expect(response.status).toBe(201);
    const submission = await response.json();
    expect(submission.reviewerId).toBe(admin.id);
    expect(await prisma.poolSubmission.count({ where: { quizId: quiz.id, status: "PENDING" } })).toBe(1);
    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: ["reviewer@example.com"],
      text: expect.stringContaining(`/admin/pool-submissions?request=${submission.id}`),
    }));
  });

  it("rejects a non-admin reviewer and duplicate pending requests", async () => {
    const owner = await createTeacher();
    const otherTeacher = await createTeacher();
    const admin = await createAdmin();
    const quiz = await prisma.quiz.create({ data: { name: "For review", teacherId: owner.teacher.id } });
    mockAuth.mockResolvedValue({ user: { id: owner.user.id, role: "TEACHER" } } as never);

    expect((await SUBMIT(request({ contentType: "QUIZ", contentId: quiz.id, reviewerId: otherTeacher.user.id }))).status).toBe(404);
    expect((await SUBMIT(request({ contentType: "QUIZ", contentId: quiz.id, reviewerId: admin.id }))).status).toBe(201);
    expect((await SUBMIT(request({ contentType: "QUIZ", contentId: quiz.id, reviewerId: admin.id }))).status).toBe(409);
  });

  it("allows only the selected admin to approve and publishes an independent quiz copy", async () => {
    const owner = await createTeacher();
    const reviewer = await createAdmin();
    const otherAdmin = await createAdmin();
    const topic = await prisma.topic.create({ data: { name: "Physics", teacherId: null } });
    const quiz = await prisma.quiz.create({ data: { name: "For review", teacherId: owner.teacher.id } });
    await prisma.question.create({ data: { text: "Question", quizId: quiz.id } });
    const submission = await prisma.poolSubmission.create({
      data: {
        contentType: "QUIZ",
        teacherId: owner.teacher.id,
        reviewerId: reviewer.id,
        quizId: quiz.id,
        topicId: topic.id,
      },
    });

    mockAuth.mockResolvedValue({ user: { id: otherAdmin.id, role: "ADMIN" } } as never);
    expect((await DECIDE(request({ decision: "APPROVE" }), params(submission.id))).status).toBe(404);

    mockAuth.mockResolvedValue({ user: { id: reviewer.id, role: "ADMIN" } } as never);
    const response = await DECIDE(request({ decision: "APPROVE", note: "Looks good" }), params(submission.id));
    expect(response.status).toBe(200);
    const poolCopy = await prisma.quiz.findFirst({ where: { teacherId: null, sourceQuizId: quiz.id } });
    expect(poolCopy).toMatchObject({ name: "For review", topicId: topic.id });
    expect(await prisma.question.count({ where: { quizId: poolCopy!.id } })).toBe(1);
    expect(await prisma.poolSubmission.findUnique({ where: { id: submission.id } })).toMatchObject({
      status: "APPROVED",
      decisionNote: "Looks good",
    });
  });
});
