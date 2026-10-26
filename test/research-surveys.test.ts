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
import {
  GET as templateGet,
  PUT as templatePut,
} from "@/app/api/admin/research-email/template/route";
import { POST as previewPost } from "@/app/api/admin/research-email/preview/route";
import { POST as testPost } from "@/app/api/admin/research-email/test/route";
import { GET as campaignsGet } from "@/app/api/admin/research-email/campaigns/route";
import { DELETE as campaignDelete } from "@/app/api/admin/research-email/campaigns/[id]/route";
import { GET as poolGet } from "@/app/api/admin/research-pool/route";
import { GET as responsesGet } from "@/app/api/admin/surveys/[id]/responses/route";
import { PATCH as surveyPatch } from "@/app/api/admin/surveys/[id]/route";
import {
  deliverResearchEmail,
  materializeDueCampaigns,
  previewRecipients,
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

describe("compensation email", () => {
  async function completed(
    userId: string | null,
    email: string,
    period: number,
    role = "STUDENT",
  ) {
    const form = await prisma.surveyForm.create({
      data: {
        kind: "POST",
        role,
        period,
        title: "Old post-survey",
        isEnabled: false,
      },
    });
    return prisma.surveyResponse.create({
      data: {
        formId: form.id,
        userId,
        kind: "POST",
        role,
        nameSnapshot: "Snapshot Student",
        emailSnapshot: email,
        answers: "{}",
      },
    });
  }
  const audience = (extra = {}) => JSON.stringify({ ...extra });
  const body = {
    kind: "COMPENSATION",
    replyTo: "research@uga.edu",
    versions: {
      STUDENT: {
        subject: "Thanks {{firstName}}",
        body: "Thank you for {{completedSurveys}} ({{completedCount}}). Please reply.",
      },
    },
    audience: { roles: ["TEACHER"], periods: [1], match: "ANY" },
  };

  it("matches ANY/ALL across old forms, uses live details, and describes all completions", async () => {
    const { user } = await createStudent({ email: "live@uga.edu" });
    await completed(user.id, "old@uga.edu", 1);
    await completed(user.id, "old@uga.edu", 2);
    await completed(user.id, "old@uga.edu", 1); // same period, different form
    await completed(null, "GONE@uga.edu", 1);
    await completed(null, "gone@uga.edu", 2);
    await completed(null, "only2@uga.edu", 2);
    await completed(null, "teacher@uga.edu", 1, "TEACHER");
    const plan = await previewRecipients(
      "COMPENSATION",
      audience({ periods: [1] }),
    );
    expect(plan.recipients).toHaveLength(2);
    expect(plan.forms).toEqual([]);
    expect(plan.recipients.find((r) => r.userId === user.id)).toMatchObject({
      email: user.email,
      name: "Stu Student",
      variant: "STUDENT",
      vars: {
        completedCount: "2",
        completedSurveys:
          "the Period 1 post-survey and the Period 2 post-survey",
      },
    });
    expect(
      (await previewRecipients("COMPENSATION", audience({ match: "ALL" })))
        .recipients,
    ).toHaveLength(2);
    expect(
      (await previewRecipients("COMPENSATION", audience({ match: "ANY" })))
        .recipients,
    ).toHaveLength(3);
    const chosen = await previewRecipients(
      "COMPENSATION",
      audience({ people: [user.id, "missing@uga.edu"] }),
    );
    expect(chosen.recipients).toHaveLength(1);
    expect(chosen.skipped.join()).toContain(
      "no completed post-survey in the selected periods, or already emailed",
    );
  });

  it.each([false, true])(
    "merges historical snapshots after re-registration and an email change (accountless response newer: %s)",
    async (accountlessNewer) => {
      const { user: original } = await createStudent({ email: "old@x.edu" });
      const historical = await completed(original.id, " OLD@X.EDU ", 1);
      await prisma.user.delete({ where: { id: original.id } });
      const { user } = await createStudent({ email: "old@x.edu" });
      await completed(user.id, "old@x.edu", 2);
      await prisma.user.update({
        where: { id: user.id },
        data: { email: "new@x.edu" },
      });
      await prisma.surveyResponse.update({
        where: { id: historical.id },
        data: {
          submittedAt: new Date(accountlessNewer ? "2100-01-01" : "2000-01-01"),
        },
      });

      for (const match of ["ANY", "ALL"]) {
        const plan = await previewRecipients(
          "COMPENSATION",
          audience({ periods: [1, 2], match }),
        );
        expect(plan.recipients).toHaveLength(1);
        expect(plan.recipients[0]).toMatchObject({
          userId: user.id,
          email: "new@x.edu",
          name: "Stu Student",
          vars: { completedCount: "2" },
        });
      }
    },
  );

  it.each([false, true])(
    "keeps live users with a shared snapshot separate (current email owner newer: %s)",
    async (currentOwnerNewer) => {
      const { user: first } = await createStudent({ email: "old@x.edu" });
      const firstResponse = await completed(first.id, " OLD@X.EDU ", 1);
      await prisma.user.update({
        where: { id: first.id },
        data: { email: "new@x.edu" },
      });
      const { user: second } = await createStudent({ email: "old@x.edu" });
      await completed(second.id, "old@x.edu", 2);
      await prisma.surveyResponse.update({
        where: { id: firstResponse.id },
        data: {
          submittedAt: new Date(
            currentOwnerNewer ? "2000-01-01" : "2100-01-01",
          ),
        },
      });

      const plan = await previewRecipients(
        "COMPENSATION",
        audience({ periods: [1, 2], match: "ANY" }),
      );
      expect(plan.recipients).toHaveLength(2);
      expect(plan.recipients).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            userId: first.id,
            email: "new@x.edu",
            vars: expect.objectContaining({ completedCount: "1" }),
          }),
          expect.objectContaining({
            userId: second.id,
            email: "old@x.edu",
            vars: expect.objectContaining({ completedCount: "1" }),
          }),
        ]),
      );
      expect(
        (await previewRecipients("COMPENSATION", audience({ match: "ALL" })))
          .recipients,
      ).toHaveLength(0);

      // An ambiguous historical response belongs to the current email owner.
      await completed(null, "old@x.edu", 1);
      const historical = await previewRecipients(
        "COMPENSATION",
        audience({ periods: [1, 2], match: "ALL" }),
      );
      expect(historical.recipients).toHaveLength(1);
      expect(historical.recipients[0]).toMatchObject({
        userId: second.id,
        email: "old@x.edu",
        vars: { completedCount: "2" },
      });
    },
  );

  it.each([false, true])(
    "merges completions after re-registration and prefers live details (accountless response newer: %s)",
    async (accountlessNewer) => {
      const { user: original } = await createStudent({
        email: "return@uga.edu",
      });
      const oldResponse = await completed(original.id, " RETURN@UGA.EDU ", 1);
      await prisma.user.delete({ where: { id: original.id } });
      expect(
        await prisma.surveyResponse.findUniqueOrThrow({
          where: { id: oldResponse.id },
        }),
      ).toMatchObject({ userId: null });
      const { user } = await createStudent({ email: "return@uga.edu" });
      await completed(user.id, "outdated@uga.edu", 2);
      await prisma.surveyResponse.update({
        where: { id: oldResponse.id },
        data: {
          submittedAt: new Date(accountlessNewer ? "2100-01-01" : "2000-01-01"),
        },
      });

      for (const match of ["ANY", "ALL"]) {
        for (const people of [[], [user.id]]) {
          const plan = await previewRecipients(
            "COMPENSATION",
            audience({ periods: [1, 2], match, people }),
          );
          expect(plan.recipients).toHaveLength(1);
          expect(plan.recipients[0]).toMatchObject({
            userId: user.id,
            email: user.email,
            name: "Stu Student",
            vars: {
              firstName: "Stu",
              completedCount: "2",
              completedSurveys:
                "the Period 1 post-survey and the Period 2 post-survey",
            },
          });
          expect(plan.skipped).toEqual([]);
        }
      }
    },
  );

  it("allows pending deliveries from cancelled campaigns but still excludes sent deliveries", async () => {
    const admin = await createAdmin();
    asUser(admin);
    const campaign = await prisma.researchEmailCampaign.create({
      data: {
        kind: "COMPENSATION",
        replyTo: "r@uga.edu",
        appOrigin: "http://localhost",
        scheduledAt: new Date(),
        status: "SENDING",
      },
    });
    for (const status of ["PENDING", "SENT", "FAILED"]) {
      const email = `${status.toLowerCase()}@uga.edu`;
      await completed(null, email, 1);
      await prisma.researchEmailDelivery.create({
        data: {
          campaignId: campaign.id,
          recipient: email,
          variant: "STUDENT",
          status,
        },
      });
    }
    expect(
      (await previewRecipients("COMPENSATION", audience())).recipients.map(
        (r) => r.email,
      ),
    ).toEqual(["failed@uga.edu"]);
    expect(
      (
        await campaignDelete(new NextRequest("http://localhost"), {
          params: Promise.resolve({ id: campaign.id }),
        })
      ).status,
    ).toBe(200);
    expect(
      await prisma.researchEmailDelivery.count({
        where: { campaignId: campaign.id, status: "PENDING" },
      }),
    ).toBe(1);
    const replacement = await previewRecipients("COMPENSATION", audience());
    expect(replacement.recipients.map((r) => r.email).sort()).toEqual([
      "failed@uga.edu",
      "pending@uga.edu",
    ]);
    expect(replacement.skipped.join()).toContain("1 student was skipped");
  });

  it("skips prior sent/pending by user ID or case-insensitive email, but permits failed and other kinds", async () => {
    const { user } = await createStudent();
    await completed(user.id, user.email, 1);
    for (const email of ["gone@uga.edu", "failed@uga.edu", "pool@uga.edu"])
      await completed(null, email, 1);
    const prior = await prisma.researchEmailCampaign.create({
      data: {
        kind: "COMPENSATION",
        replyTo: "r@uga.edu",
        appOrigin: "http://localhost",
        scheduledAt: new Date(),
        status: "SENT",
      },
    });
    for (const data of [
      { userId: user.id, recipient: "old@uga.edu", status: "PENDING" },
      { userId: null, recipient: "GONE@UGA.EDU", status: "SENT" },
      { userId: null, recipient: "failed@uga.edu", status: "FAILED" },
    ])
      await prisma.researchEmailDelivery.create({
        data: { ...data, campaignId: prior.id, variant: "STUDENT" },
      });
    const pool = await prisma.researchEmailCampaign.create({
      data: {
        kind: "POOL",
        replyTo: "r@uga.edu",
        appOrigin: "http://localhost",
        scheduledAt: new Date(),
        status: "SENT",
      },
    });
    await prisma.researchEmailDelivery.create({
      data: {
        campaignId: pool.id,
        recipient: "pool@uga.edu",
        variant: "STUDENT_SURVEY",
        status: "SENT",
      },
    });
    const plan = await previewRecipients("COMPENSATION", audience());
    expect(plan.recipients.map((r) => r.email).sort()).toEqual([
      "failed@uga.edu",
      "pool@uga.edu",
    ]);
    expect(plan.skipped.join()).toContain("2 students were skipped");
    expect(
      (
        await previewRecipients(
          "COMPENSATION",
          audience({ excludePreviouslyEmailed: false }),
        )
      ).recipients,
    ).toHaveLength(4);
  });

  it("supports drafts, previews, test sends, history, cancellation and background delivery without invites", async () => {
    const admin = await createAdmin();
    const { user } = await createStudent();
    await completed(user.id, user.email, 1);
    asUser(admin);
    expect(
      (
        await templatePut(
          jsonReq("/api/admin/research-email/template", body, "PUT"),
        )
      ).status,
    ).toBe(200);
    const template = await (
      await templateGet(
        new NextRequest(
          "http://localhost/api/admin/research-email/template?kind=COMPENSATION",
        ),
      )
    ).json();
    expect(template.audience).toMatchObject({
      roles: ["STUDENT"],
      periods: [1],
      match: "ANY",
      excludePreviouslyEmailed: true,
    });
    expect(
      await (
        await previewPost(jsonReq("/api/admin/research-email/preview", body))
      ).json(),
    ).toMatchObject({ count: 1, byVersion: { STUDENT: 1 }, forms: [] });
    expect(
      (
        await testPost(
          jsonReq("/api/admin/research-email/test", {
            ...body,
            to: "admin@uga.edu",
          }),
        )
      ).status,
    ).toBe(200);
    expect(mockSend.mock.calls[0][0].text).toContain(
      "the Period 1 post-survey and the Period 2 post-survey (2)",
    );
    const created = await campaignPost(
      jsonReq("/api/admin/research-email/campaigns", body),
    );
    expect(created.status).toBe(201);
    const ids = await materializeDueCampaigns();
    expect(ids).toHaveLength(1);
    expect(await prisma.surveyInvite.count()).toBe(0);
    expect(await deliverResearchEmail(ids[0])).toEqual({ status: "SENT" });
    expect(mockSend.mock.calls.at(-1)![0]).toMatchObject({
      to: user.email,
      replyTo: body.replyTo,
      text: "Thank you for the Period 1 post-survey (1). Please reply.",
    });
    expect(
      (await previewRecipients("COMPENSATION", audience())).recipients,
    ).toEqual([]);
    const history = await (
      await campaignsGet(
        new NextRequest(
          "http://localhost/api/admin/research-email/campaigns?kind=COMPENSATION",
        ),
      )
    ).json();
    expect(history.campaigns[0]).toMatchObject({ sent: 1, pending: 0 });
    const next = await (
      await campaignPost(jsonReq("/api/admin/research-email/campaigns", body))
    ).json();
    expect(
      (
        await campaignDelete(new NextRequest("http://localhost"), {
          params: Promise.resolve({ id: next.campaign.id }),
        })
      ).status,
    ).toBe(200);
  });
});
