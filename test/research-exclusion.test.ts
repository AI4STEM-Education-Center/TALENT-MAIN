import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", () => ({ enqueueConsentEmails: vi.fn() }));

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  allClassesResearchExcluded,
  isResearchExempt,
  researchParticipantWhere,
} from "@/lib/research-exclusion";
import { getUserConsentClaim, hasResearchConsent } from "@/lib/consent";
import { CONSENT_NOT_REQUIRED } from "@/lib/consent-claim";
import {
  getDueSurveyStatus,
  getPreSurveyStatus,
  getConsentReprompt,
  countPostPromptAudience,
} from "@/lib/survey-server";
import { previewRecipients } from "@/lib/research-email-server";
import {
  GET as consentGet,
  POST as consentPost,
} from "@/app/api/consent/route";
import { POST as duePost } from "@/app/api/surveys/due/route";
import { POST as prePost } from "@/app/api/surveys/pre/route";
import { PATCH } from "@/app/api/admin/classes/[id]/research/route";
import TeacherConsentRequiredPage from "@/app/teacher/consent-required/page";
import {
  resetDb,
  createStudent,
  createTeacher,
  createClass,
  createAdmin,
} from "./db";

const mockAuth = vi.mocked(auth);
function asUser(user: { id: string; role: string; email: string }) {
  mockAuth.mockResolvedValue({
    user: { ...user, firstName: "Test", lastName: "User" },
  } as never);
}
function request(body: unknown, method = "POST") {
  return new NextRequest("http://localhost/api/test", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
function patch(id: string, body: unknown) {
  return PATCH(request(body, "PATCH"), { params: Promise.resolve({ id }) });
}
async function fixture(role: "STUDENT" | "TEACHER" = "STUDENT") {
  const owner = await createTeacher();
  const cls = await createClass(owner.teacher.id);
  await prisma.class.update({
    where: { id: cls.id },
    data: { researchExcluded: true },
  });
  if (role === "TEACHER") return { user: owner.user, cls };
  const member = await createStudent();
  await prisma.classEnrollment.create({
    data: { classId: cls.id, studentId: member.student.id },
  });
  return { user: member.user, cls, student: member.student };
}
async function form(role: string, kind: "PRE" | "POST" = "PRE") {
  return prisma.surveyForm.create({
    data: {
      role,
      kind,
      title: "Survey",
      questions: "[]",
      isEnabled: true,
      status: "READY",
      promptInApp: kind === "POST",
      promptStartedAt: kind === "POST" ? new Date() : null,
    },
  });
}
async function consent(role: string) {
  return prisma.consentFormVersion.create({
    data: {
      role,
      version: "v1",
      title: "Consent",
      bodyHtml: "<p>Consent</p>",
      isActive: true,
    },
  });
}
async function agree(
  userId: string,
  formVersionId: string,
  role = "STUDENT",
  decision = "AGREE",
) {
  return prisma.consentRecord.create({
    data: {
      userId,
      formVersionId,
      role,
      decision,
      signatureTypedName: "Test",
      ipAddress: "127.0.0.1",
      userAgent: "test",
      deviceType: "desktop",
      signerNameSnapshot: "Test",
      signerEmailSnapshot: "test@example.com",
      signedAt: new Date("2020-01-01"),
    },
  });
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});
afterAll(async () => {
  await prisma.$disconnect();
});

describe("research exclusion predicate", () => {
  it.each(["STUDENT", "TEACHER"])(
    "requires nonempty, entirely excluded classes for %s",
    (role) => {
      expect(allClassesResearchExcluded(role, [])).toBe(false);
      expect(
        allClassesResearchExcluded(role, [{ researchExcluded: false }]),
      ).toBe(false);
      expect(
        allClassesResearchExcluded(role, [
          { researchExcluded: true },
          { researchExcluded: false },
        ]),
      ).toBe(false);
      expect(
        allClassesResearchExcluded(role, [
          { researchExcluded: true },
          { researchExcluded: true },
        ]),
      ).toBe(true);
    },
  );
  it("does not exempt other roles", () => {
    expect(
      allClassesResearchExcluded("ADMIN", [{ researchExcluded: true }]),
    ).toBe(false);
    expect(
      allClassesResearchExcluded("RESEARCHER", [{ researchExcluded: true }]),
    ).toBe(false);
  });
  it.each(["STUDENT", "TEACHER"] as const)(
    "matches database membership and batched audience for %s",
    async (role) => {
      const { user, cls } = await fixture(role);
      const empty =
        role === "TEACHER"
          ? (await createTeacher()).user
          : (await createStudent()).user;
      expect(await isResearchExempt(empty.id, role)).toBe(false);
      expect(await isResearchExempt(user.id, role)).toBe(true);
      expect(
        (
          await prisma.user.findMany({ where: researchParticipantWhere(role) })
        ).map((u) => u.id),
      ).toEqual([empty.id]);
      const other = await createClass(cls.teacherId, "Other");
      if (role === "STUDENT") {
        const student = await prisma.student.findUniqueOrThrow({
          where: { userId: user.id },
        });
        await prisma.classEnrollment.create({
          data: { studentId: student.id, classId: other.id },
        });
      }
      expect(await isResearchExempt(user.id, role)).toBe(false);
      expect(
        (
          await prisma.user.findMany({ where: researchParticipantWhere(role) })
        ).map((u) => u.id),
      ).toContain(user.id);
    },
  );
});

describe("exempt consent and surveys", () => {
  it.each(["STUDENT", "TEACHER"] as const)(
    "suppresses consent, pre and post prompts for %s",
    async (role) => {
      const { user } = await fixture(role);
      await consent(role);
      const pre = await form(role);
      await form(role, "POST");
      asUser(user);
      expect(await (await consentGet()).json()).toEqual({
        exempt: true,
        needsDecision: false,
        role,
        activeForm: null,
        priorDecision: null,
        reprompt: null,
      });
      expect(await getUserConsentClaim(user.id, role)).toEqual({
        version: null,
        decision: CONSENT_NOT_REQUIRED,
      });
      expect(await getPreSurveyStatus(user.id, role)).toEqual({
        state: "NONE",
      });
      expect(await getDueSurveyStatus(user.id, role)).toEqual({
        state: "NONE",
      });
      expect(
        (await prePost(request({ formId: pre.id, answers: {} }))).status,
      ).toBe(409);
      expect(
        (await duePost(request({ formId: pre.id, answers: {} }))).status,
      ).toBe(409);
      expect(await prisma.surveyResponse.count()).toBe(0);
      expect(
        await getConsentReprompt(user.id, role, {
          decision: "DECLINE",
          decidedAt: new Date(0),
        }),
      ).toBeNull();
    },
  );
  it("refreshes a blocked teacher's stale claim through the standalone page", async () => {
    const { user } = await fixture("TEACHER");
    await consent("TEACHER");
    asUser(user);
    const page = await TeacherConsentRequiredPage();
    expect(page.props.reason).toBe("excluded");
    expect(await getUserConsentClaim(user.id, "TEACHER")).toEqual({
      version: null,
      decision: CONSENT_NOT_REQUIRED,
    });
  });
  it("preserves voluntary decisions and research collection consent", async () => {
    const { user } = await fixture();
    await consent("STUDENT");
    asUser(user);
    expect(
      (
        await consentPost(
          request({
            decision: "AGREE",
            interviewRecordingChoice: "NO_INTERVIEW",
            ugaId: "811234567",
            signatureTypedName: "Test User",
          }),
        )
      ).status,
    ).toBe(200);
    expect(await hasResearchConsent(user.id)).toBe(true);
  });
  it("removes exempt accounts from post-survey campaign previews and prompt counts", async () => {
    const { user, cls } = await fixture();
    const version = await consent("STUDENT");
    await agree(user.id, version.id);
    const pre = await form("STUDENT");
    const post = await form("STUDENT", "POST");
    await prisma.surveyResponse.create({
      data: {
        formId: pre.id,
        userId: user.id,
        role: "STUDENT",
        kind: "PRE",
        answers: "{}",
        nameSnapshot: "Test",
        emailSnapshot: user.email,
        submittedAt: new Date("2021-01-01"),
      },
    });
    const audience = JSON.stringify({ roles: ["STUDENT"], target: "ALL" });
    expect(
      (await previewRecipients("POST_SURVEY", audience)).recipients,
    ).toHaveLength(0);
    expect(await countPostPromptAudience(post)).toEqual({
      eligible: 0,
      completed: 0,
    });
    await prisma.class.update({
      where: { id: cls.id },
      data: { researchExcluded: false },
    });
    expect(
      (await previewRecipients("POST_SURVEY", audience)).recipients.map(
        (r) => r.userId,
      ),
    ).toContain(user.id);
    expect(await countPostPromptAudience(post)).toEqual({
      eligible: 1,
      completed: 0,
    });
    expect((await consentGet()).status).toBe(401);
  });
});

describe("PATCH /api/admin/classes/[id]/research", () => {
  it("requires admin (including rejecting researchers)", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await patch("missing", { excluded: true })).status).toBe(401);
    for (const role of ["RESEARCHER", "TEACHER", "STUDENT"]) {
      asUser({ id: "other", role, email: "other@example.com" });
      expect((await patch("missing", { excluded: true })).status).toBe(403);
    }
  });
  it("sets and clears exclusion metadata, returns the exact contract, and audits", async () => {
    const admin = await createAdmin();
    const { teacher } = await createTeacher();
    const cls = await createClass(teacher.id);
    asUser(admin);
    const enabled = await patch(cls.id, { excluded: true });
    expect(enabled.status).toBe(200);
    const data = await enabled.json();
    expect(data).toEqual({
      id: cls.id,
      researchExcluded: true,
      researchExcludedAt: expect.any(String),
    });
    expect(new Date(data.researchExcludedAt).toISOString()).toBe(
      data.researchExcludedAt,
    );
    expect(
      (await prisma.class.findUniqueOrThrow({ where: { id: cls.id } }))
        .researchExcludedById,
    ).toBe(admin.id);
    expect(
      await prisma.systemLog.findFirst({
        where: { type: "CLASS_RESEARCH_EXCLUSION_UPDATED", userId: admin.id },
      }),
    ).not.toBeNull();
    expect(await (await patch(cls.id, { excluded: false })).json()).toEqual({
      id: cls.id,
      researchExcluded: false,
      researchExcludedAt: null,
    });
    expect(
      (await prisma.class.findUniqueOrThrow({ where: { id: cls.id } }))
        .researchExcludedById,
    ).toBeNull();
  });
  it("returns 404 for unknown classes and 400 for invalid bodies or JSON", async () => {
    asUser(await createAdmin());
    expect((await patch("missing", { excluded: true })).status).toBe(404);
    for (const body of [
      {},
      null,
      { excluded: "true" },
      { excluded: 1 },
      { excluded: true, other: 1 },
    ]) {
      expect((await patch("missing", body)).status).toBe(400);
    }
    expect(
      (
        await PATCH(
          new NextRequest("http://localhost/api/test", {
            method: "PATCH",
            body: "{",
          }),
          { params: Promise.resolve({ id: "missing" }) },
        )
      ).status,
    ).toBe(400);
  });
});
