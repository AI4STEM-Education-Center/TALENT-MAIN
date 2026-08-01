import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueMessageEmails: vi.fn() }));

import { POST } from "@/app/api/classes/[id]/messages/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createClass, createStudent, createTeacher, resetDb } from "./db";

const mockAuth = vi.mocked(auth);

function messageRequest(recipientUserIds?: string[]) {
  return new Request("http://localhost/api/classes/class-id/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subject: "Class reminder",
      body: "Remember to review chapter three.",
      ...(recipientUserIds !== undefined ? { recipientUserIds } : {}),
    }),
  }) as never;
}

async function enroll(classId: string) {
  const result = await createStudent();
  await prisma.classEnrollment.create({
    data: { classId, studentId: result.student.id },
  });
  return result;
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("POST /api/classes/:id/messages recipient targeting", () => {
  it("sends an in-app notification to one selected student", async () => {
    const { user: teacherUser, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const first = await enroll(cls.id);
    const second = await enroll(cls.id);
    mockAuth.mockResolvedValue({ user: { id: teacherUser.id, role: "TEACHER" } } as never);

    const response = await POST(messageRequest([first.user.id]), {
      params: Promise.resolve({ id: cls.id }),
    });

    expect(response.status).toBe(201);
    expect((await response.json()).inApp.count).toBe(1);
    const notifications = await prisma.notification.findMany();
    expect(notifications.map((notification) => notification.userId)).toEqual([first.user.id]);
    expect(notifications.some((notification) => notification.userId === second.user.id)).toBe(false);
    expect(
      (await prisma.messageEmailDelivery.findMany()).map((delivery) => delivery.userId)
    ).toEqual([first.user.id]);
  });

  it("sends an in-app notification to a selected group", async () => {
    const { user: teacherUser, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const first = await enroll(cls.id);
    const second = await enroll(cls.id);
    const third = await enroll(cls.id);
    mockAuth.mockResolvedValue({ user: { id: teacherUser.id, role: "TEACHER" } } as never);

    const response = await POST(messageRequest([first.user.id, third.user.id]), {
      params: Promise.resolve({ id: cls.id }),
    });

    expect(response.status).toBe(201);
    const recipientIds = (await prisma.notification.findMany()).map((notification) => notification.userId).sort();
    expect(recipientIds).toEqual([first.user.id, third.user.id].sort());
    expect(recipientIds).not.toContain(second.user.id);
  });

  it("sends to the whole class when no selection is supplied", async () => {
    const { user: teacherUser, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const first = await enroll(cls.id);
    const second = await enroll(cls.id);
    mockAuth.mockResolvedValue({ user: { id: teacherUser.id, role: "TEACHER" } } as never);

    const response = await POST(messageRequest(), {
      params: Promise.resolve({ id: cls.id }),
    });

    expect(response.status).toBe(201);
    const recipientIds = (await prisma.notification.findMany()).map((notification) => notification.userId).sort();
    expect(recipientIds).toEqual([first.user.id, second.user.id].sort());
  });

  it("rejects a selected student who is not enrolled in the class", async () => {
    const { user: teacherUser, teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    await enroll(cls.id);
    const outsider = await createStudent();
    mockAuth.mockResolvedValue({ user: { id: teacherUser.id, role: "TEACHER" } } as never);

    const response = await POST(messageRequest([outsider.user.id]), {
      params: Promise.resolve({ id: cls.id }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "One or more selected students are not enrolled in this class.",
    });
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.message.count()).toBe(0);
  });
});
