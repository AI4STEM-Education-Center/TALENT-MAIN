import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/queue", () => ({
  enqueueVariantEmails: vi.fn(),
  enqueueQuizVariant: vi.fn(),
}));
vi.mock("@/lib/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email")>()),
  sendEmailToRecipient: vi.fn(),
  getSenderOverride: vi.fn(async () => null),
}));
import { prisma } from "@/lib/prisma";
import { enqueueVariantEmails } from "@/lib/queue";
import { sendEmailToRecipient } from "@/lib/email";
import {
  VARIANT_EMAIL_MAX_ATTEMPTS,
  deliverVariantEmail,
  failExhaustedVariantEmails,
  findStrandedVariantEmails,
  notifyVariantBatchIfComplete,
  recordVariantBatchState,
  sweepUnapprovedVariantReminders,
  variantBatchReviewPath,
} from "@/lib/quiz-variant-notifications";
import { createTeacher, resetDb } from "./db";

const HOUR = 60 * 60_000;

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
});

async function round(
  statuses: string[],
  role: "TEACHER" | "ADMIN" = "TEACHER",
) {
  const teacher = await createTeacher();
  const quiz = await prisma.quiz.create({ data: { name: "Kinematics 2" } });
  const batchId = `batch-${Math.random().toString(36).slice(2)}`;
  const drafts = [];
  for (const [i, status] of statuses.entries())
    drafts.push(
      await prisma.quizPracticeVersion.create({
        data: {
          quizId: quiz.id,
          name: `Version ${i + 1}`,
          variation: i % 2 ? "CONTEXT" : "NUMBERS",
          status,
          batchId,
          slotIndex: i,
          sourceSnapshot: "[]",
          objectives: "[]",
        },
      }),
    );
  await prisma.$transaction((tx) =>
    recordVariantBatchState(tx, {
      batchId,
      quizId: quiz.id,
      requestedById: teacher.user.id,
      recipientRole: role,
      appOrigin: "https://app.example",
      kind: "INITIAL",
    }),
  );
  return { teacher, quiz, batchId, drafts };
}

const setStatus = (id: string, status: string) =>
  prisma.quizPracticeVersion.update({ where: { id }, data: { status } });

describe("ready notifications", () => {
  it("builds role-specific review paths", () => {
    expect(variantBatchReviewPath("ADMIN", "q", "b")).toBe(
      "/admin/quizzes/q/versions/b",
    );
    expect(variantBatchReviewPath("TEACHER", "q", "b")).toBe(
      "/teacher/quizzes/q/versions/b",
    );
  });

  it("waits for every draft, then notifies exactly once", async () => {
    const r = await round(["REVIEW", "REVIEW", "FAILED", "GENERATING"]);
    expect(await notifyVariantBatchIfComplete(r.batchId)).toEqual({
      notified: false,
    });
    await setStatus(r.drafts[3].id, "QUEUED");
    expect((await notifyVariantBatchIfComplete(r.batchId)).notified).toBe(
      false,
    );
    expect(await prisma.notification.count()).toBe(0);

    await setStatus(r.drafts[3].id, "REVIEW");
    const results = await Promise.all([
      notifyVariantBatchIfComplete(r.batchId),
      notifyVariantBatchIfComplete(r.batchId),
    ]);
    expect(results.filter((x) => x.notified)).toHaveLength(1);
    expect((await notifyVariantBatchIfComplete(r.batchId)).notified).toBe(
      false,
    );

    const notes = await prisma.notification.findMany();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      userId: r.teacher.user.id,
      messageId: null,
      kind: "QUIZ_VARIANTS_READY",
      subject: "Alternative versions ready to review for Kinematics 2",
      href: `/teacher/quizzes/${r.quiz.id}/versions/${r.batchId}`,
    });
    expect(notes[0].body).toContain("3 of 4 versions");
    expect(notes[0].body).toContain("1 draft needs your attention");

    const deliveries = await prisma.quizVariantEmailDelivery.findMany();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      batchId: r.batchId,
      cycle: 1,
      kind: "READY",
      recipient: r.teacher.user.email.toLowerCase(),
    });
    expect(JSON.parse(deliveries[0].payload).reviewUrl).toBe(
      `https://app.example/teacher/quizzes/${r.quiz.id}/versions/${r.batchId}`,
    );
    expect(enqueueVariantEmails).toHaveBeenCalledWith([deliveries[0].id]);
  });

  it("links admins to the admin review page", async () => {
    const r = await round(["REVIEW"], "ADMIN");
    await notifyVariantBatchIfComplete(r.batchId);
    expect((await prisma.notification.findFirstOrThrow()).href).toBe(
      `/admin/quizzes/${r.quiz.id}/versions/${r.batchId}`,
    );
  });

  it("keeps the in-app notice when the queue is unavailable", async () => {
    vi.mocked(enqueueVariantEmails).mockImplementationOnce(() => {
      throw new Error("queue down");
    });
    const r = await round(["REVIEW"]);
    expect((await notifyVariantBatchIfComplete(r.batchId)).notified).toBe(true);
    expect(await prisma.notification.count()).toBe(1);
    expect(
      (await prisma.quizVariantEmailDelivery.findFirstOrThrow()).status,
    ).toBe("PENDING");
  });

  it("fires one fresh notice after a revision cycle settles", async () => {
    const r = await round(["REVIEW", "REVIEW"]);
    await notifyVariantBatchIfComplete(r.batchId);
    // "Submit all revisions": both drafts are replaced in one transaction.
    await prisma.$transaction(async (tx) => {
      for (const d of r.drafts) {
        await tx.quizPracticeVersion.update({
          where: { id: d.id },
          data: { status: "DISCARDED" },
        });
        await tx.quizPracticeVersion.create({
          data: {
            quizId: r.quiz.id,
            name: d.name,
            variation: d.variation,
            batchId: r.batchId,
            slotIndex: d.slotIndex,
            revisedFromId: d.id,
            sourceSnapshot: "[]",
            objectives: "[]",
          },
        });
      }
      await recordVariantBatchState(tx, {
        batchId: r.batchId,
        quizId: r.quiz.id,
        requestedById: r.teacher.user.id,
        recipientRole: "TEACHER",
        kind: "REVISION",
      });
    });
    const state = await prisma.quizVariantBatchState.findUniqueOrThrow({
      where: { batchId: r.batchId },
    });
    expect(state).toMatchObject({
      cycle: 2,
      kind: "REVISION",
      readyNotifiedCycle: 1,
      readyNotifiedAt: null,
    });
    const revised = await prisma.quizPracticeVersion.findMany({
      where: { batchId: r.batchId, status: "QUEUED" },
    });
    await setStatus(revised[0].id, "REVIEW");
    expect((await notifyVariantBatchIfComplete(r.batchId)).notified).toBe(
      false,
    );
    await setStatus(revised[1].id, "REVIEW");
    expect((await notifyVariantBatchIfComplete(r.batchId)).notified).toBe(true);
    expect((await notifyVariantBatchIfComplete(r.batchId)).notified).toBe(
      false,
    );
    const notes = await prisma.notification.findMany({
      orderBy: { createdAt: "asc" },
    });
    expect(notes).toHaveLength(2);
    expect(notes[1].subject).toBe("Revisions ready to review for Kinematics 2");
    expect(
      await prisma.quizVariantEmailDelivery.count({ where: { cycle: 2 } }),
    ).toBe(1);
  });

  it("ignores rounds that were never tracked", async () => {
    expect((await notifyVariantBatchIfComplete("unknown")).notified).toBe(
      false,
    );
  });
});

describe("unapproved-draft reminders", () => {
  async function readyRound(statuses: string[], readyAt: Date) {
    const r = await round(statuses);
    await notifyVariantBatchIfComplete(r.batchId, readyAt);
    vi.mocked(enqueueVariantEmails).mockClear();
    return r;
  }

  it("sends a 24h then a 72h reminder while drafts await review, then stops", async () => {
    const start = new Date("2026-11-01T12:00:00Z");
    const r = await readyRound(["REVIEW", "REVIEW", "FAILED"], start);
    const at = (h: number) => new Date(start.getTime() + h * HOUR);

    expect((await sweepUnapprovedVariantReminders(at(23))).sent).toBe(0);
    expect((await sweepUnapprovedVariantReminders(at(24))).sent).toBe(1);
    expect((await sweepUnapprovedVariantReminders(at(30))).sent).toBe(0);
    expect((await sweepUnapprovedVariantReminders(at(72))).sent).toBe(1);
    expect((await sweepUnapprovedVariantReminders(at(500))).sent).toBe(0);

    const reminders = await prisma.notification.findMany({
      where: { kind: "QUIZ_VARIANTS_REMINDER" },
      orderBy: { createdAt: "asc" },
    });
    expect(reminders).toHaveLength(2);
    expect(reminders[0].subject).toContain("2 drafts");
    expect(reminders[0].href).toBe(
      `/teacher/quizzes/${r.quiz.id}/versions/${r.batchId}`,
    );
    const deliveries = await prisma.quizVariantEmailDelivery.findMany({
      where: { kind: { not: "READY" } },
      orderBy: { createdAt: "asc" },
    });
    expect(deliveries.map((d) => d.kind)).toEqual([
      "REMINDER_24H",
      "REMINDER_72H",
    ]);
    expect(JSON.parse(deliveries[1].payload)).toMatchObject({
      pendingCount: 2,
      ageLabel: "3 days",
    });
    expect(enqueueVariantEmails).toHaveBeenCalledTimes(2);
  });

  it("settles silently once every draft is approved or discarded", async () => {
    const start = new Date("2026-11-01T12:00:00Z");
    const r = await readyRound(["REVIEW", "REVIEW"], start);
    await setStatus(r.drafts[0].id, "PUBLISHED");
    await setStatus(r.drafts[1].id, "DISCARDED");
    const result = await sweepUnapprovedVariantReminders(
      new Date(start.getTime() + 25 * HOUR),
    );
    expect(result).toEqual({ sent: 0, settled: 1 });
    expect(
      await prisma.notification.count({
        where: { kind: "QUIZ_VARIANTS_REMINDER" },
      }),
    ).toBe(0);
    const state = await prisma.quizVariantBatchState.findUniqueOrThrow({
      where: { batchId: r.batchId },
    });
    expect(state.reminder24hSentAt).not.toBeNull();
    expect(state.reminder72hSentAt).not.toBeNull();
    expect(
      (
        await sweepUnapprovedVariantReminders(
          new Date(start.getTime() + 80 * HOUR),
        )
      ).sent,
    ).toBe(0);
  });

  it("skips a round that has drafts regenerating again", async () => {
    const start = new Date("2026-11-01T12:00:00Z");
    const r = await readyRound(["REVIEW", "REVIEW"], start);
    await setStatus(r.drafts[1].id, "GENERATING");
    expect(
      (
        await sweepUnapprovedVariantReminders(
          new Date(start.getTime() + 25 * HOUR),
        )
      ).sent,
    ).toBe(0);
  });

  it("sends only one reminder when the 24h window was missed past 72h", async () => {
    const start = new Date("2026-11-01T12:00:00Z");
    await readyRound(["REVIEW"], start);
    const late = new Date(start.getTime() + 100 * HOUR);
    expect((await sweepUnapprovedVariantReminders(late)).sent).toBe(1);
    expect(
      (
        await sweepUnapprovedVariantReminders(
          new Date(late.getTime() + 10 * HOUR),
        )
      ).sent,
    ).toBe(0);
    expect(
      (await prisma.quizVariantEmailDelivery.findMany())
        .map((d) => d.kind)
        .sort(),
    ).toEqual(["READY", "REMINDER_72H"]);
  });
});

describe("variant email delivery", () => {
  async function pendingDelivery(kind = "READY") {
    const r = await round(["REVIEW"]);
    return prisma.quizVariantEmailDelivery.create({
      data: {
        batchId: r.batchId,
        kind,
        recipient: "t@example.com",
        payload: JSON.stringify({
          appName: "AI4Talent",
          firstName: "Tess",
          quizName: "Kinematics 2",
          readyHeading: "Alternative versions ready to review",
          summaryLine: "1 of 1 version is ready.",
          pendingCount: 1,
          ageLabel: "1 day",
          reviewUrl: "https://app.example/teacher/quizzes/q/versions/b",
        }),
      },
    });
  }

  it("sends once through the quiz-variant purpose", async () => {
    const d = await pendingDelivery();
    expect(await deliverVariantEmail(d.id)).toEqual({ status: "SENT" });
    expect(await deliverVariantEmail(d.id)).toMatchObject({
      status: "SKIPPED",
    });
    expect(sendEmailToRecipient).toHaveBeenCalledOnce();
    expect(vi.mocked(sendEmailToRecipient).mock.calls[0][0]).toMatchObject({
      to: "t@example.com",
      purpose: "QUIZ_VARIANTS_READY",
      subject: "Alternative versions ready to review for Kinematics 2",
    });
  });

  it("backs off transient failures and gives up on permanent ones", async () => {
    const d = await pendingDelivery("REMINDER_24H");
    vi.mocked(sendEmailToRecipient).mockRejectedValueOnce(new Error("busy"));
    expect(await deliverVariantEmail(d.id)).toMatchObject({
      status: "RETRY",
      delaySeconds: 60,
    });
    vi.mocked(sendEmailToRecipient).mockRejectedValueOnce(
      Object.assign(new Error("no mailbox"), { responseCode: 550 }),
    );
    expect(await deliverVariantEmail(d.id)).toMatchObject({ status: "FAILED" });
  });

  it("drops a reminder when nothing awaits review anymore", async () => {
    const d = await pendingDelivery("REMINDER_72H");
    await prisma.quizPracticeVersion.updateMany({
      where: { batchId: d.batchId },
      data: { status: "PUBLISHED" },
    });
    expect((await deliverVariantEmail(d.id)).status).toBe("SKIPPED");
    expect(sendEmailToRecipient).not.toHaveBeenCalled();
  });

  it("finds stranded rows and closes out exhausted ones", async () => {
    const d = await pendingDelivery();
    const now = new Date(Date.now() + 10 * 60_000);
    expect(await findStrandedVariantEmails(200, now)).toEqual([d.id]);
    await prisma.quizVariantEmailDelivery.update({
      where: { id: d.id },
      data: { attempts: VARIANT_EMAIL_MAX_ATTEMPTS },
    });
    expect(await findStrandedVariantEmails(200, now)).toEqual([]);
    expect(await failExhaustedVariantEmails(now)).toBe(1);
    expect(
      (
        await prisma.quizVariantEmailDelivery.findUniqueOrThrow({
          where: { id: d.id },
        })
      ).status,
    ).toBe("FAILED");
  });
});
