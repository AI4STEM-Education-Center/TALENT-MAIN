// Side-effecting half of the research pool and its emails: loading the pool,
// turning a due campaign into per-recipient delivery rows, and delivering one
// row. Delivery mirrors src/lib/consent-email.ts — a durable row per recipient,
// a claim lease so duplicate jobs never double-send, bounded retries, and a
// sweeper backstop for lost jobs. Everything runs in the background worker.

import { prisma } from "@/lib/prisma";
import {
  getSenderOverride,
  sendEmailToRecipient,
  SmtpNotConfiguredError,
  type EmailAttachment,
} from "@/lib/email";
import {
  APP_NAME,
  isEmailAddress,
  renderPurposeMessage,
} from "@/lib/email-purposes";
import { getS3Object } from "@/lib/storage";
import {
  filterPool,
  isResearchEmailKind,
  legacyVersions,
  mergePoolEntries,
  normalizePoolAudience,
  normalizePostSurveyAudience,
  parseAttachments,
  parseVersions,
  recipientVars,
  renderResearchEmail,
  versionKeyFor,
  type PoolEntry,
  type RecipientVars,
  type VersionKey,
} from "@/lib/research-email";
import type { SurveyRole } from "@/lib/survey";
import { getEnabledSurveyForm, newSurveyToken } from "@/lib/survey-server";
import { enqueueResearchEmails } from "@/lib/queue";

export const RESEARCH_EMAIL_MAX_ATTEMPTS = 5;
export const RESEARCH_EMAIL_LEASE_MS = 5 * 60_000;
export const RESEARCH_EMAIL_SWEEP_GRACE_MS = 5 * 60_000;
const BACKOFF_SECONDS = [60, 300, 900, 3600];
const MAX_ERROR_LENGTH = 300;

function backoffSecondsFor(attempt: number): number {
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
  const code = (error as { responseCode?: unknown } | null)?.responseCode;
  return typeof code === "number" && code >= 500 && code < 600;
}

// ─── Pool ────────────────────────────────────────────────────────────────────

/**
 * Everyone who agreed to be contacted: an AGREE as their latest IRB consent
 * decision, or an interview opt-in on the pre-survey. Computed on read, so a
 * later withdrawal (a newer DECLINE) takes someone out without bookkeeping.
 */
export async function loadResearchPool(): Promise<PoolEntry[]> {
  const userSelect = {
    select: { firstName: true, lastName: true, email: true },
  } as const;
  const [consent, optIns] = await Promise.all([
    prisma.consentRecord.findMany({
      orderBy: [{ signedAt: "desc" }, { id: "desc" }],
      select: {
        userId: true,
        role: true,
        decision: true,
        interviewRecordingChoice: true,
        signerNameSnapshot: true,
        signerEmailSnapshot: true,
        signedAt: true,
        user: userSelect,
      },
    }),
    prisma.surveyResponse.findMany({
      where: { kind: "PRE", interviewOptIn: true },
      orderBy: { submittedAt: "desc" },
      select: {
        userId: true,
        role: true,
        interviewEmail: true,
        nameSnapshot: true,
        emailSnapshot: true,
        submittedAt: true,
        user: userSelect,
      },
    }),
  ]);
  return mergePoolEntries(consent, optIns);
}

// ─── Recipients ──────────────────────────────────────────────────────────────

export type PlannedRecipient = {
  userId: string | null;
  email: string;
  /** The campaign version this person gets. */
  variant: VersionKey;
  vars: RecipientVars;
  /** POST_SURVEY only: the form this person's link opens. */
  formId?: string;
  name: string;
};

type RecipientPlan = { recipients: PlannedRecipient[]; skipped: string[] };

function dedupeByEmail(list: PlannedRecipient[]): PlannedRecipient[] {
  const seen = new Set<string>();
  return list.filter((r) => {
    const key = r.email.trim().toLowerCase();
    if (!isEmailAddress(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function planPoolRecipients(
  audienceJson: string,
): Promise<RecipientPlan> {
  const audience = normalizePoolAudience(safeJson(audienceJson));
  const pool = filterPool(await loadResearchPool(), audience);
  return {
    recipients: dedupeByEmail(
      pool.map((entry) => ({
        userId: entry.userId,
        email: entry.email,
        name: entry.name,
        variant: versionKeyFor("POOL", entry),
        vars: recipientVars(entry, APP_NAME),
      })),
    ),
    skipped: [],
  };
}

/**
 * Post-survey recipients: the selected roles, narrowed by target, minus anyone
 * who already submitted that role's enabled post-survey (so a reminder
 * campaign never nags people who are done). Links are minted later, at
 * materialization, so each carries its own token.
 */
async function planPostSurveyRecipients(
  audienceJson: string,
): Promise<RecipientPlan> {
  const audience = normalizePostSurveyAudience(safeJson(audienceJson));
  const pool = await loadResearchPool();
  const poolByUser = new Map(
    pool.filter((p) => p.userId).map((p) => [p.userId as string, p]),
  );
  const skipped: string[] = [];
  const recipients: PlannedRecipient[] = [];

  for (const role of audience.roles) {
    const form = await getEnabledSurveyForm("POST", role);
    if (!form) {
      skipped.push(
        `No ${role === "TEACHER" ? "teacher" : "student"} post-survey is enabled, so ${role === "TEACHER" ? "teachers" : "students"} were skipped.`,
      );
      continue;
    }

    const [users, done, preDone] = await Promise.all([
      prisma.user.findMany({
        where: { role },
        select: { id: true, firstName: true, lastName: true, email: true },
      }),
      prisma.surveyResponse.findMany({
        where: { formId: form.id, userId: { not: null } },
        select: { userId: true },
      }),
      audience.target === "PRE_COMPLETED"
        ? prisma.surveyResponse.findMany({
            where: { kind: "PRE", role, userId: { not: null } },
            select: { userId: true },
          })
        : Promise.resolve([]),
    ]);
    const finished = new Set(done.map((d) => d.userId));
    const completedPre = new Set(preDone.map((d) => d.userId));

    for (const user of users) {
      if (finished.has(user.id)) continue;
      const entry = poolByUser.get(user.id);
      if (audience.target === "POOL" && !entry) continue;
      if (audience.target === "PRE_COMPLETED" && !completedPre.has(user.id))
        continue;
      const person = {
        firstName: user.firstName,
        lastName: user.lastName,
        role: role as SurveyRole,
        viaIrb: entry?.viaIrb ?? false,
        viaSurvey: entry?.viaSurvey ?? false,
        consentLevel: entry?.consentLevel ?? null,
      };
      recipients.push({
        userId: user.id,
        email: entry?.email ?? user.email,
        name: `${user.firstName} ${user.lastName}`.trim(),
        variant: versionKeyFor("POST_SURVEY", person),
        vars: recipientVars(person, APP_NAME),
        formId: form.id,
      });
    }
  }
  return { recipients: dedupeByEmail(recipients), skipped };
}

function safeJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

/** Who a campaign would reach right now — for the composer's recipient count. */
export async function previewRecipients(
  kind: string,
  audienceJson: string,
): Promise<RecipientPlan> {
  return kind === "POST_SURVEY"
    ? planPostSurveyRecipients(audienceJson)
    : planPoolRecipients(audienceJson);
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

/**
 * Claim campaigns whose time has come (SCHEDULED → SENDING) and write one
 * delivery row per recipient. The status flip is a compare-and-set, so two
 * workers can't both expand the same campaign. Returns the delivery ids to
 * enqueue.
 */
export async function materializeDueCampaigns(
  now: Date = new Date(),
): Promise<string[]> {
  const due = await prisma.researchEmailCampaign.findMany({
    where: { status: "SCHEDULED", scheduledAt: { lte: now } },
    select: { id: true },
    orderBy: { scheduledAt: "asc" },
    take: 20,
  });

  const deliveryIds: string[] = [];
  for (const { id } of due) {
    const claimed = await prisma.researchEmailCampaign.updateMany({
      where: { id, status: "SCHEDULED" },
      data: { status: "SENDING", startedAt: now },
    });
    if (claimed.count === 0) continue;

    try {
      deliveryIds.push(...(await materializeCampaign(id)));
    } catch (error) {
      await prisma.researchEmailCampaign.update({
        where: { id },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          error: describeError(error),
        },
      });
    }
  }
  return deliveryIds;
}

async function materializeCampaign(campaignId: string): Promise<string[]> {
  const campaign = await prisma.researchEmailCampaign.findUniqueOrThrow({
    where: { id: campaignId },
  });
  const plan =
    campaign.kind === "POST_SURVEY"
      ? await planPostSurveyRecipients(campaign.audience)
      : await planPoolRecipients(campaign.audience);

  const origin = campaign.appOrigin.replace(/\/+$/, "");
  const ids = await prisma.$transaction(async (tx) => {
    const created: string[] = [];
    for (const r of plan.recipients) {
      const vars = { ...r.vars };
      if (campaign.kind === "POST_SURVEY" && r.formId) {
        const { token, tokenHash } = newSurveyToken();
        await tx.surveyInvite.create({
          data: {
            tokenHash,
            formId: r.formId,
            userId: r.userId,
            email: r.email,
            name: r.name,
            campaignId,
          },
        });
        vars.surveyLink = `${origin}/survey/${token}`;
      }
      const row = await tx.researchEmailDelivery.create({
        data: {
          campaignId,
          userId: r.userId,
          recipient: r.email,
          variant: r.variant,
          vars: JSON.stringify(vars),
        },
        select: { id: true },
      });
      created.push(row.id);
    }
    return created;
  });

  await prisma.researchEmailCampaign.update({
    where: { id: campaignId },
    data: {
      error: plan.skipped.length ? plan.skipped.join(" ") : null,
      ...(ids.length === 0 ? { status: "SENT", completedAt: new Date() } : {}),
    },
  });
  return ids;
}

/** Mark a SENDING campaign SENT once none of its deliveries are still pending. */
async function completeCampaignIfDone(campaignId: string): Promise<void> {
  const pending = await prisma.researchEmailDelivery.count({
    where: { campaignId, status: "PENDING" },
  });
  if (pending > 0) return;
  await prisma.researchEmailCampaign.updateMany({
    where: { id: campaignId, status: "SENDING" },
    data: { status: "SENT", completedAt: new Date() },
  });
}

// ─── Delivery ────────────────────────────────────────────────────────────────

async function loadAttachments(json: string): Promise<EmailAttachment[]> {
  const list = parseAttachments(json);
  return Promise.all(
    list.map(async (a) => {
      const obj = await getS3Object(a.bucket, a.key);
      return {
        filename: a.name,
        content: Buffer.from(obj.body),
        contentType: a.contentType || obj.contentType,
      };
    }),
  );
}

export type ResearchEmailOutcome =
  | { status: "SENT" }
  | { status: "SKIPPED"; reason: string }
  | { status: "RETRY"; delaySeconds: number; error: string }
  | { status: "FAILED"; error: string };

export async function deliverResearchEmail(
  deliveryId: string,
  now: Date = new Date(),
): Promise<ResearchEmailOutcome> {
  const leaseCutoff = new Date(now.getTime() - RESEARCH_EMAIL_LEASE_MS);
  const claim = await prisma.researchEmailDelivery.updateMany({
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

  const delivery = await prisma.researchEmailDelivery.findUnique({
    where: { id: deliveryId },
    include: { campaign: true },
  });
  if (!delivery)
    return { status: "SKIPPED", reason: "delivery row no longer exists" };

  const { campaign } = delivery;
  if (campaign.status === "CANCELLED") {
    await prisma.researchEmailDelivery.update({
      where: { id: delivery.id },
      data: { status: "FAILED", claimedAt: null, lastError: "Cancelled" },
    });
    return { status: "SKIPPED", reason: "campaign cancelled" };
  }

  const vars = safeJson(delivery.vars) as RecipientVars;
  const versions = isResearchEmailKind(campaign.kind)
    ? parseVersions(campaign.kind, campaign.versions)
    : {};
  const content = renderResearchEmail(
    Object.keys(versions).length ? versions : legacyVersions(campaign),
    delivery.variant,
    vars,
  );

  try {
    // The admin's RESEARCH wrapper (Email / SMTP page) goes around the
    // composed message — by default it passes it through unchanged.
    const message = renderPurposeMessage(
      "RESEARCH",
      { appName: APP_NAME, subject: content.subject, body: content.text },
      await getSenderOverride("RESEARCH"),
    );
    const attachments = await loadAttachments(campaign.attachments);
    await sendEmailToRecipient({
      to: delivery.recipient,
      subject: message.subject,
      text: message.text,
      replyTo: campaign.replyTo || undefined,
      purpose: "RESEARCH",
      attachments,
    });
  } catch (error) {
    const reason = describeError(error);
    const giveUp =
      isPermanent(error) || delivery.attempts >= RESEARCH_EMAIL_MAX_ATTEMPTS;
    if (giveUp) {
      await prisma.researchEmailDelivery.update({
        where: { id: delivery.id },
        data: { status: "FAILED", claimedAt: null, lastError: reason },
      });
      await completeCampaignIfDone(campaign.id);
      return { status: "FAILED", error: reason };
    }
    const delaySeconds = backoffSecondsFor(delivery.attempts);
    await prisma.researchEmailDelivery.update({
      where: { id: delivery.id },
      data: {
        claimedAt: null,
        lastError: reason,
        nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000),
      },
    });
    return { status: "RETRY", delaySeconds, error: reason };
  }

  // The link has done its job once sent; drop the plaintext token from the row.
  const { surveyLink: _sent, ...rest } = vars;
  await prisma.researchEmailDelivery.update({
    where: { id: delivery.id },
    data: {
      status: "SENT",
      sentAt: now,
      claimedAt: null,
      lastError: null,
      vars: JSON.stringify(_sent ? { ...rest, surveyLink: "(sent)" } : rest),
    },
  });
  await completeCampaignIfDone(campaign.id);
  return { status: "SENT" };
}

/** Rows stuck PENDING past their due time with no live claim. */
export async function findStrandedResearchEmails(
  limit = 200,
  now: Date = new Date(),
): Promise<string[]> {
  const due = new Date(now.getTime() - RESEARCH_EMAIL_SWEEP_GRACE_MS);
  const leaseCutoff = new Date(now.getTime() - RESEARCH_EMAIL_LEASE_MS);
  const rows = await prisma.researchEmailDelivery.findMany({
    where: {
      status: "PENDING",
      attempts: { lt: RESEARCH_EMAIL_MAX_ATTEMPTS },
      nextAttemptAt: { lte: due },
      OR: [{ claimedAt: null }, { claimedAt: { lt: leaseCutoff } }],
    },
    select: { id: true },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });
  return rows.map((r) => r.id);
}

/** Close out rows that used every attempt, then any campaign left with nothing pending. */
export async function failExhaustedResearchEmails(): Promise<number> {
  const leaseCutoff = new Date(Date.now() - RESEARCH_EMAIL_LEASE_MS);
  const { count } = await prisma.researchEmailDelivery.updateMany({
    where: {
      status: "PENDING",
      attempts: { gte: RESEARCH_EMAIL_MAX_ATTEMPTS },
      OR: [{ claimedAt: null }, { claimedAt: { lt: leaseCutoff } }],
    },
    data: {
      status: "FAILED",
      claimedAt: null,
      lastError: `Gave up after ${RESEARCH_EMAIL_MAX_ATTEMPTS} delivery attempts`,
    },
  });
  const sending = await prisma.researchEmailCampaign.findMany({
    where: { status: "SENDING" },
    select: { id: true },
  });
  for (const c of sending) await completeCampaignIfDone(c.id);
  return count;
}

/** Worker tick: expand due campaigns and enqueue their deliveries. */
export async function runResearchEmailScheduler(): Promise<number> {
  const ids = await materializeDueCampaigns();
  if (ids.length > 0) enqueueResearchEmails(ids);
  return ids.length;
}
