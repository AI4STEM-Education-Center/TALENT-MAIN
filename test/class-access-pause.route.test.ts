import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
const { sessionAuth } = vi.hoisted(() => ({ sessionAuth: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  auth: (handler?: unknown) => handler ?? sessionAuth(),
}));
import proxy from "@/proxy";
import { PATCH } from "@/app/api/admin/classes/[id]/access/route";
import { GET as status } from "@/app/api/student/access/route";
import { GET as teacherClass } from "@/app/api/classes/[id]/route";
import {
  POST as join,
  GET as invite,
} from "@/app/api/invitations/[token]/route";
import { POST as quizStart, PATCH as quizSubmit } from "@/app/api/quiz/route";
import { POST as practiceStart } from "@/app/api/quiz/practice/route";
import { GET as attemptResults } from "@/app/api/student/attempts/[attemptId]/results/route";
import { GET as lookup } from "@/app/api/invitations/[token]/lookup/route";
import { prisma } from "@/lib/prisma";
import {
  getStudentPause,
  invalidateStudentPauseCache,
  DEFAULT_PAUSE_MESSAGE,
} from "@/lib/class-access-pause";
import {
  createTeacher,
  createStudent,
  createAdmin,
  createClass,
  createPublishedQuiz,
  resetDb,
} from "./db";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const as = (id: string, role: string) =>
  sessionAuth.mockResolvedValue({ user: { id, role } });
const toggle = (id: string, disabled: boolean, message?: string) =>
  PATCH(
    new NextRequest("http://localhost/api/admin/classes/x/access", {
      method: "PATCH",
      body: JSON.stringify({ disabled, message }),
    }),
    ctx(id),
  );
async function request(
  path: string,
  id: string,
  role = "STUDENT",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const req = new NextRequest(`http://localhost${path}`, {
    method: body ? "POST" : "GET",
    headers: { host: "localhost", ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  Object.assign(req, {
    auth: { user: { id, role, consentDecision: "AGREE" } },
  });
  return (proxy as unknown as (r: NextRequest) => Promise<Response>)(req);
}
beforeEach(async () => {
  await resetDb();
  invalidateStudentPauseCache();
  sessionAuth.mockReset();
});
async function setup() {
  const { user: teacherUser, teacher } = await createTeacher();
  const cls = await createClass(teacher.id);
  const { user, student } = await createStudent();
  await prisma.classEnrollment.create({
    data: { classId: cls.id, studentId: student.id },
  });
  const admin = await createAdmin();
  return { cls, user, student, admin, teacherUser, teacher };
}
describe("class access contract and central proxy enforcement", () => {
  it.each(["RESEARCHER", "TEACHER", "STUDENT"])(
    "rejects a %s toggle",
    async (role) => {
      const { cls, user } = await setup();
      as(user.id, role);
      expect((await toggle(cls.id, true)).status).toBe(403);
      expect(
        (await prisma.class.findUniqueOrThrow({ where: { id: cls.id } }))
          .disabledAt,
      ).toBeNull();
    },
  );
  it("validates input, returns 404, audits and invalidates a warmed cache in both directions", async () => {
    const { cls, user, admin } = await setup();
    as(admin.id, "ADMIN");
    expect((await getStudentPause(user.id)).paused).toBe(false);
    expect((await toggle("missing", true)).status).toBe(404);
    expect((await toggle(cls.id, true, "x".repeat(501))).status).toBe(400);
    const res = await toggle(cls.id, true, "Development break");
    expect(await res.json()).toMatchObject({
      id: cls.id,
      disabledAt: expect.any(String),
      disabledMessage: "Development break",
    });
    expect((await getStudentPause(user.id)).paused).toBe(true);
    expect(
      await prisma.systemLog.count({
        where: { type: "CLASS_ACCESS_UPDATED", userId: admin.id },
      }),
    ).toBe(1);
    expect(
      (await prisma.class.findUniqueOrThrow({ where: { id: cls.id } }))
        .disabledByUserId,
    ).toBe(admin.id);
    expect(await (await toggle(cls.id, false)).json()).toMatchObject({
      disabledAt: null,
      disabledMessage: null,
    });
    expect((await getStudentPause(user.id)).paused).toBe(false);
    expect((await request("/api/quiz", user.id)).status).toBe(200);
  });
  it("returns only the signed-in student's classes and keeps status reachable", async () => {
    const { cls, user, admin } = await setup();
    const other = await createStudent();
    as(admin.id, "ADMIN");
    await toggle(cls.id, true);
    as(user.id, "STUDENT");
    expect(await (await status()).json()).toEqual({
      paused: true,
      message: DEFAULT_PAUSE_MESSAGE,
      classes: [{ id: cls.id, name: cls.name, disabled: true }],
    });
    as(other.user.id, "STUDENT");
    expect(await (await status()).json()).toMatchObject({
      paused: false,
      classes: [],
    });
    as(admin.id, "ADMIN");
    expect((await status()).status).toBe(403);
    sessionAuth.mockResolvedValue(null);
    expect((await status()).status).toBe(401);
  });
  it("cuts off existing sessions on arbitrary APIs, files and pages; preserves identity/consent", async () => {
    const { cls, user, admin, teacherUser } = await setup();
    as(admin.id, "ADMIN");
    await toggle(cls.id, true);
    for (const path of [
      "/api/quiz",
      "/api/assistant/chat",
      "/api/coach",
      "/api/classes/x/materials",
      "/api/notifications",
      "/api/recordings",
      "/api/future-feature",
      "/api/student/materials/x/file",
    ]) {
      const res = await request(path, user.id);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({
        error: DEFAULT_PAUSE_MESSAGE,
        code: "PLATFORM_PAUSED",
      });
    }
    const htmlApi = await request("/api/quiz", user.id, "STUDENT", undefined, {
      accept: "text/html",
    });
    expect(htmlApi.status).toBe(403);
    expect(htmlApi.headers.get("location")).toBeNull();
    const page = await request("/student/classes", user.id);
    expect(new URL(page.headers.get("location")!).pathname).toBe(
      "/student/paused",
    );
    for (const path of [
      "/api/auth/signout",
      "/api/auth/session",
      "/api/consent",
      "/api/consent/reprompt/dismiss",
      "/api/student/access",
      "/student/paused",
    ])
      expect((await request(path, user.id)).status, path).toBe(200);
    expect(
      (await request(`/api/classes/${cls.id}`, teacherUser.id, "TEACHER"))
        .status,
    ).toBe(200);
    as(teacherUser.id, "TEACHER");
    expect(
      await (await teacherClass({} as never, ctx(cls.id))).json(),
    ).toMatchObject({ disabledAt: expect.any(String) });
    as(admin.id, "ADMIN");
    await toggle(cls.id, false);
    expect((await request("/api/assistant/chat", user.id)).status).toBe(200);
  });
  it("keeps mixed-class access but blocks the disabled class by URL, quiz body and attempt", async () => {
    const { cls, user, student, admin, teacher } = await setup();
    const active = await createClass(teacher.id, "Active");
    await prisma.classEnrollment.create({
      data: { classId: active.id, studentId: student.id },
    });
    const { quiz } = await createPublishedQuiz({ classId: cls.id });
    const { quiz: activeQuiz } = await createPublishedQuiz({
      classId: active.id,
    });
    const attempt = await prisma.quizAttempt.create({
      data: { classId: cls.id, studentId: student.id, quizId: quiz.id },
    });
    as(admin.id, "ADMIN");
    await toggle(cls.id, true, "Class paused");

    // Proxy: class id in the URL.
    expect(
      (await request(`/api/classes/${active.id}/modules`, user.id)).status,
    ).toBe(200);
    const blocked = await request(`/api/classes/${cls.id}/modules`, user.id);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({
      error: "Class paused",
      code: "PLATFORM_PAUSED",
    });
    const classPage = await request(`/student/classes/${cls.id}`, user.id);
    expect(new URL(classPage.headers.get("location")!).pathname).toBe(
      "/student/classes",
    );
    // Student is not fully paused: generic APIs stay reachable.
    expect((await request("/api/notifications", user.id)).status).toBe(200);
    expect((await request(`/api/student/access`, user.id)).status).toBe(200);

    // Routes: class id in the body or on the persisted attempt.
    as(user.id, "STUDENT");
    const json = (body: unknown, method = "POST") =>
      new NextRequest("http://localhost/api/quiz", {
        method,
        body: JSON.stringify(body),
      });
    const start = await quizStart(json({ classId: cls.id, quizId: quiz.id }));
    expect(start.status).toBe(403);
    expect(await start.json()).toMatchObject({ code: "PLATFORM_PAUSED" });
    expect(
      (
        await quizSubmit(
          json(
            { classId: active.id, attemptId: attempt.id, answers: [] },
            "PATCH",
          ),
        )
      ).status,
    ).toBe(403);
    expect(
      (await practiceStart(json({ classId: cls.id, quizId: quiz.id }))).status,
    ).toBe(403);
    const results = await attemptResults(
      new Request("http://localhost/api/x"),
      { params: Promise.resolve({ attemptId: attempt.id }) },
    );
    // No archived result yet => 404, not 403; the paused case is below.
    expect(results.status).toBe(404);
    await prisma.examResult.create({
      data: {
        quizAttemptId: attempt.id,
        studentId: student.id,
        classId: cls.id,
        quizId: quiz.id,
        className: cls.name,
        topicName: "Topic",
        quizName: "Quiz",
        score: 1,
        correctCount: 1,
        totalCount: 1,
        completedAt: new Date(),
        reviewSnapshot: "{}",
      },
    });
    expect(
      (
        await attemptResults(new Request("http://localhost/api/x"), {
          params: Promise.resolve({ attemptId: attempt.id }),
        })
      ).status,
    ).toBe(403);
    // The other, active class still works.
    expect(
      (await quizStart(json({ classId: active.id, quizId: activeQuiz.id })))
        .status,
    ).toBe(200);
  });
  it("refuses disabled invitations before signup, roster lookup or enrollment", async () => {
    const { cls, admin } = await setup();
    const invitation = await prisma.invitation.create({
      data: { classId: cls.id, token: "disabled-invite" },
    });
    as(admin.id, "ADMIN");
    await toggle(cls.id, true);
    const context = { params: Promise.resolve({ token: invitation.token }) };
    const req = new NextRequest(
      "http://localhost/api/invitations/disabled-invite?orgDefinedId=81",
      { method: "POST", body: "{}" },
    );
    expect((await join(req, context)).status).toBe(403);
    expect((await invite(req, context)).status).toBe(403);
    expect((await lookup(req, context)).status).toBe(403);
    expect(
      (
        await prisma.invitation.findUniqueOrThrow({
          where: { id: invitation.id },
        })
      ).usedCount,
    ).toBe(0);
  });
  it("refreshes on TTL and deliberately fails open with an error log", async () => {
    const { cls, user } = await setup();
    expect((await getStudentPause(user.id)).paused).toBe(false);
    await prisma.class.update({
      where: { id: cls.id },
      data: { disabledAt: new Date() },
    });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 11_000);
    expect((await getStudentPause(user.id)).paused).toBe(true);
    clock.mockRestore();
    invalidateStudentPauseCache();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const query = vi
      .spyOn(prisma.classEnrollment, "findMany")
      .mockRejectedValueOnce(new Error("database unavailable"));
    expect((await getStudentPause(user.id)).paused).toBe(false);
    expect(consoleError).toHaveBeenCalled();
    query.mockRestore();
    consoleError.mockRestore();
  });
});
