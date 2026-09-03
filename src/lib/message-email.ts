import { prisma } from "@/lib/prisma";
import { sendEmailToRecipient, SmtpNotConfiguredError } from "@/lib/email";
import { isValidEmail } from "@/lib/csv-roster";

/**
 * Queued delivery of the "you have a new message" email that accompanies a
 * teacher's in-app notification.
 *
 * The in-app notification IS the message; email is only a nudge telling the
 * student to go read it. Sending it inline on the request path made that nudge
 * as fragile as the SMTP server was on that particular second — a timeout or a
 * restart lost it silently. Instead the API writes one PENDING
 * MessageEmailDelivery row per recipient and enqueues one Honker job each; this
 * module is what those jobs run.
 *
 * Delivery guarantees:
 *  - Durable: the intent lives in the database, not in the job. A lost job, a
 *    crashed worker, or a failed enqueue is recovered by the sweeper
 *    (findStrandedMessageEmails) re-enqueueing anything still PENDING.
 *  - At-most-once per recipient: a row is moved only by the holder of its
 *    claim lease, so duplicate jobs for the same row no-op instead of
 *    double-sending.
 *  - Bounded: transient failures retry on a backoff schedule up to
 *    MESSAGE_EMAIL_MAX_ATTEMPTS; permanent ones (a rejected address) stop
 *    immediately. Either way the row ends FAILED with the reason, which the
 *    teacher sees in their message history.
 */

/** Delivery attempts per recipient before giving up for good. */
export const MESSAGE_EMAIL_MAX_ATTEMPTS = 5;

/**
 * How long a worker's claim on a delivery row is honored. A worker killed
 * mid-send leaves claimedAt set; after the lease expires another attempt may
 * reclaim the row. Comfortably longer than an SMTP send (and than the queue's
 * visibility timeout) so a slow-but-alive send is never raced.
 */
export const MESSAGE_EMAIL_LEASE_MS = 5 * 60_000;

/**
 * Grace period past nextAttemptAt before the sweeper treats a PENDING row as
 * stranded and re-enqueues it. Long enough that the queue's own retry always
 * gets first crack; short enough that a lost job is picked up quickly.
 */
export const MESSAGE_EMAIL_SWEEP_GRACE_MS = 5 * 60_000;

/** Backoff before attempt N+1, indexed by the attempt that just failed. */
const BACKOFF_SECONDS = [60, 300, 900, 3600];

/** Truncation cap for stored SMTP error text (the column is user-visible). */
const MAX_ERROR_LENGTH = 300;

/**
 * Seconds to wait after `attempt` (1-based) fails before trying again:
 * 1m, 5m, 15m, then 1h for anything later.
 */
export function backoffSecondsFor(attempt: number): number {
  const index = Math.max(1, Math.floor(attempt)) - 1;
  return BACKOFF_SECONDS[Math.min(index, BACKOFF_SECONDS.length - 1)];
}

export type DeliveryFailureKind = "TRANSIENT" | "PERMANENT";

/**
 * Decide whether a failed send is worth retrying.
 *
 * SMTP splits this cleanly: 5xx is a refusal (bad mailbox, blocked sender) that
 * will fail identically forever, while 4xx and connection-level errors mean
 * "not right now". Anything unrecognized — including SMTP not being configured
 * yet, which an admin may be about to fix — is treated as transient, since the
 * attempt cap already bounds how long we keep trying.
 */
export function classifyDeliveryError(error: unknown): DeliveryFailureKind {
  if (error instanceof SmtpNotConfiguredError) return "TRANSIENT";

  const responseCode = (error as { responseCode?: unknown } | null)
    ?.responseCode;
  if (
    typeof responseCode === "number" &&
    responseCode >= 500 &&
    responseCode < 600
  ) {
    return "PERMANENT";
  }
  return "TRANSIENT";
}

/** Readable one-liner for an unknown throwable, trimmed for storage. */
export function describeDeliveryError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return (
    raw.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_LENGTH) ||
    "Unknown error"
  );
}

export interface RecipientAccount {
  /** Recipient's User id, when the address belongs to an account. */
  userId?: string | null;
  email: string | null | undefined;
}

/**
 * The addressable subset of a class's enrolled students: a normalized
 * `address -> userId` map. Addresses are lower-cased and de-duplicated because
 * MessageEmailDelivery is unique per (message, email) — two accounts sharing an
 * address must not collide on insert, and nobody should get the same
 * announcement twice. Pure, and shared by the compose request (who to queue)
 * and the compose screen (how many will be emailed) so the two never disagree.
 */
export function selectEmailRecipients(
  accounts: RecipientAccount[],
): Map<string, string | null> {
  const recipients = new Map<string, string | null>();
  for (const account of accounts) {
    const email = account.email?.trim().toLowerCase();
    if (email && isValidEmail(email) && !recipients.has(email)) {
      recipients.set(email, account.userId ?? null);
    }
  }
  return recipients;
}

export interface MessageEmailInput {
  /** The teacher's subject line — says what the waiting message is about. */
  subject: string;
  senderName: string;
  className: string | null;
  /** Message id, so the link opens this message rather than the mailbox. */
  messageId: string;
  /** Public base URL of the app, when configured. */
  appUrl?: string | null;
}

/**
 * Base URL for links in notification emails, or null when none is configured.
 *
 * The worker has no request to read a host from, so this must come from the
 * environment. APP_URL is the documented setting; AUTH_URL / NEXTAUTH_URL are
 * accepted as fallbacks because deployments often already set one of them.
 */
export function resolveAppUrl(): string | null {
  const raw =
    process.env.APP_URL?.trim() ||
    process.env.AUTH_URL?.trim() ||
    process.env.NEXTAUTH_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, "");
}

/** Deep link that opens one message in the student's mailbox. */
export function messageLink(appUrl: string, messageId: string): string {
  return `${appUrl}/student/notifications?message=${encodeURIComponent(messageId)}`;
}

/**
 * Render the notification email for one message. Pure so the wording is unit
 * tested without SMTP.
 *
 * This email announces the message; it does not carry it. The message lives on
 * the platform — where read state, the class it belongs to, and the reply path
 * all are — so the email says who wrote, what it is about, and links straight
 * to it. Message content therefore never sits in an inbox or a mail relay log.
 */
export function buildMessageEmail(input: MessageEmailInput): {
  subject: string;
  text: string;
} {
  const className = input.className?.trim() || null;
  const senderName = input.senderName.trim() || "your teacher";
  const topic = input.subject.trim();
  const subject = className
    ? `New message in ${className}: ${topic}`
    : `New message from ${senderName}: ${topic}`;

  const link = input.appUrl
    ? `Read it here: ${messageLink(input.appUrl, input.messageId)}`
    : "Sign in and open Notifications to read it.";

  const text = [
    `${senderName} has sent you a new message${className ? ` in ${className}` : ""}.`,
    "",
    `Subject: ${topic}`,
    "",
    link,
    "",
    "This is an automated notification — the message itself is waiting for you in the app.",
  ].join("\n");

  return { subject, text };
}

export interface DeliveryCounts {
  pending: number;
  sent: number;
  failed: number;
}

/**
 * Roll per-recipient delivery rows up into the Message's email status.
 * Pure so the state machine is testable on its own.
 */
export function summarizeDeliveries(counts: DeliveryCounts): {
  status: "QUEUED" | "SENT" | "PARTIAL" | "FAILED";
  sentCount: number;
} {
  if (counts.pending > 0) return { status: "QUEUED", sentCount: counts.sent };
  if (counts.failed === 0) return { status: "SENT", sentCount: counts.sent };
  if (counts.sent === 0) return { status: "FAILED", sentCount: counts.sent };
  return { status: "PARTIAL", sentCount: counts.sent };
}

export type DeliveryOutcome =
  | { status: "SENT" }
  | { status: "SKIPPED"; reason: string }
  | { status: "RETRY"; delaySeconds: number; error: string }
  | { status: "FAILED"; error: string };

/**
 * Recompute a Message's email counters from its delivery rows. Called after
 * every terminal transition so the teacher's history reflects reality without
 * the sender's request having waited for any of it.
 */
export async function recomputeMessageEmailStatus(
  messageId: string,
): Promise<void> {
  const rows = await prisma.messageEmailDelivery.groupBy({
    by: ["status"],
    where: { messageId },
    _count: { _all: true },
  });

  const counts: DeliveryCounts = { pending: 0, sent: 0, failed: 0 };
  for (const row of rows) {
    const n = row._count._all;
    if (row.status === "SENT") counts.sent += n;
    else if (row.status === "FAILED") counts.failed += n;
    else counts.pending += n;
  }

  const { status, sentCount } = summarizeDeliveries(counts);

  // Surface a couple of concrete reasons rather than just a count — "mailbox
  // full" is actionable for a teacher, "3 failed" is not.
  let error: string | null = null;
  if (counts.failed > 0) {
    const failures = await prisma.messageEmailDelivery.findMany({
      where: { messageId, status: "FAILED" },
      select: { email: true, lastError: true },
      take: 3,
    });
    error = failures
      .map((f) => `${f.email}: ${f.lastError ?? "delivery failed"}`)
      .join("; ")
      .slice(0, 1_000);
  }

  await prisma.message.update({
    where: { id: messageId },
    data: { sentCount, status, error },
  });
}

/**
 * Deliver one recipient's notification email. Safe to call concurrently and
 * repeatedly for the same id: the lease claim below is the single point where
 * a row becomes "mine to send", so extra callers return SKIPPED.
 *
 * The return value tells the worker what to do with the job — retry with the
 * given delay, or ack because the row reached a terminal state.
 */
export async function deliverMessageEmail(
  deliveryId: string,
  now: Date = new Date(),
): Promise<DeliveryOutcome> {
  const leaseCutoff = new Date(now.getTime() - MESSAGE_EMAIL_LEASE_MS);

  // Claim + count the attempt in one conditional write. Losing this race means
  // the row is already SENT/FAILED or another worker holds a live lease.
  const claim = await prisma.messageEmailDelivery.updateMany({
    where: {
      id: deliveryId,
      status: "PENDING",
      OR: [{ claimedAt: null }, { claimedAt: { lt: leaseCutoff } }],
    },
    data: { claimedAt: now, attempts: { increment: 1 } },
  });
  if (claim.count === 0) {
    return {
      status: "SKIPPED",
      reason: "already delivered, given up on, or claimed by another worker",
    };
  }

  const delivery = await prisma.messageEmailDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      message: {
        include: {
          sender: { select: { firstName: true, lastName: true, email: true } },
          class: { select: { name: true } },
        },
      },
    },
  });
  if (!delivery) {
    // The message (and its cascade) was deleted between claim and read.
    return { status: "SKIPPED", reason: "delivery row no longer exists" };
  }

  const { message } = delivery;
  const { subject, text } = buildMessageEmail({
    subject: message.subject,
    senderName: `${message.sender.firstName} ${message.sender.lastName}`.trim(),
    className: message.class?.name ?? null,
    messageId: message.id,
    appUrl: resolveAppUrl(),
  });

  try {
    await sendEmailToRecipient({
      to: delivery.email,
      subject,
      text,
      replyTo: message.sender.email,
    });
  } catch (error) {
    const reason = describeDeliveryError(error);
    const giveUp =
      classifyDeliveryError(error) === "PERMANENT" ||
      delivery.attempts >= MESSAGE_EMAIL_MAX_ATTEMPTS;

    if (giveUp) {
      await prisma.messageEmailDelivery.update({
        where: { id: delivery.id },
        data: { status: "FAILED", claimedAt: null, lastError: reason },
      });
      await recomputeMessageEmailStatus(delivery.messageId);
      return { status: "FAILED", error: reason };
    }

    const delaySeconds = backoffSecondsFor(delivery.attempts);
    await prisma.messageEmailDelivery.update({
      where: { id: delivery.id },
      data: {
        claimedAt: null,
        lastError: reason,
        nextAttemptAt: new Date(now.getTime() + delaySeconds * 1_000),
      },
    });
    return { status: "RETRY", delaySeconds, error: reason };
  }

  await prisma.messageEmailDelivery.update({
    where: { id: delivery.id },
    data: { status: "SENT", sentAt: now, claimedAt: null, lastError: null },
  });
  await recomputeMessageEmailStatus(delivery.messageId);
  return { status: "SENT" };
}

/**
 * Delivery rows that are still PENDING well past their due time with no live
 * claim — i.e. their job was never enqueued, was lost, or died with the worker.
 * The sweeper re-enqueues these; the lease claim keeps a needless re-enqueue
 * harmless.
 */
export async function findStrandedMessageEmails(
  limit = 200,
  now: Date = new Date(),
): Promise<string[]> {
  const due = new Date(now.getTime() - MESSAGE_EMAIL_SWEEP_GRACE_MS);
  const leaseCutoff = new Date(now.getTime() - MESSAGE_EMAIL_LEASE_MS);

  const rows = await prisma.messageEmailDelivery.findMany({
    where: {
      status: "PENDING",
      attempts: { lt: MESSAGE_EMAIL_MAX_ATTEMPTS },
      nextAttemptAt: { lte: due },
      OR: [{ claimedAt: null }, { claimedAt: { lt: leaseCutoff } }],
    },
    select: { id: true },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });

  return rows.map((r) => r.id);
}

/**
 * Close out rows that used up every attempt but never reached a terminal state
 * — a worker dying mid-send on the final try is the way that happens. Without
 * this they would sit "QUEUED" in the teacher's history forever.
 */
export async function failExhaustedMessageEmails(
  now: Date = new Date(),
): Promise<number> {
  const leaseCutoff = new Date(now.getTime() - MESSAGE_EMAIL_LEASE_MS);

  const stuck = await prisma.messageEmailDelivery.findMany({
    where: {
      status: "PENDING",
      attempts: { gte: MESSAGE_EMAIL_MAX_ATTEMPTS },
      OR: [{ claimedAt: null }, { claimedAt: { lt: leaseCutoff } }],
    },
    select: { id: true, messageId: true },
    take: 200,
  });
  if (stuck.length === 0) return 0;

  const ids = stuck.map((s) => s.id);
  await prisma.messageEmailDelivery.updateMany({
    where: { id: { in: ids } },
    data: { status: "FAILED", claimedAt: null },
  });
  // Keep the last real SMTP error when there is one; only rows that died before
  // recording anything get the generic reason.
  await prisma.messageEmailDelivery.updateMany({
    where: { id: { in: ids }, lastError: null },
    data: {
      lastError: `Gave up after ${MESSAGE_EMAIL_MAX_ATTEMPTS} delivery attempts`,
    },
  });

  for (const messageId of new Set(stuck.map((s) => s.messageId))) {
    await recomputeMessageEmailStatus(messageId);
  }
  return stuck.length;
}
