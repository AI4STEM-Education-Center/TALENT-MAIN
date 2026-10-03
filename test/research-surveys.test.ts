import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/queue", async (orig) => ({
  ...(await orig<typeof import("@/lib/queue")>()),
  enqueueResearchEmails: vi.fn(),
  enqueueSurveyExtraction: vi.fn(),
}));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmailToRecipient: vi.fn(async () => undefined),
  getSenderOverride: vi.fn(async () => null),
}));

import { GET as preGet, POST as prePost } from "@/app/api/surveys/pre/route";
import { POST as dismissPost } from "@/app/api/surveys/pre/dismiss/route";
import {
  GET as inviteGet,
  POST as invitePost,
} from "@/app/api/surveys/invite/[token]/route";
import { POST as campaignPost } from "@/app/api/admin/research-email/campaigns/route";
import { GET as poolGet } from "@/app/api/admin/research-pool/route";
import { GET as responsesGet } from "@/app/api/admin/surveys/[id]/responses/route";
import { PATCH as surveyPatch } from "@/app/api/admin/surveys/[id]/route";
import {
  deliverResearchEmail,
  materializeDueCampaigns,
} from "@/lib/research-email-server";
import { auth } from "@/lib/auth";
import { sendEmailToRecipient } from "@/lib/email";
import { prisma } from "@/lib/prisma";
import { findSurveyTemplate } from "@/lib/survey-templates";
import { resetDb, createStudent, createAdmin } from "./db";

const mockAuth = vi.mocked(auth);
const mockSend = vi.mocked(sendEmailToRecipient);

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
    },
  });
}

async function enabledForm(kind: "PRE" | "POST") {
  const template = findSurveyTemplate(
    kind === "PRE" ? "student-pre" : "student-post",
  )!;
  return prisma.surveyForm.create({
    data: {
      kind,
      role: "STUDENT",
      title: template.title,
      questions: JSON.stringify(template.questions),
      isEnabled: true,
    },
  });
}

/** Answer every required question with its first option / some text. */
function answersFor(questions: string) {
  const answers: Record<string, string | string[]> = {};
  for (const q of JSON.parse(questions)) {
    if (q.type === "section" || !q.required) continue;
    answers[q.id] =
      q.type === "multi" ? [q.options[0]] : (q.options[0] ?? "Some answer");
  }
  return answers;
}

beforeEach(async () => {
  await resetDb();
  mockAuth.mockReset();
  mockSend.mockClear();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("pre-survey gate", () => {
  it("waits for the consent decision, then is mandatory after an IRB agree", async () => {
    const { user } = await createStudent();
    const consent = await consentForm();
    const form = await enabledForm("PRE");
    asUser(user);

    expect(await (await preGet()).json()).toEqual({ state: "CONSENT_PENDING" });

    await decide(user.id, consent.id, "AGREE");
    const due = await (await preGet()).json();
    expect(due).toMatchObject({
      state: "DUE",
      mandatory: true,
      defaultEmail: user.email,
    });
    expect(due.form.id).toBe(form.id);

    const refused = await dismissPost(jsonReq("/api/surveys/pre/dismiss", {}));
    expect(refused.status).toBe(403);
  });

  it("is optional after a decline and can be dismissed for good", async () => {
    const { user } = await createStudent();
    const consent = await consentForm();
    await enabledForm("PRE");
    await decide(user.id, consent.id, "DECLINE");
    asUser(user);

    expect(await (await preGet()).json()).toMatchObject({
      state: "DUE",
      mandatory: false,
    });
    expect(
      (await dismissPost(jsonReq("/api/surveys/pre/dismiss", {}))).status,
    ).toBe(200);
    expect(await (await preGet()).json()).toMatchObject({ state: "NONE" });
  });

  it("stores the response once and puts an interview opt-in into the pool", async () => {
    const { user } = await createStudent();
    const admin = await createAdmin();
    const consent = await consentForm();
    const form = await enabledForm("PRE");
    await decide(user.id, consent.id, "DECLINE");
    asUser(user);

    const missing = await prePost(
      jsonReq("/api/surveys/pre", { formId: form.id, answers: {} }),
    );
    expect(missing.status).toBe(400);
    expect((await missing.json()).questionId).toBeTruthy();

    const body = {
      formId: form.id,
      answers: answersFor(form.questions),
      interviewOptIn: true,
      interviewEmail: "stu.personal@gmail.com",
    };
    expect((await prePost(jsonReq("/api/surveys/pre", body))).status).toBe(200);
    expect((await prePost(jsonReq("/api/surveys/pre", body))).status).toBe(200);
    expect(await prisma.surveyResponse.count()).toBe(1);
    expect(await (await preGet()).json()).toMatchObject({ state: "NONE" });

    asUser(admin);
    const pool = await (
      await poolGet(new NextRequest("http://localhost/api/admin/research-pool"))
    ).json();
    expect(pool.entries).toHaveLength(1);
    expect(pool.entries[0]).toMatchObject({
      viaIrb: false,
      viaSurvey: true,
      email: "stu.personal@gmail.com",
    });

    const csv = await responsesGet(
      new NextRequest(
        `http://localhost/api/admin/surveys/${form.id}/responses?format=csv`,
      ),
      { params: Promise.resolve({ id: form.id }) },
    );
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(await csv.text()).toContain("stu.personal@gmail.com");
  });
});

describe("enabling a survey", () => {
  it("keeps exactly one enabled form per type and audience", async () => {
    const admin = await createAdmin();
    const first = await enabledForm("PRE");
    const second = await enabledForm("PRE");
    await prisma.surveyForm.update({
      where: { id: second.id },
      data: { isEnabled: false },
    });
    asUser(admin);
    const res = await surveyPatch(
      jsonReq(`/api/admin/surveys/${second.id}`, { isEnabled: true }, "PATCH"),
      { params: Promise.resolve({ id: second.id }) },
    );
    expect(res.status).toBe(200);
    const enabled = await prisma.surveyForm.findMany({
      where: { isEnabled: true },
      select: { id: true },
    });
    expect(enabled.map((f) => f.id)).toEqual([second.id]);
    expect(first.id).not.toBe(second.id);
  });
});

describe("post-survey email", () => {
  it("sends each person a personal link that works once without signing in", async () => {
    const admin = await createAdmin();
    const { user: agreed } = await createStudent({ email: "agreed@uga.edu" });
    const { user: other } = await createStudent({ email: "other@uga.edu" });
    const consent = await consentForm();
    await decide(agreed.id, consent.id, "AGREE");
    const post = await enabledForm("POST");

    asUser(admin);
    const created = await campaignPost(
      jsonReq("/api/admin/research-email/campaigns", {
        kind: "POST_SURVEY",
        replyTo: "",
        versions: {
          STUDENT: {
            subject: "Thanks {{firstName}}",
            body: "Dear {{role}},\n{{surveyLink}}",
          },
          TEACHER: { subject: "", body: "" },
        },
        attachments: [],
        audience: { roles: ["STUDENT"], target: "ALL" },
      }),
    );
    expect(created.status).toBe(201);

    const deliveryIds = await materializeDueCampaigns();
    expect(deliveryIds).toHaveLength(2);
    for (const id of deliveryIds)
      expect(await deliverResearchEmail(id)).toEqual({ status: "SENT" });

    const byRecipient = new Map(
      mockSend.mock.calls.map(([opts]) => [opts.to, opts]),
    );
    // One student version for everyone, IRB or not; no reply-to needed.
    const irbMail = byRecipient.get("agreed@uga.edu")!;
    expect(irbMail.subject).toBe("Thanks Stu");
    expect(irbMail.replyTo).toBeUndefined();
    expect(irbMail.text).toContain("Dear Student");
    const surveyMail = byRecipient.get("other@uga.edu")!;
    expect(surveyMail.subject).toBe("Thanks Stu");

    const token = /\/survey\/([A-Za-z0-9_-]+)/.exec(irbMail.text)![1];
    const params = { params: Promise.resolve({ token }) };
    const opened = await (
      await inviteGet(
        new NextRequest(`http://localhost/api/surveys/invite/${token}`),
        params,
      )
    ).json();
    expect(opened).toMatchObject({ submitted: false, name: "Stu" });

    const submit = await invitePost(
      jsonReq(`/api/surveys/invite/${token}`, {
        answers: answersFor(post.questions),
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(submit.status).toBe(200);
    const response = await prisma.surveyResponse.findFirstOrThrow();
    expect(response).toMatchObject({
      userId: agreed.id,
      source: "LINK",
      kind: "POST",
      irbAgreed: true,
    });

    const reopened = await (
      await inviteGet(
        new NextRequest(`http://localhost/api/surveys/invite/${token}`),
        { params: Promise.resolve({ token }) },
      )
    ).json();
    expect(reopened.submitted).toBe(true);

    // The plaintext link is scrubbed from the delivery once sent.
    const rows = await prisma.researchEmailDelivery.findMany();
    expect(rows.every((r) => !r.vars.includes(token))).toBe(true);

    // A reminder skips people who already answered.
    await campaignPost(
      jsonReq("/api/admin/research-email/campaigns", {
        kind: "POST_SURVEY",
        replyTo: "",
        versions: { STUDENT: { subject: "Reminder", body: "{{surveyLink}}" } },
        attachments: [],
        audience: { roles: ["STUDENT"], target: "ALL" },
      }),
    );
    expect(await materializeDueCampaigns()).toHaveLength(1);
    expect(other.id).toBeTruthy();
  });

  it("rejects an unknown link", async () => {
    const res = await inviteGet(
      new NextRequest(
        "http://localhost/api/surveys/invite/nope-nope-nope-nope",
      ),
      { params: Promise.resolve({ token: "nope-nope-nope-nope" }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("interview email", () => {
  it("reaches only people who agreed to an interview, with the version for their route", async () => {
    const admin = await createAdmin();
    const consent = await consentForm();
    const pre = await enabledForm("PRE");
    const { user: irbYes } = await createStudent({ email: "irb@uga.edu" });
    const { user: irbNo } = await createStudent({
      email: "nointerview@uga.edu",
    });
    const { user: optedIn } = await createStudent({ email: "optin@uga.edu" });
    await createStudent({ email: "nobody@uga.edu" });
    await decide(irbYes.id, consent.id, "AGREE");
    await decide(irbNo.id, consent.id, "AGREE");
    await prisma.consentRecord.updateMany({
      where: { userId: irbNo.id },
      data: { interviewRecordingChoice: "NO_INTERVIEW" },
    });
    asUser(optedIn);
    expect(
      (
        await prePost(
          jsonReq("/api/surveys/pre", {
            formId: pre.id,
            answers: answersFor(pre.questions),
            interviewOptIn: true,
            interviewEmail: "optin@uga.edu",
          }),
        )
      ).status,
    ).toBe(200);

    asUser(admin);
    const body = {
      kind: "POOL",
      replyTo: "",
      versions: {
        STUDENT_IRB: {
          subject: "IRB {{firstName}}",
          body: "Level: {{consentLevel}}",
        },
        STUDENT_SURVEY: {
          subject: "Survey {{firstName}}",
          body: "Via {{agreedPlace}}",
        },
      },
      attachments: [],
      audience: { roles: ["STUDENT"], sources: ["IRB", "SURVEY"] },
    };
    // The interview email needs somewhere for replies to go.
    expect(
      (await campaignPost(jsonReq("/api/admin/research-email/campaigns", body)))
        .status,
    ).toBe(400);
    const created = await campaignPost(
      jsonReq("/api/admin/research-email/campaigns", {
        ...body,
        replyTo: "interviews@uga.edu",
      }),
    );
    expect(created.status).toBe(201);

    const ids = await materializeDueCampaigns();
    expect(ids).toHaveLength(2);
    for (const id of ids)
      expect(await deliverResearchEmail(id)).toEqual({ status: "SENT" });
    const byRecipient = new Map(
      mockSend.mock.calls.map(([opts]) => [opts.to, opts]),
    );
    expect([...byRecipient.keys()].sort()).toEqual([
      "irb@uga.edu",
      "optin@uga.edu",
    ]);
    expect(byRecipient.get("irb@uga.edu")).toMatchObject({
      subject: "IRB Stu",
      replyTo: "interviews@uga.edu",
    });
    expect(byRecipient.get("irb@uga.edu")!.text).toContain("audio-only");
    expect(byRecipient.get("optin@uga.edu")).toMatchObject({
      subject: "Survey Stu",
      text: "Via the pre-survey",
    });
  });
});

describe("research contact email", () => {
  it.each([
    ["POOL", "POOL"],
    ["POST_SURVEY", "ALL"],
    ["POST_SURVEY", "PRE_COMPLETED"],
    ["POST_SURVEY", "POOL"],
  ])(
    "uses the chosen address for %s / %s without changing login",
    async (kind, target) => {
      const { user } = await createStudent();
      const admin = await createAdmin();
      const pre = await enabledForm("PRE");
      await enabledForm("POST");
      asUser(user);
      const result = await prePost(
        jsonReq("/api/surveys/pre", {
          formId: pre.id,
          answers: answersFor(pre.questions),
          interviewOptIn: true,
          interviewEmail: " personal@example.com ",
        }),
      );
      expect(result.status).toBe(200);
      expect(
        await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      ).toMatchObject({ email: user.email });
      expect(await prisma.surveyResponse.findFirstOrThrow()).toMatchObject({
        interviewEmail: "personal@example.com",
        emailSnapshot: user.email,
      });
      asUser(admin);
      const campaign = await campaignPost(
        jsonReq("/api/admin/research-email/campaigns", {
          kind,
          replyTo: "research@uga.edu",
          versions: {
            STUDENT: { subject: "Research", body: "Follow up {{surveyLink}}" },
            STUDENT_IRB: { subject: "Research", body: "Follow up" },
            STUDENT_SURVEY: { subject: "Research", body: "Follow up" },
          },
          attachments: [],
          audience: { roles: ["STUDENT"], target, sources: ["IRB", "SURVEY"] },
        }),
      );
      expect(campaign.status).toBe(201);
      const ids = await materializeDueCampaigns();
      expect(ids).toHaveLength(1);
      expect(await deliverResearchEmail(ids[0])).toEqual({ status: "SENT" });
      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ to: "personal@example.com" }),
      );
      if (kind === "POST_SURVEY") {
        expect(await prisma.surveyInvite.findFirstOrThrow()).toMatchObject({
          email: "personal@example.com",
          userId: user.id,
        });
      }
    },
  );

  it.each(["", "bad-email"])(
    "rejects an invalid explicit contact email: %s",
    async (email) => {
      const { user } = await createStudent();
      const pre = await enabledForm("PRE");
      asUser(user);
      const result = await prePost(
        jsonReq("/api/surveys/pre", {
          formId: pre.id,
          answers: answersFor(pre.questions),
          interviewOptIn: true,
          interviewEmail: email,
        }),
      );
      expect(result.status).toBe(400);
      expect(await prisma.surveyResponse.count()).toBe(0);
    },
  );
});
