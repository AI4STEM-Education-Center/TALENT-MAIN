import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getSenderOverride,
  sendEmailToRecipient,
  SmtpNotConfiguredError,
} from "@/lib/email";
import {
  APP_NAME,
  isEmailAddress,
  renderPurposeMessage,
  type EmailPurpose,
} from "@/lib/email-purposes";
import { resolveAppUrl } from "@/lib/message-email";
import { enqueueVariantEmails } from "@/lib/queue";
import { errorMessage } from "@/lib/errors";

/**
 * Completion notices and unapproved-draft reminders for alternative quiz
 * version rounds (one `batchId`).
 *
 * QuizVariantBatchState tracks one row per round. Each generation request or
 * atomic revision bumps `cycle`; exactly one "ready" notification fires per
 * cycle, and only once no draft in the round is still QUEUED or GENERATING —
 * a round of four drafts never pings the teacher four times. While drafts sit
 * in REVIEW, the worker sweeper sends at most two reminders (24h, then 72h).
 *
 * Emails go through QuizVariantEmailDelivery, a durable outbox with the same
 * claim/backoff/retry shape as ConsentEmailDelivery. These are system notices
 * to the requesting teacher/admin, so no class-announcement quota applies.
 */

export const VARIANT_EMAIL_MAX_ATTEMPTS = 5;
export const VARIANT_EMAIL_LEASE_MS = 5 * 60_000;
export const VARIANT_EMAIL_SWEEP_GRACE_MS = 5 * 60_000;
const BACKOFF_SECONDS = [60, 300, 900, 3600];
const MAX_ERROR_LENGTH = 300;
const HOUR_MS = 60 * 60_000;
export const REMINDER_24H_MS = 24 * HOUR_MS;
export const REMINDER_72H_MS = 72 * HOUR_MS;

const IN_FLIGHT = ["QUEUED", "GENERATING"];
const REPORTED = ["REVIEW", "FAILED", "PUBLISHED", "STANDALONE"];

type Db = Prisma.TransactionClient;

export type VariantRecipientRole = "TEACHER" | "ADMIN";
export type VariantBatchKind = "INITIAL" | "REVISION";
export type VariantEmailKind = "READY" | "REMINDER_24H" | "REMINDER_72H";

/** In-app path of the round's review page for this recipient. */
export function variantBatchReviewPath(
  recipientRole: string,
  quizId: string,
  batchId: string,
): string {
  const area = recipientRole === "ADMIN" ? "admin" : "teacher";
  return `/${area}/quizzes/${encodeURIComponent(quizId)}/versions/${encodeURIComponent(batchId)}`;
}

function absoluteUrl(appOrigin: string | null | undefined, path: string) {
  const base = (appOrigin?.trim() || resolveAppUrl() || "").replace(/\/+$/, "");
  return base ? `${base}${path}` : path;
}

/**
 * Start (or restart) notification tracking for a round inside the caller's
 * transaction. A brand-new round starts at cycle 1; any later request against
 * the same round (more drafts, a revision) bumps the cycle and clears the
 * ready/reminder markers so exactly one fresh notice fires once it settles.
 */
export async function recordVariantBatchState(
  tx: Db,
  opts: {
    batchId: string;
    quizId: string;
    requestedById: string;
    recipientRole: VariantRecipientRole;
    appOrigin?: string | null;
    kind: VariantBatchKind;
  },
) {
  return tx.quizVariantBatchState.upsert({
    where: { batchId: opts.batchId },
    create: {
      batchId: opts.batchId,
      quizId: opts.quizId,
      requestedById: opts.requestedById,
      recipientRole: opts.recipientRole,
      appOrigin: opts.appOrigin ?? null,
      kind: opts.kind,
      cycle: 1,
      readyNotifiedCycle: 0,
    },
    update: {
      cycle: { increment: 1 },
      kind: opts.kind,
      requestedById: opts.requestedById,
      recipientRole: opts.recipientRole,
      appOrigin: opts.appOrigin ?? null,
      readyNotifiedAt: null,
      reminder24hSentAt: null,
      reminder72hSentAt: null,
    },
  });
}

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

export function buildReadySummary(
  kind: string,
  counts: { ready: number; failed: number; total: number },
): { readyHeading: string; summaryLine: string } {
  const readyHeading =
    kind === "REVISION"
      ? "Revisions ready to review"
      : "Alternative versions ready to review";
  const parts: string[] = [];
  if (counts.ready > 0)
    parts.push(
      `${counts.ready} of ${plural(counts.total, "version", "versions")} passed automatic checks and ${counts.ready === 1 ? "is" : "are"} ready to review.`,
    );
  else
    parts.push(
      `None of the ${plural(counts.total, "version", "versions")} passed automatic checks yet.`,
    );
  if (counts.failed > 0)
    parts.push(
      `${plural(counts.failed, "draft needs", "drafts need")} your attention (retry, edit, or discard).`,
    );
  return { readyHeading, summaryLine: parts.join(" ") };
}

async function createDelivery(
  tx: Db,
  data: {
    batchId: string;
    cycle: number;
    kind: VariantEmailKind;
    userId: string;
    email: string;
    vars: Record<string, string | number>;
  },
): Promise<string | null> {
  if (!isEmailAddress(data.email)) return null;
  const delivery = await tx.quizVariantEmailDelivery.create({
    data: {
      batchId: data.batchId,
      cycle: data.cycle,
      kind: data.kind,
      userId: data.userId,
      recipient: data.email.trim().toLowerCase(),
      payload: JSON.stringify(data.vars),
    },
  });
  return delivery.id;
}

function enqueueSafely(ids: string[]) {
  if (!ids.length) return;
  try {
    enqueueVariantEmails(ids);
  } catch (error) {
    // Rows are committed as PENDING; the worker sweeper re-enqueues them.
    console.error(
      "[quiz-variant-notifications] enqueue failed:",
      errorMessage(error),
    );
  }
}

/**
 * Send the round's single "ready" notice once every draft has settled. Safe to
 * call from every finishing job concurrently: the conditional claim on
 * readyNotifiedCycle lets exactly one caller through per cycle.
 */
export async function notifyVariantBatchIfComplete(
  batchId: string,
  now: Date = new Date(),
): Promise<{ notified: boolean }> {
  const inFlight = await prisma.quizPracticeVersion.count({
    where: { batchId, status: { in: IN_FLIGHT } },
  });
  if (inFlight > 0) return { notified: false };
  const state = await prisma.quizVariantBatchState.findUnique({
    where: { batchId },
    include: { quiz: { select: { name: true } } },
  });
  if (!state || state.readyNotifiedCycle >= state.cycle)
    return { notified: false };

  const versions = await prisma.quizPracticeVersion.findMany({
    where: { batchId, status: { in: REPORTED } },
    select: { status: true },
  });
  const counts = {
    ready: versions.filter((v) => v.status === "REVIEW").length,
    failed: versions.filter((v) => v.status === "FAILED").length,
    total: versions.length,
  };
  const { readyHeading, summaryLine } = buildReadySummary(state.kind, counts);
  const quizName = state.quiz.name;
  const reviewPath = variantBatchReviewPath(
    state.recipientRole,
    state.quizId,
    batchId,
  );
  const user = await prisma.user.findUnique({
    where: { id: state.requestedById },
    select: { id: true, email: true, firstName: true },
  });

  const deliveryId = await prisma.$transaction(async (tx) => {
    const claim = await tx.quizVariantBatchState.updateMany({
      where: {
        batchId,
        cycle: state.cycle,
        readyNotifiedCycle: { lt: state.cycle },
      },
      data: {
        readyNotifiedCycle: state.cycle,
        readyNotifiedAt: now,
        reminder24hSentAt: null,
        reminder72hSentAt: null,
      },
    });
    if (claim.count === 0) return false as const;
    if (!user) return null;
    const subject = `${readyHeading} for ${quizName}`;
    await tx.notification.create({
      data: {
        userId: user.id,
        messageId: null,
        kind: "QUIZ_VARIANTS_READY",
        subject,
        body: summaryLine,
        href: reviewPath,
      },
    });
    return createDelivery(tx, {
      batchId,
      cycle: state.cycle,
      kind: "READY",
      userId: user.id,
      email: user.email,
      vars: {
        appName: APP_NAME,
        firstName: user.firstName || "there",
        quizName,
        readyHeading,
        summaryLine,
        reviewUrl: absoluteUrl(state.appOrigin, reviewPath),
      },
    });
  });
  if (deliveryId === false) return { notified: false };
  if (deliveryId) enqueueSafely([deliveryId]);
  return { notified: true };
}

/**
 * Remind the requester about drafts still awaiting review: once at 24h, once
 * at 72h after the ready notice, then never again for that cycle. Rounds with
 * nothing left in REVIEW are settled silently.
 */
export async function sweepUnapprovedVariantReminders(
  now: Date = new Date(),
): Promise<{ sent: number; settled: number }> {
  const cutoff24 = new Date(now.getTime() - REMINDER_24H_MS);
  const cutoff72 = new Date(now.getTime() - REMINDER_72H_MS);
  const due = await prisma.quizVariantBatchState.findMany({
    where: {
      readyNotifiedAt: { not: null },
      OR: [
        { reminder24hSentAt: null, readyNotifiedAt: { lte: cutoff24 } },
        {
          reminder24hSentAt: { not: null },
          reminder72hSentAt: null,
          readyNotifiedAt: { lte: cutoff72 },
        },
      ],
    },
    include: { quiz: { select: { name: true } } },
    orderBy: { readyNotifiedAt: "asc" },
    take: 200,
  });
  let sent = 0;
  let settled = 0;
  const deliveryIds: string[] = [];
  for (const state of due) {
    const inFlight = await prisma.quizPracticeVersion.count({
      where: { batchId: state.batchId, status: { in: IN_FLIGHT } },
    });
    if (inFlight > 0) continue;
    const fence = {
      batchId: state.batchId,
      cycle: state.cycle,
      readyNotifiedAt: state.readyNotifiedAt,
      reminder24hSentAt: state.reminder24hSentAt,
      reminder72hSentAt: null,
    };
    const pending = await prisma.quizPracticeVersion.count({
      where: { batchId: state.batchId, status: "REVIEW" },
    });
    if (pending === 0) {
      // Everything was approved or discarded: no reminder is ever needed.
      const done = await prisma.quizVariantBatchState.updateMany({
        where: fence,
        data: {
          reminder24hSentAt: state.reminder24hSentAt ?? now,
          reminder72hSentAt: now,
        },
      });
      settled += done.count;
      continue;
    }
    // A round that missed its 24h reminder (e.g. worker downtime) and is
    // already past 72h gets the 72h reminder only, so at most two ever fire.
    const stage: VariantEmailKind =
      state.reminder24hSentAt === null &&
      state.readyNotifiedAt!.getTime() > cutoff72.getTime()
        ? "REMINDER_24H"
        : "REMINDER_72H";
    const user = await prisma.user.findUnique({
      where: { id: state.requestedById },
      select: { id: true, email: true, firstName: true },
    });
    const reviewPath = variantBatchReviewPath(
      state.recipientRole,
      state.quizId,
      state.batchId,
    );
    const ageLabel = stage === "REMINDER_24H" ? "1 day" : "3 days";
    const quizName = state.quiz.name;
    const deliveryId = await prisma.$transaction(async (tx) => {
      const claim = await tx.quizVariantBatchState.updateMany({
        where: fence,
        data:
          stage === "REMINDER_24H"
            ? { reminder24hSentAt: now }
            : {
                reminder24hSentAt: state.reminder24hSentAt ?? now,
                reminder72hSentAt: now,
              },
      });
      if (claim.count === 0) return false as const;
      if (!user) return null;
      await tx.notification.create({
        data: {
          userId: user.id,
          messageId: null,
          kind: "QUIZ_VARIANTS_REMINDER",
          subject: `Reminder: ${plural(pending, "draft", "drafts")} of ${quizName} ${pending === 1 ? "awaits" : "await"} your review`,
          body: `${plural(pending, "alternative version has", "alternative versions have")} been waiting for review for ${ageLabel}. Students only see versions you approve.`,
          href: reviewPath,
        },
      });
      return createDelivery(tx, {
        batchId: state.batchId,
        cycle: state.cycle,
        kind: stage,
        userId: user.id,
        email: user.email,
        vars: {
          appName: APP_NAME,
          firstName: user.firstName || "there",
          quizName,
          pendingCount: pending,
          ageLabel,
          reviewUrl: absoluteUrl(state.appOrigin, reviewPath),
        },
      });
    });
    if (deliveryId === false) continue;
    sent++;
    if (deliveryId) deliveryIds.push(deliveryId);
  }
  enqueueSafely(deliveryIds);
  return { sent, settled };
}

// ---------------------------------------------------------------------------
// Durable email delivery (claim / backoff / retry), mirroring consent-email.ts.
// ---------------------------------------------------------------------------

export function variantEmailBackoffSeconds(attempt: number): number {
  const index = Math.max(1, Math.floor(attempt)) - 1;
  return BACKOFF_SECONDS[Math.min(index, BACKOFF_SECONDS.length - 1)];
}

function describeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    raw.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_LENGTH) ||
    "Unknown error"
  );
}

function isPermanent(error: unknown): boolean {
  if (error instanceof SmtpNotConfiguredError) return false;
  const responseCode = (error as { responseCode?: unknown } | null)
    ?.responseCode;
  return (
    typeof responseCode === "number" &&
    responseCode >= 500 &&
    responseCode < 600
  );
}

export type VariantEmailOutcome =
  | { status: "SENT" }
  | { status: "SKIPPED"; reason: string }
  | { status: "RETRY"; delaySeconds: number; error: string }
  | { status: "FAILED"; error: string };

function purposeFor(kind: string): EmailPurpose {
  return kind === "READY" ? "QUIZ_VARIANTS_READY" : "QUIZ_VARIANTS_REMINDER";
}

/**
 * Deliver one queued quiz-variant email. Safe to call concurrently or
 * repeatedly for the same id — the lease claim decides who sends.
 */
export async function deliverVariantEmail(
  deliveryId: string,
  now: Date = new Date(),
): Promise<VariantEmailOutcome> {
  const leaseCutoff = new Date(now.getTime() - VARIANT_EMAIL_LEASE_MS);
  const claim = await prisma.quizVariantEmailDelivery.updateMany({
    where: {
      id: deliveryId,
      status: "PENDING",
      OR: [{ claimedAt: null }, { claimedAt: { lt: leaseCutoff } }],
    },
    data: { claimedAt: now, attempts: { increment: 1 } },
  });
  if (claim.count === 0)
    return {
      status: "SKIPPED",
      reason: "already delivered, given up on, or claimed by another worker",
    };
  const delivery = await prisma.quizVariantEmailDelivery.findUnique({
    where: { id: deliveryId },
  });
  if (!delivery)
    return { status: "SKIPPED", reason: "delivery row no longer exists" };

  let vars: Record<string, string | number>;
  try {
    vars = JSON.parse(delivery.payload);
    if (!vars || typeof vars !== "object") throw new Error("not an object");
  } catch {
    await prisma.quizVariantEmailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "FAILED",
        claimedAt: null,
        lastError: "Malformed delivery payload",
      },
    });
    return { status: "FAILED", error: "Malformed delivery payload" };
  }

  if (delivery.kind !== "READY") {
    // The teacher may have approved/discarded everything since the reminder
    // was queued; a stale nudge would only confuse them.
    const pending = await prisma.quizPracticeVersion.count({
      where: { batchId: delivery.batchId, status: "REVIEW" },
    });
    if (pending === 0) {
      await prisma.quizVariantEmailDelivery.update({
        where: { id: delivery.id },
        data: {
          status: "SKIPPED",
          claimedAt: null,
          lastError: "No drafts were still awaiting review",
        },
      });
      return { status: "SKIPPED", reason: "no drafts awaiting review" };
    }
  }

  const purpose = purposeFor(delivery.kind);
  try {
    const override = await getSenderOverride(purpose).catch(() => null);
    const { subject, text } = renderPurposeMessage(purpose, vars, override);
    await sendEmailToRecipient({
      to: delivery.recipient,
      subject,
      text,
      purpose,
    });
  } catch (error) {
    const reason = describeError(error);
    if (isPermanent(error) || delivery.attempts >= VARIANT_EMAIL_MAX_ATTEMPTS) {
      await prisma.quizVariantEmailDelivery.update({
        where: { id: delivery.id },
        data: { status: "FAILED", claimedAt: null, lastError: reason },
      });
      return { status: "FAILED", error: reason };
    }
    const delaySeconds = variantEmailBackoffSeconds(delivery.attempts);
    await prisma.quizVariantEmailDelivery.update({
      where: { id: delivery.id },
      data: {
        claimedAt: null,
        lastError: reason,
        nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000),
      },
    });
    return { status: "RETRY", delaySeconds, error: reason };
  }

  await prisma.quizVariantEmailDelivery.update({
    where: { id: delivery.id },
    data: { status: "SENT", sentAt: now, claimedAt: null, lastError: null },
  });
  return { status: "SENT" };
}

/** PENDING rows past their due time with no live claim (lost enqueue, crash). */
export async function findStrandedVariantEmails(
  limit = 200,
  now: Date = new Date(),
): Promise<string[]> {
  const due = new Date(now.getTime() - VARIANT_EMAIL_SWEEP_GRACE_MS);
  const leaseCutoff = new Date(now.getTime() - VARIANT_EMAIL_LEASE_MS);
  const rows = await prisma.quizVariantEmailDelivery.findMany({
    where: {
      status: "PENDING",
      attempts: { lt: VARIANT_EMAIL_MAX_ATTEMPTS },
      nextAttemptAt: { lte: due },
      OR: [{ claimedAt: null }, { claimedAt: { lt: leaseCutoff } }],
    },
    select: { id: true },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });
  return rows.map((r) => r.id);
}

/** Close out rows that used up every attempt without reaching a terminal state. */
export async function failExhaustedVariantEmails(
  now: Date = new Date(),
): Promise<number> {
  const leaseCutoff = new Date(now.getTime() - VARIANT_EMAIL_LEASE_MS);
  const stuck = await prisma.quizVariantEmailDelivery.findMany({
    where: {
      status: "PENDING",
      attempts: { gte: VARIANT_EMAIL_MAX_ATTEMPTS },
      OR: [{ claimedAt: null }, { claimedAt: { lt: leaseCutoff } }],
    },
    select: { id: true },
    take: 200,
  });
  if (stuck.length === 0) return 0;
  const ids = stuck.map((s) => s.id);
  await prisma.quizVariantEmailDelivery.updateMany({
    where: { id: { in: ids } },
    data: { status: "FAILED", claimedAt: null },
  });
  await prisma.quizVariantEmailDelivery.updateMany({
    where: { id: { in: ids }, lastError: null },
    data: {
      lastError: `Gave up after ${VARIANT_EMAIL_MAX_ATTEMPTS} delivery attempts`,
    },
  });
  return stuck.length;
}
