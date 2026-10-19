import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", async (orig) => ({
  ...(await orig<typeof import("@/lib/queue")>()),
  enqueueResearchEmails: vi.fn(),
  enqueueSurveyExtraction: vi.fn(),
  enqueueConsentEmails: vi.fn(),
}));

import { GET as dueGet, POST as duePost } from "@/app/api/surveys/due/route";
import { GET as consentGet } from "@/app/api/consent/route";
import { POST as repromptDismiss } from "@/app/api/consent/reprompt/dismiss/route";
import { PATCH as surveyPatch } from "@/app/api/admin/surveys/[id]/route";
import { GET as surveysGet } from "@/app/api/admin/surveys/route";
import { POST as campaignPost } from "@/app/api/admin/research-email/campaigns/route";
import { materializeDueCampaigns } from "@/lib/research-email-server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findSurveyTemplate } from "@/lib/survey-templates";
import { resetDb, createStudent, createAdmin } from "./db";

const mockAuth = vi.mocked(auth);

function asUser(user: { id: string; role: string; email: string }) {
  mockAuth.mockResolvedValue({
    user: { ...user, firstName: "Stu", lastName: "Student" },
  } as never);
}

function jsonReq(url: string, body: unknown, method = "POST") {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function consentForm() {
  return prisma.consentFormVersion.create({
    data: {
      role: "STUDENT",
      version: "v1",
      title: "Student consent",
      bodyHtml: "<p>x</p>",
      isActive: true,
    },
  });
}

async function decide(
  userId: string,
  formVersionId: string,
  decision: "AGREE" | "DECLINE",
  signedAt = new Date(),
) {
  await prisma.consentRecord.create({
    data: {
      userId,
      role: "STUDENT",
      formVersionId,
      decision,
      interviewRecordingChoice: decision === "AGREE" ? "AUDIO_ONLY" : null,
      signatureTypedName: "Stu Student",
      ipAddress: "127.0.0.1",
      userAgent: "test",
      deviceType: "desktop",
      signerNameSnapshot: "Stu Student",
      signerEmailSnapshot: "stu@example.com",
      signedAt,
    },
  });
}

async function form(kind: "PRE" | "POST", period = 1, isEnabled = true) {
  const template = findSurveyTemplate(
    kind === "PRE" ? "student-pre" : "student-post",
  )!;
  return prisma.surveyForm.create({
    data: {
      kind,
      role: "STUDENT",
      period,
      title: `${kind} ${period}`,
      questions: JSON.stringify(template.questions),
      isEnabled,
    },
  });
}

function answersFor(questions: string) {
  const answers: Record<string, string | string[]> = {};
  for (const q of JSON.parse(questions)) {
    if (q.type === "section" || !q.required) continue;
    answers[q.id] =
      q.type === "multi" ? [q.options[0]] : (q.options[0] ?? "Some answer");
  }
  return answers;
}

async function respond(
  userId: string,
  f: { id: string; kind: string },
  submittedAt = new Date(),
) {
  await prisma.surveyResponse.create({
    data: {
      formId: f.id,
      userId,
      kind: f.kind,
      role: "STUDENT",
      answers: "{}",
      nameSnapshot: "Stu Student",
      emailSnapshot: "stu@example.com",
      submittedAt,
    },
  });
}

async function patch(id: string, body: unknown) {
  return surveyPatch(jsonReq(`/api/admin/surveys/${id}`, body, "PATCH"), {
    params: Promise.resolve({ id }),
  });
}

const past = new Date(Date.now() - 30 * 86_400_000);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
/** Lets the clock move on, so "before"/"after" timestamps never tie. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function enabledPerSlot() {
  const enabled = await prisma.surveyForm.findMany({
    where: { isEnabled: true },
    select: { kind: true, role: true, period: true },
  });
  const counts = new Map<string, number>();
  for (const f of enabled) {
    const key = `${f.kind}-${f.role}-${f.period}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Math.max(0, ...counts.values());
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("post-survey periods", () => {
  it("keeps one enabled post-survey per period", async () => {
    const admin = await createAdmin();
    const p1 = await form("POST", 1);
    const p2 = await form("POST", 2);
    const p1b = await form("POST", 1, false);
    asUser(admin);

    expect((await patch(p1b.id, { isEnabled: true })).status).toBe(200);
    const enabled = await prisma.surveyForm.findMany({
      where: { isEnabled: true },
      select: { id: true },
    });
    expect(enabled.map((f) => f.id).sort()).toEqual([p1b.id, p2.id].sort());

    // Moving an enabled form into period 2 takes that slot over.
    expect((await patch(p1b.id, { period: 2 })).status).toBe(200);
    expect(
      (await prisma.surveyForm.findUniqueOrThrow({ where: { id: p2.id } }))
        .isEnabled,
    ).toBe(false);
    expect(p1.id).toBeTruthy();

    // PRE forms have no period.
    const pre = await form("PRE");
    expect((await patch(pre.id, { period: 2 })).status).toBe(400);
  });

  it("only prompts an enabled post-survey and keeps the first start time", async () => {
    const admin = await createAdmin();
    const pre = await form("PRE");
    const off = await form("POST", 1, false);
    asUser(admin);
    expect((await patch(pre.id, { promptInApp: true })).status).toBe(400);
    expect((await patch(off.id, { promptInApp: true })).status).toBe(400);

    const p1 = await form("POST", 1);
    expect((await patch(p1.id, { promptInApp: true })).status).toBe(200);
    const started = (
      await prisma.surveyForm.findUniqueOrThrow({ where: { id: p1.id } })
    ).promptStartedAt;
    expect(started).toBeInstanceOf(Date);

    await patch(p1.id, { promptInApp: false });
    await patch(p1.id, { promptInApp: true });
    const again = await prisma.surveyForm.findUniqueOrThrow({
      where: { id: p1.id },
    });
    expect(again.promptInApp).toBe(true);
    expect(again.promptStartedAt?.getTime()).toBe(started?.getTime());

    // Disabling stops the prompt.
    await patch(p1.id, { isEnabled: false });
    expect(
      (await prisma.surveyForm.findUniqueOrThrow({ where: { id: p1.id } }))
        .promptInApp,
    ).toBe(false);
  });
});

describe("in-app post-survey", () => {
  it("is mandatory for prior participants, checks the form, and counts link responses", async () => {
    const admin = await createAdmin();
    const consent = await consentForm();
    const pre = await form("PRE");
    const p1 = await form("POST", 1);
    const p2 = await form("POST", 2);
    const { user: veteran } = await createStudent();
    const { user: linked } = await createStudent();
    const { user: newcomer } = await createStudent();
    for (const u of [veteran, linked]) {
      await decide(u.id, consent.id, "AGREE", past);
      await respond(u.id, pre, past);
    }
    await respond(linked.id, p1, past); // answered via an emailed link

    asUser(admin);
    await patch(p1.id, { promptInApp: true });
    // Joins after the prompt started.
    await decide(newcomer.id, consent.id, "AGREE");
    await respond(newcomer.id, pre);

    asUser(veteran);
    const due = await (await dueGet()).json();
    expect(due).toMatchObject({
      state: "DUE",
      kind: "POST",
      period: 1,
      mandatory: true,
    });
    expect(due.form.id).toBe(p1.id);

    const wrong = await duePost(
      jsonReq("/api/surveys/due", {
        formId: p2.id,
        answers: answersFor(p2.questions),
      }),
    );
    expect(wrong.status).toBe(409);
    const ok = await duePost(
      jsonReq("/api/surveys/due", {
        formId: p1.id,
        answers: answersFor(p1.questions),
      }),
    );
    expect(ok.status).toBe(200);
    expect(
      await prisma.surveyResponse.findFirstOrThrow({
        where: { userId: veteran.id, formId: p1.id },
      }),
    ).toMatchObject({ kind: "POST", source: "APP", irbAgreed: true });
    expect(await (await dueGet()).json()).toEqual({ state: "NONE" });
    // A retried submission is a no-op success.
    const retry = await duePost(
      jsonReq("/api/surveys/due", {
        formId: p1.id,
        answers: answersFor(p1.questions),
      }),
    );
    expect(retry.status).toBe(200);

    asUser(linked);
    expect(await (await dueGet()).json()).toEqual({ state: "NONE" });
    asUser(newcomer);
    expect(await (await dueGet()).json()).toEqual({ state: "NONE" });

    asUser(admin);
    const list = await (await surveysGet()).json();
    const row = list.forms.find((f: { id: string }) => f.id === p1.id);
    expect(row).toMatchObject({
      period: 1,
      promptInApp: true,
      promptAudience: { eligible: 2, completed: 2 },
    });
  });
});

describe("IRB re-consent prompt", () => {
  it("asks a decliner once per campaign and never hands them the old post-survey", async () => {
    const admin = await createAdmin();
    const consent = await consentForm();
    const pre = await form("PRE");
    const p1 = await form("POST", 1);
    const { user } = await createStudent();
    await decide(user.id, consent.id, "DECLINE", past);
    await respond(user.id, pre, past); // took the optional pre-survey

    asUser(user);
    expect((await (await consentGet()).json()).reprompt).toBeNull();

    asUser(admin);
    await patch(p1.id, { promptInApp: true });

    asUser(user);
    const status = await (await consentGet()).json();
    expect(status).toMatchObject({
      needsDecision: false,
      reprompt: { campaignKey: p1.id, period: 1 },
    });
    // Surveys hold back while the consent prompt is pending.
    expect(await (await dueGet()).json()).toEqual({
      state: "CONSENT_PENDING",
    });

    expect((await repromptDismiss()).status).toBe(200);
    expect((await (await consentGet()).json()).reprompt).toBeNull();
    expect(await (await dueGet()).json()).toEqual({ state: "NONE" });

    // A later period asks again.
    await tick();
    const p2 = await form("POST", 2);
    asUser(admin);
    await patch(p2.id, { promptInApp: true });
    asUser(user);
    expect((await (await consentGet()).json()).reprompt).toMatchObject({
      campaignKey: p2.id,
      period: 2,
    });

    // Re-consenting: the newest decision wins everywhere. Their optional
    // pre-survey predates the prompts but their AGREE doesn't, so they joined
    // the study now and owe neither earlier post-survey.
    await decide(user.id, consent.id, "AGREE");
    expect((await (await consentGet()).json()).reprompt).toBeNull();
    expect(await (await dueGet()).json()).toEqual({ state: "NONE" });

    // A decliner who never took the pre-survey gets it (mandatory) after
    // re-consenting, and then nothing more.
    const { user: fresh } = await createStudent();
    await decide(fresh.id, consent.id, "DECLINE", past);
    await decide(fresh.id, consent.id, "AGREE");
    asUser(fresh);
    const preDue = await (await dueGet()).json();
    expect(preDue).toMatchObject({
      state: "DUE",
      kind: "PRE",
      mandatory: true,
    });
    await duePost(
      jsonReq("/api/surveys/due", {
        formId: pre.id,
        answers: answersFor(pre.questions),
      }),
    );
    expect(await (await dueGet()).json()).toEqual({ state: "NONE" });
  });
});

describe("study period lock", () => {
  it("refuses to move a form with responses, links or a started prompt", async () => {
    const admin = await createAdmin();
    const { user } = await createStudent();
    const answered = await form("POST", 1);
    await respond(user.id, answered);
    const linked = await form("POST", 1, false);
    await prisma.surveyInvite.create({
      data: {
        tokenHash: "hash-1",
        formId: linked.id,
        email: "a@uga.edu",
        name: "A",
      },
    });
    const prompted = await form("POST", 1, false);
    await prisma.surveyForm.update({
      where: { id: prompted.id },
      data: { promptStartedAt: past },
    });
    const fresh = await form("POST", 1, false);
    asUser(admin);

    for (const f of [answered, linked, prompted]) {
      const res = await patch(f.id, { period: 2 });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Create a new survey/);
      expect(
        (await prisma.surveyForm.findUniqueOrThrow({ where: { id: f.id } }))
          .period,
      ).toBe(1);
    }
    // Re-sending the current period is not a change.
    expect((await patch(answered.id, { period: 1 })).status).toBe(200);
    expect((await patch(fresh.id, { period: 2 })).status).toBe(200);
  });
});

describe("slot invariant under concurrent edits", () => {
  it.each([false, true])(
    "enabling A in P1 while a parallel request moves A to P2 (reversed: %s)",
    async (reversed) => {
      const admin = await createAdmin();
      const a = await form("POST", 1, false);
      await form("POST", 2); // B holds the Period 2 slot
      asUser(admin);
      const requests = [
        () => patch(a.id, { isEnabled: true }),
        () => patch(a.id, { period: 2 }),
      ];
      if (reversed) requests.reverse();
      const results = await Promise.all(requests.map((r) => r()));
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(await enabledPerSlot()).toBe(1);
      expect(
        await prisma.surveyForm.findUniqueOrThrow({ where: { id: a.id } }),
      ).toMatchObject({ period: 2, isEnabled: true });
    },
  );
});

describe("post-survey eligibility across consent history", () => {
  it("uses the standing decision when the prompt started", async () => {
    const admin = await createAdmin();
    const consent = await consentForm();
    const pre = await form("PRE");
    const p1 = await form("POST", 1);
    const { user } = await createStudent();
    // AGREE → PRE → DECLINE (before the cutoff) → AGREE (after).
    await decide(user.id, consent.id, "AGREE", daysAgo(30));
    await respond(user.id, pre, daysAgo(29));
    await decide(user.id, consent.id, "DECLINE", daysAgo(10));
    asUser(admin);
    await patch(p1.id, { promptInApp: true });
    await tick();
    await decide(user.id, consent.id, "AGREE");

    asUser(user);
    expect(await (await dueGet()).json()).toEqual({ state: "NONE" });
    asUser(admin);
    const row = (await (await surveysGet()).json()).forms.find(
      (f: { id: string }) => f.id === p1.id,
    );
    expect(row.promptAudience).toEqual({ eligible: 0, completed: 0 });
  });

  it("carries a period 1 AGREE across a consent version published later", async () => {
    const admin = await createAdmin();
    const v1 = await consentForm();
    const pre = await form("PRE");
    const p1 = await form("POST", 1);
    const { user } = await createStudent();
    await decide(user.id, v1.id, "AGREE", daysAgo(30));
    await respond(user.id, pre, daysAgo(29));
    asUser(admin);
    await patch(p1.id, { promptInApp: true });

    // v2 replaces v1; until they decide on it, consent comes first.
    await prisma.consentFormVersion.update({
      where: { id: v1.id },
      data: { isActive: false },
    });
    const v2 = await prisma.consentFormVersion.create({
      data: {
        role: "STUDENT",
        version: "v2",
        title: "Student consent v2",
        bodyHtml: "<p>y</p>",
        isActive: true,
      },
    });
    asUser(user);
    expect(await (await dueGet()).json()).toEqual({ state: "CONSENT_PENDING" });
    await tick();
    await decide(user.id, v2.id, "AGREE");
    expect(await (await dueGet()).json()).toMatchObject({
      state: "DUE",
      kind: "POST",
      period: 1,
    });
  });
});

describe("re-consent prompt timing", () => {
  it("ends when the student declines again after the campaign started", async () => {
    const admin = await createAdmin();
    const consent = await consentForm();
    const pre = await form("PRE");
    const p1 = await form("POST", 1);
    const { user } = await createStudent();
    await decide(user.id, consent.id, "DECLINE", past);
    await respond(user.id, pre, past);
    asUser(admin);
    await patch(p1.id, { promptInApp: true });

    asUser(user);
    expect((await (await consentGet()).json()).reprompt).not.toBeNull();
    await tick();
    await decide(user.id, consent.id, "DECLINE"); // answered via the form
    expect((await (await consentGet()).json()).reprompt).toBeNull();
    // The survey gate isn't left waiting on consent.
    expect(await (await dueGet()).json()).toEqual({ state: "NONE" });
  });

  it("doesn't bring period 1 back when period 2's prompt is turned off", async () => {
    const admin = await createAdmin();
    const consent = await consentForm();
    const p1 = await form("POST", 1);
    const p2 = await form("POST", 2);
    const { user } = await createStudent();
    await decide(user.id, consent.id, "DECLINE", past);
    asUser(admin);
    await patch(p1.id, { promptInApp: true });
    await tick();
    await patch(p2.id, { promptInApp: true });
    await tick();

    asUser(user);
    expect((await (await consentGet()).json()).reprompt).toMatchObject({
      campaignKey: p2.id,
    });
    expect((await repromptDismiss()).status).toBe(200);

    asUser(admin);
    await patch(p2.id, { promptInApp: false });
    asUser(user);
    expect((await (await consentGet()).json()).reprompt).toBeNull();
  });
});

describe("post-survey email by period", () => {
  it("points links at the chosen period's form, defaulting to the lowest", async () => {
    const admin = await createAdmin();
    await createStudent();
    const p1 = await form("POST", 1);
    const p2 = await form("POST", 2);
    asUser(admin);

    const send = (audience: Record<string, unknown>) =>
      campaignPost(
        jsonReq("/api/admin/research-email/campaigns", {
          kind: "POST_SURVEY",
          replyTo: "",
          versions: { STUDENT: { subject: "Hi", body: "{{surveyLink}}" } },
          attachments: [],
          audience: { roles: ["STUDENT"], target: "ALL", ...audience },
        }),
      );

    expect((await send({ period: 2 })).status).toBe(201);
    await materializeDueCampaigns();
    expect((await prisma.surveyInvite.findFirstOrThrow()).formId).toBe(p2.id);

    await prisma.surveyInvite.deleteMany();
    expect((await send({})).status).toBe(201);
    await materializeDueCampaigns();
    expect((await prisma.surveyInvite.findFirstOrThrow()).formId).toBe(p1.id);
  });
});
