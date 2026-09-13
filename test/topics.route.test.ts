import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET, POST, PATCH, DELETE } from "@/app/api/topics/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resetDb, createTeacher } from "./db";

const mockAuth = vi.mocked(auth);

function jsonReq(body: unknown) {
  return new Request("http://localhost/api/topics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;
}

function asTeacher(userId: string) {
  mockAuth.mockResolvedValue({ user: { id: userId, role: "TEACHER" } } as never);
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("GET /api/topics", () => {
  it("401s an unauthenticated caller", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await GET()).status).toBe(401);
  });

  it("returns only the teacher's own topics, ordered", async () => {
    const { user, teacher } = await createTeacher();
    const other = await createTeacher();
    await prisma.topic.create({ data: { name: "Mine B", order: 2, teacherId: teacher.id } });
    await prisma.topic.create({ data: { name: "Mine A", order: 1, teacherId: teacher.id } });
    await prisma.topic.create({ data: { name: "Theirs", teacherId: other.teacher.id } });

    asTeacher(user.id);
    const body = await (await GET()).json();
    expect(body.map((t: { name: string }) => t.name)).toEqual(["Mine A", "Mine B"]);
    expect(body[0]).toHaveProperty("_count");
  });

  it("keeps quiz and material tag namespaces separate", async () => {
    const { user, teacher } = await createTeacher();
    await prisma.topic.create({ data: { name: "Quiz tag", teacherId: teacher.id, contentType: "QUIZ" } });
    await prisma.topic.create({ data: { name: "Material tag", teacherId: teacher.id, contentType: "MATERIAL" } });

    asTeacher(user.id);
    const quizTags = await (await GET()).json();
    const materialTags = await (
      await GET(new NextRequest("http://localhost/api/topics?contentType=MATERIAL"))
    ).json();
    expect(quizTags.map((tag: { name: string }) => tag.name)).toEqual(["Quiz tag"]);
    expect(materialTags.map((tag: { name: string }) => tag.name)).toEqual(["Material tag"]);
  });
});

describe("POST /api/topics", () => {
  it("requires a non-empty name", async () => {
    const { user } = await createTeacher();
    asTeacher(user.id);
    expect((await POST(jsonReq({ name: "   " }))).status).toBe(400);
  });

  it("creates a topic in the teacher's scope", async () => {
    const { user, teacher } = await createTeacher();
    asTeacher(user.id);
    const res = await POST(jsonReq({ name: "  Kinematics  ", order: 3 }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.name).toBe("Kinematics"); // trimmed
    expect(body.order).toBe(3);
    expect(body.teacherId).toBe(teacher.id);
    expect(body.contentType).toBe("QUIZ");
  });

  it("creates a material-only tag when requested", async () => {
    const { user } = await createTeacher();
    asTeacher(user.id);
    const res = await POST(jsonReq({ name: "Lab handouts", contentType: "MATERIAL" }));
    expect(res.status).toBe(201);
    expect((await res.json()).contentType).toBe("MATERIAL");
  });
});

describe("PATCH /api/topics", () => {
  it("requires an id", async () => {
    const { user } = await createTeacher();
    asTeacher(user.id);
    expect((await PATCH(jsonReq({ name: "x" }))).status).toBe(400);
  });

  it("404s when editing a topic the teacher does not own", async () => {
    const owner = await createTeacher();
    const topic = await prisma.topic.create({ data: { name: "Owned", teacherId: owner.teacher.id } });
    const intruder = await createTeacher();
    asTeacher(intruder.user.id);
    expect((await PATCH(jsonReq({ id: topic.id, name: "hacked" }))).status).toBe(404);
  });

  it("renames and reorders an owned topic", async () => {
    const { user, teacher } = await createTeacher();
    const topic = await prisma.topic.create({ data: { name: "Old", teacherId: teacher.id } });
    asTeacher(user.id);
    const body = await (await PATCH(jsonReq({ id: topic.id, name: " New ", order: 9 }))).json();
    expect(body.name).toBe("New");
    expect(body.order).toBe(9);
  });
});

describe("DELETE /api/topics", () => {
  it("404s when deleting a topic the teacher does not own", async () => {
    const owner = await createTeacher();
    const topic = await prisma.topic.create({ data: { name: "Owned", teacherId: owner.teacher.id } });
    const intruder = await createTeacher();
    asTeacher(intruder.user.id);
    expect((await DELETE(jsonReq({ id: topic.id }))).status).toBe(404);
  });

  it("deletes the label but detaches (does not delete) its quizzes", async () => {
    const { user, teacher } = await createTeacher();
    const topic = await prisma.topic.create({ data: { name: "Grouped", teacherId: teacher.id } });
    const quiz = await prisma.quiz.create({ data: { name: "Q", topicId: topic.id, teacherId: teacher.id } });

    asTeacher(user.id);
    expect((await DELETE(jsonReq({ id: topic.id }))).status).toBe(200);

    expect(await prisma.topic.findUnique({ where: { id: topic.id } })).toBeNull();
    const survivor = await prisma.quiz.findUnique({ where: { id: quiz.id } });
    expect(survivor).not.toBeNull();
    expect(survivor!.topicId).toBeNull(); // detached, not cascaded
  });
});
