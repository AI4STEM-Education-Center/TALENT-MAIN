import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { GET as responsesGet } from "@/app/api/admin/surveys/[id]/responses/route";
import {
  GET as surveyGet,
  PATCH as surveyPatch,
  DELETE as surveyDelete,
} from "@/app/api/admin/surveys/[id]/route";
import {
  GET as surveysGet,
  POST as surveysPost,
} from "@/app/api/admin/surveys/route";
import { GET as consentGet } from "@/app/api/admin/consent/route";
import { GET as consentRequestsGet } from "@/app/api/admin/consent-requests/route";
import { PATCH as consentRequestPatch } from "@/app/api/admin/consent-requests/[id]/route";
import { DELETE as userDelete } from "@/app/api/admin/users/[id]/route";
import { GET as smtpGet } from "@/app/api/admin/smtp/route";
import { GET as backupGet } from "@/app/api/admin/backup/route";
import { GET as teacherCodesGet } from "@/app/api/admin/teacher-codes/route";
import { GET as aiProvidersGet } from "@/app/api/admin/ai-providers/route";
import { GET as aiConfigExport } from "@/app/api/admin/ai-config/export/route";
import { GET as consentSettingsGet } from "@/app/api/admin/consent/settings/route";
import { GET as campaignsGet } from "@/app/api/admin/research-email/campaigns/route";
import {
  GET as quizGet,
  PATCH as quizPatch,
  DELETE as quizDelete,
} from "@/app/api/quizzes/[id]/route";
import { GET as feedbackSummaryGet } from "@/app/api/feedback/summary/route";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  resetDb,
  createAdmin,
  createClass,
  createStudent,
  createTeacher,
} from "./db";

const mockAuth = vi.mocked(auth);

function asResearcher() {
  mockAuth.mockResolvedValue({
    user: { id: "researcher-1", role: "RESEARCHER", email: "r@x.org" },
  } as never);
}

const req = (
  path: string,
  init?: ConstructorParameters<typeof NextRequest>[1],
) => new NextRequest(`http://localhost${path}`, init);
const params = <T extends Record<string, string>>(p: T) => ({
  params: Promise.resolve(p),
});

async function surveyWithResponse() {
  const { user } = await createStudent();
  const form = await prisma.surveyForm.create({
    data: {
      kind: "PRE",
      role: "STUDENT",
      title: "Pre survey",
      questions: JSON.stringify([
        { id: "q1", type: "text", prompt: "Why?", required: false },
      ]),
      isEnabled: true,
    },
  });
  await prisma.surveyResponse.create({
    data: {
      formId: form.id,
      userId: user.id,
      kind: "PRE",
      role: "STUDENT",
      answers: JSON.stringify({ q1: "because" }),
      nameSnapshot: "Stu Student",
      emailSnapshot: user.email,
    },
  });
  return form;
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(() => prisma.$disconnect());

describe("RESEARCHER on a DATA route: reads allowed, writes refused", () => {
  it("reads the survey list, a survey and its responses", async () => {
    const form = await surveyWithResponse();
    asResearcher();
    expect((await surveysGet()).status).toBe(200);
    expect(
      (
        await surveyGet(
          req(`/api/admin/surveys/${form.id}`),
          params({ id: form.id }),
        )
      ).status,
    ).toBe(200);
    const res = await responsesGet(
      req(`/api/admin/surveys/${form.id}/responses`),
      params({ id: form.id }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).responses).toHaveLength(1);
  });

  it("downloads the responses CSV and leaves an audit trail", async () => {
    const form = await surveyWithResponse();
    asResearcher();
    const res = await responsesGet(
      req(`/api/admin/surveys/${form.id}/responses?format=csv`),
      params({ id: form.id }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const audit = await prisma.systemLog.findFirstOrThrow({
      where: { category: "AUDIT", type: "DATA_EXPORT" },
    });
    expect(audit.userId).toBe("researcher-1");
    expect(JSON.parse(audit.metadata!)).toMatchObject({
      dataset: "survey responses CSV",
      formId: form.id,
      role: "RESEARCHER",
    });
  });

  it("cannot create, edit or delete a survey", async () => {
    const form = await surveyWithResponse();
    asResearcher();
    const patch = await surveyPatch(
      req(`/api/admin/surveys/${form.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isEnabled: false }),
      }),
      params({ id: form.id }),
    );
    expect(patch.status).toBe(403);
    const del = await surveyDelete(
      req(`/api/admin/surveys/${form.id}`, { method: "DELETE" }),
      params({ id: form.id }),
    );
    expect(del.status).toBe(403);
    const post = await surveysPost(
      req("/api/admin/surveys", {
        method: "POST",
        body: JSON.stringify({ template: "student-pre" }),
      }),
    );
    expect(post.status).toBe(403);
    const after = await prisma.surveyForm.findUniqueOrThrow({
      where: { id: form.id },
    });
    expect(after.isEnabled).toBe(true);
  });

  it("sees a consent export request assigned to another admin, but cannot decide it", async () => {
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    const reviewer = await createAdmin();
    const otherAdmin = await createAdmin();
    const request = await prisma.consentExportRequest.create({
      data: {
        teacherId: teacher.id,
        classId: cls.id,
        gradeColumnName: "IRB credit",
        pointsAwarded: 1,
        reviewerId: reviewer.id,
      },
    });

    asResearcher();
    const res = await consentRequestsGet();
    expect(res.status).toBe(200);
    const { requests } = await res.json();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      id: request.id,
      reviewer: { firstName: reviewer.firstName },
    });

    const patch = await consentRequestPatch(
      req(`/api/admin/consent-requests/${request.id}`, {
        method: "PATCH",
        body: JSON.stringify({ decision: "REJECT" }),
      }),
      params({ id: request.id }),
    );
    expect(patch.status).toBe(403);
    expect(
      (
        await prisma.consentExportRequest.findUniqueOrThrow({
          where: { id: request.id },
        })
      ).status,
    ).toBe("PENDING");

    // An admin still sees only the requests routed to them.
    mockAuth.mockResolvedValue({
      user: { id: otherAdmin.id, role: "ADMIN" },
    } as never);
    expect((await (await consentRequestsGet()).json()).requests).toHaveLength(
      0,
    );
    mockAuth.mockResolvedValue({
      user: { id: reviewer.id, role: "ADMIN" },
    } as never);
    expect((await (await consentRequestsGet()).json()).requests).toHaveLength(
      1,
    );
  });

  it("reads consent records", async () => {
    asResearcher();
    expect((await consentGet(req("/api/admin/consent"))).status).toBe(200);
  });

  it("cannot delete a user", async () => {
    const { user } = await createTeacher();
    asResearcher();
    const res = await userDelete(
      req(`/api/admin/users/${user.id}`, { method: "DELETE" }),
      params({ id: user.id }),
    );
    expect(res.status).toBe(403);
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);
  });
});

describe("RESEARCHER on CONFIG routes: refused even for GET", () => {
  it.each([
    ["smtp", () => smtpGet()],
    ["backup", () => backupGet()],
    ["teacher-codes", () => teacherCodesGet(req("/api/admin/teacher-codes"))],
    ["ai-providers", () => aiProvidersGet()],
    ["ai-config export", () => aiConfigExport()],
    ["consent settings", () => consentSettingsGet()],
    [
      "research-email campaigns",
      () =>
        campaignsGet(req("/api/admin/research-email/campaigns?kind=INTERVIEW")),
    ],
  ])("GET %s -> 403", async (_name, call) => {
    asResearcher();
    expect((await call()).status).toBe(403);
  });
});

describe("RESEARCHER on content: read-only", () => {
  it("reads any quiz without an edit affordance, and cannot change it", async () => {
    const { teacher } = await createTeacher();
    const pool = await prisma.quiz.create({ data: { name: "Pool quiz" } });
    const owned = await prisma.quiz.create({
      data: { name: "Teacher quiz", teacherId: teacher.id },
    });
    asResearcher();
    for (const quiz of [pool, owned]) {
      const res = await quizGet(
        req(`/api/quizzes/${quiz.id}`),
        params({ id: quiz.id }),
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.editable).toBe(false);
      expect(body.simulationsEditable).toBe(false);
      expect(body.viewOnly).toBe(true);
    }
    const patch = await quizPatch(
      req(`/api/quizzes/${pool.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed" }),
      }),
      params({ id: pool.id }),
    );
    expect(patch.status).toBe(401);
    const del = await quizDelete(
      req(`/api/quizzes/${owned.id}`, { method: "DELETE" }),
      params({ id: owned.id }),
    );
    expect(del.status).toBe(401);
    expect(await prisma.quiz.count()).toBe(2);
    expect(
      (await prisma.quiz.findUniqueOrThrow({ where: { id: pool.id } })).name,
    ).toBe("Pool quiz");
  });

  it("reads the site-wide feedback panel", async () => {
    asResearcher();
    const res = await feedbackSummaryGet(req("/api/feedback/summary"));
    expect(res.status).toBe(200);
    expect((await res.json()).viewerRole).toBe("RESEARCHER");
  });
});
