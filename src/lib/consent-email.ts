import { prisma } from "@/lib/prisma";
import {
  sendEmailToRecipient,
  getSenderOverride,
  SmtpNotConfiguredError,
  type EmailAttachment,
} from "@/lib/email";
import {
  APP_NAME,
  renderPurposeMessage,
  type EmailPurpose,
} from "@/lib/email-purposes";
import { renderConsentPdf } from "@/lib/consent-pdf";
import { buildConsentExportCsv } from "@/lib/consent-csv";
import { getConsentExportSettings } from "@/lib/consent-settings";
import {
  latestConsentDecisionsByEmail,
  type ConsentDecision,
} from "@/lib/consent";

/**
 * Queued delivery for consent-related emails (confirmation copy, export
 * request/ready notices). Mirrors src/lib/message-email.ts's claim/backoff
 * shape closely but writes to its own ConsentEmailDelivery table so the
 * messaging system stays untouched.
 *
 * The attachment (confirmation PDF, export CSV) is deliberately NOT stored in
 * the payload — it's regenerated fresh at delivery time from the referenced
 * ConsentRecord/ConsentExportRequest, consistent with this feature's
 * generate-on-demand-never-persist storage policy.
 */

export const CONSENT_EMAIL_MAX_ATTEMPTS = 5;
export const CONSENT_EMAIL_LEASE_MS = 5 * 60_000;
export const CONSENT_EMAIL_SWEEP_GRACE_MS = 5 * 60_000;
const BACKOFF_SECONDS = [60, 300, 900, 3600];
const MAX_ERROR_LENGTH = 300;

export function backoffSecondsFor(attempt: number): number {
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

function classifyError(error: unknown): "TRANSIENT" | "PERMANENT" {
  if (error instanceof SmtpNotConfiguredError) return "TRANSIENT";
  const responseCode = (error as { responseCode?: unknown } | null)
    ?.responseCode;
  if (
    typeof responseCode === "number" &&
    responseCode >= 500 &&
    responseCode < 600
  )
    return "PERMANENT";
  return "TRANSIENT";
}

export type ConsentEmailPayload =
  | { kind: "CONSENT_CONFIRMATION"; consentRecordId: string }
  | { kind: "CONSENT_EXPORT_READY"; exportRequestId: string }
  | {
      kind: "CONSENT_EXPORT_REQUEST";
      subject: string;
      text: string;
      replyTo?: string;
    };

export async function enqueueConsentConfirmationEmail(
  consentRecordId: string,
  recipient: string,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.consentEmailDelivery.create({
      data: {
        kind: "CONSENT_CONFIRMATION",
        recipient,
        payload: JSON.stringify({
          kind: "CONSENT_CONFIRMATION",
          consentRecordId,
        } satisfies ConsentEmailPayload),
      },
    });
    await tx.consentRecord.update({
      where: { id: consentRecordId },
      data: { emailStatus: "PENDING", emailError: null, emailedAt: null },
    });
    return row.id;
  });
}

export async function enqueueConsentExportRequestEmail(opts: {
  recipient: string;
  subject: string;
  text: string;
  replyTo?: string;
}): Promise<string> {
  const row = await prisma.consentEmailDelivery.create({
    data: {
      kind: "CONSENT_EXPORT_REQUEST",
      recipient: opts.recipient,
      payload: JSON.stringify({
        kind: "CONSENT_EXPORT_REQUEST",
        subject: opts.subject,
        text: opts.text,
        replyTo: opts.replyTo,
      } satisfies ConsentEmailPayload),
    },
  });
  return row.id;
}

export async function enqueueConsentExportReadyEmail(
  exportRequestId: string,
  recipient: string,
): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.consentEmailDelivery.create({
      data: {
        kind: "CONSENT_EXPORT_READY",
        recipient,
        payload: JSON.stringify({
          kind: "CONSENT_EXPORT_READY",
          exportRequestId,
        } satisfies ConsentEmailPayload),
      },
    });
    await tx.consentExportRequest.update({
      where: { id: exportRequestId },
      data: { emailStatus: "PENDING", emailError: null, deliveredAt: null },
    });
    return row.id;
  });
}

async function updateReferencedEmailAudit(
  payload: ConsentEmailPayload,
  status: "PENDING" | "SENT" | "FAILED",
  error: string | null,
  now: Date,
): Promise<void> {
  if (payload.kind === "CONSENT_CONFIRMATION") {
    await prisma.consentRecord.updateMany({
      where: { id: payload.consentRecordId },
      data: {
        emailStatus: status,
        emailError: error,
        emailedAt: status === "SENT" ? now : null,
      },
    });
  } else if (payload.kind === "CONSENT_EXPORT_READY") {
    await prisma.consentExportRequest.updateMany({
      where: { id: payload.exportRequestId },
      data: {
        emailStatus: status,
        emailError: error,
        deliveredAt: status === "SENT" ? now : null,
      },
    });
  }
}

/** Attach a file only when it fits the admin-configured ceiling; otherwise send without it. */
async function attachmentWithinLimit(
  attachment: EmailAttachment,
): Promise<{ attachments: EmailAttachment[]; note: string | null }> {
  const settings = await getConsentExportSettings();
  if (attachment.content.byteLength > settings.maxEmailAttachmentBytes) {
    return {
      attachments: [],
      note:
        "\n\n(The attached document was too large to include in this email under the " +
        "administrator's configured attachment size limit; sign in to your account to view it.)",
    };
  }
  return { attachments: [attachment], note: null };
}

async function buildConsentConfirmationMessage(
  consentRecordId: string,
): Promise<{
  subject: string;
  text: string;
  attachments: EmailAttachment[];
} | null> {
  const record = await prisma.consentRecord.findUnique({
    where: { id: consentRecordId },
    include: { formVersion: true },
  });
  if (!record) return null;

  const [pdf, override] = await Promise.all([
    renderConsentPdf(record, record.formVersion),
    getSenderOverride("CONSENT_CONFIRMATION"),
  ]);
  const firstName =
    record.signerNameSnapshot.split(" ")[0] || record.signerNameSnapshot;
  const { subject, text } = renderPurposeMessage(
    "CONSENT_CONFIRMATION",
    {
      appName: APP_NAME,
      firstName,
      formTitle: record.formVersion.title,
      formVersion: record.formVersion.version,
      decisionText:
        record.decision === "AGREE"
          ? "Yes, I agree to participate"
          : "No, I do not agree to participate",
    },
    override,
  );
  const { attachments, note } = await attachmentWithinLimit({
    filename: "consent-record.pdf",
    content: pdf,
    contentType: "application/pdf",
  });
  return { subject, text: text + (note ?? ""), attachments };
}

async function buildConsentExportReadyMessage(
  exportRequestId: string,
): Promise<{
  subject: string;
  text: string;
  attachments: EmailAttachment[];
} | null> {
  const request = await prisma.consentExportRequest.findUnique({
    where: { id: exportRequestId },
    include: { class: { select: { name: true } } },
  });
  if (!request) return null;

  const [roster, activeVersion] = await Promise.all([
    prisma.classStudentList.findMany({
      where: { classId: request.classId },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
    prisma.consentFormVersion.findFirst({
      where: { role: "STUDENT", isActive: true },
    }),
  ]);

  let latestDecisionByEmail = new Map<string, ConsentDecision>();
  if (activeVersion) {
    const decisions = await prisma.consentRecord.findMany({
      where: { formVersionId: activeVersion.id, role: "STUDENT" },
      orderBy: [{ signedAt: "desc" }, { id: "desc" }],
      select: { signerEmailSnapshot: true, decision: true },
    });
    latestDecisionByEmail = latestConsentDecisionsByEmail(decisions);
  }

  const csv = buildConsentExportCsv(
    request.gradeColumnName,
    request.pointsAwarded,
    roster.map((r) => ({
      orgDefinedId: r.orgDefinedId,
      lastName: r.lastName,
      firstName: r.firstName,
      signed: r.email
        ? latestDecisionByEmail.get(r.email.trim().toLowerCase()) === "AGREE"
        : false,
    })),
  );

  const override = await getSenderOverride("CONSENT_EXPORT_READY").catch(
    () => null,
  );
  const { subject, text } = renderPurposeMessage(
    "CONSENT_EXPORT_READY",
    {
      appName: APP_NAME,
      className: request.class.name,
      gradeColumnName: request.gradeColumnName,
      pointsAwarded: request.pointsAwarded,
    },
    override,
  );

  const { attachments, note } = await attachmentWithinLimit({
    filename: "consent_export.csv",
    content: Buffer.from(csv, "utf-8"),
    contentType: "text/csv",
  });
  return { subject, text: text + (note ?? ""), attachments };
}

export type ConsentEmailOutcome =
  | { status: "SENT" }
  | { status: "SKIPPED"; reason: string }
  | { status: "RETRY"; delaySeconds: number; error: string }
  | { status: "FAILED"; error: string };

/**
 * Deliver one queued consent email. Safe to call concurrently/repeatedly for
 * the same id — the lease claim is the single point where a row becomes
 * "mine to send". Returns what the worker should do with the job.
 */
export async function deliverConsentEmail(
  deliveryId: string,
  now: Date = new Date(),
): Promise<ConsentEmailOutcome> {
  const leaseCutoff = new Date(now.getTime() - CONSENT_EMAIL_LEASE_MS);

  const claim = await prisma.consentEmailDelivery.updateMany({
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

  const delivery = await prisma.consentEmailDelivery.findUnique({
    where: { id: deliveryId },
  });
  if (!delivery)
    return { status: "SKIPPED", reason: "delivery row no longer exists" };

  let payload: ConsentEmailPayload;
  try {
    payload = JSON.parse(delivery.payload);
  } catch {
    await prisma.consentEmailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "FAILED",
        claimedAt: null,
        lastError: "Malformed delivery payload",
      },
    });
    return { status: "FAILED", error: "Malformed delivery payload" };
  }

  let message: {
    subject: string;
    text: string;
    attachments: EmailAttachment[];
  } | null;
  let purpose: EmailPurpose = "NOTIFICATION";
  let replyTo: string | undefined;
  try {
    if (payload.kind === "CONSENT_CONFIRMATION") {
      purpose = "CONSENT_CONFIRMATION";
      message = await buildConsentConfirmationMessage(payload.consentRecordId);
    } else if (payload.kind === "CONSENT_EXPORT_READY") {
      purpose = "CONSENT_EXPORT_READY";
      message = await buildConsentExportReadyMessage(payload.exportRequestId);
    } else {
      purpose = "CONSENT_EXPORT_REQUEST";
      replyTo = payload.replyTo;
      message = {
        subject: payload.subject,
        text: payload.text,
        attachments: [],
      };
    }
  } catch (error) {
    // Rendering the PDF/CSV failed (e.g. a transient DB hiccup) — treat like a
    // transient send failure so it retries on the same backoff schedule.
    const reason = describeError(error);
    const delaySeconds = backoffSecondsFor(delivery.attempts);
    await prisma.consentEmailDelivery.update({
      where: { id: delivery.id },
      data: {
        claimedAt: null,
        lastError: reason,
        nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000),
      },
    });
    await updateReferencedEmailAudit(payload, "PENDING", reason, now);
    return { status: "RETRY", delaySeconds, error: reason };
  }

  if (!message) {
    // The referenced record/request was deleted — nothing left to send.
    await prisma.consentEmailDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "FAILED",
        claimedAt: null,
        lastError: "Referenced record no longer exists",
      },
    });
    return { status: "FAILED", error: "Referenced record no longer exists" };
  }

  try {
    await sendEmailToRecipient({
      to: delivery.recipient,
      subject: message.subject,
      text: message.text,
      purpose,
      replyTo,
      attachments: message.attachments,
    });
  } catch (error) {
    const reason = describeError(error);
    const giveUp =
      classifyError(error) === "PERMANENT" ||
      delivery.attempts >= CONSENT_EMAIL_MAX_ATTEMPTS;
    if (giveUp) {
      await prisma.consentEmailDelivery.update({
        where: { id: delivery.id },
        data: { status: "FAILED", claimedAt: null, lastError: reason },
      });
      await updateReferencedEmailAudit(payload, "FAILED", reason, now);
      return { status: "FAILED", error: reason };
    }
    const delaySeconds = backoffSecondsFor(delivery.attempts);
    await prisma.consentEmailDelivery.update({
      where: { id: delivery.id },
      data: {
        claimedAt: null,
        lastError: reason,
        nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000),
      },
    });
    await updateReferencedEmailAudit(payload, "PENDING", reason, now);
    return { status: "RETRY", delaySeconds, error: reason };
  }

  await prisma.consentEmailDelivery.update({
    where: { id: delivery.id },
    data: { status: "SENT", sentAt: now, claimedAt: null, lastError: null },
  });
  await updateReferencedEmailAudit(payload, "SENT", null, now);
  return { status: "SENT" };
}

/** Rows stuck PENDING past their due time with no live claim — see message-email.ts's twin. */
export async function findStrandedConsentEmails(
  limit = 200,
  now: Date = new Date(),
): Promise<string[]> {
  const due = new Date(now.getTime() - CONSENT_EMAIL_SWEEP_GRACE_MS);
  const leaseCutoff = new Date(now.getTime() - CONSENT_EMAIL_LEASE_MS);
  const rows = await prisma.consentEmailDelivery.findMany({
    where: {
      status: "PENDING",
      attempts: { lt: CONSENT_EMAIL_MAX_ATTEMPTS },
      nextAttemptAt: { lte: due },
      OR: [{ claimedAt: null }, { claimedAt: { lt: leaseCutoff } }],
    },
    select: { id: true },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });
  return rows.map((r) => r.id);
}

/** Close out rows that used up every attempt but never reached a terminal state. */
export async function failExhaustedConsentEmails(
  now: Date = new Date(),
): Promise<number> {
  const leaseCutoff = new Date(now.getTime() - CONSENT_EMAIL_LEASE_MS);
  const stuck = await prisma.consentEmailDelivery.findMany({
    where: {
      status: "PENDING",
      attempts: { gte: CONSENT_EMAIL_MAX_ATTEMPTS },
      OR: [{ claimedAt: null }, { claimedAt: { lt: leaseCutoff } }],
    },
    select: { id: true, payload: true },
    take: 200,
  });
  if (stuck.length === 0) return 0;
  await prisma.consentEmailDelivery.updateMany({
    where: { id: { in: stuck.map((s) => s.id) } },
    data: { status: "FAILED", claimedAt: null },
  });
  await prisma.consentEmailDelivery.updateMany({
    where: { id: { in: stuck.map((s) => s.id) }, lastError: null },
    data: {
      lastError: `Gave up after ${CONSENT_EMAIL_MAX_ATTEMPTS} delivery attempts`,
    },
  });
  await Promise.all(
    stuck.map(async (delivery) => {
      try {
        const payload = JSON.parse(delivery.payload) as ConsentEmailPayload;
        await updateReferencedEmailAudit(
          payload,
          "FAILED",
          `Gave up after ${CONSENT_EMAIL_MAX_ATTEMPTS} delivery attempts`,
          now,
        );
      } catch {
        // A malformed payload has no safely identifiable source row to update.
      }
    }),
  );
  return stuck.length;
}
