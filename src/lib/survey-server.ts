// Impure half of the research-survey feature: which form is live, whether a
// signed-in user owes the pre-survey or an in-app post-survey, the IRB
// re-consent prompt, and recording a response. See src/lib/survey.ts for the
// pure question/answer model and the decision rules.

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getActiveConsentVersion } from "@/lib/consent";
import { isEmailAddress } from "@/lib/email-purposes";
import {
  isSurveyRole,
  parseSurveyPeriod,
  parseSurveyQuestions,
  repromptCampaignKey,
  resolveSurveyGate,
  shouldRepromptConsent,
  validateSurveyAnswers,
  type IrbDecision,
  type SurveyKind,
  type SurveyPeriod,
  type SurveyQuestion,
  type SurveyRole,
} from "@/lib/survey";

/**
 * The enabled form for a (kind, role), or null when the admin hasn't enabled
 * one. POST forms are enabled per study period: pass `period` for that
 * period's form, or omit it for the lowest enabled period.
 */
export async function getEnabledSurveyForm(
  kind: SurveyKind,
  role: SurveyRole,
  period?: SurveyPeriod,
) {
  return prisma.surveyForm.findFirst({
    where: {
      kind,
      role,
      isEnabled: true,
      status: "READY",
      ...(kind === "POST" && period !== undefined ? { period } : {}),
    },
    orderBy: [{ period: "asc" }, { updatedAt: "desc" }],
  });
}

/**
 * The user's latest decision on the ACTIVE consent form for their role (the
 * newest record wins, so re-deciding after a DECLINE counts), and whether a
 * form is published at all.
 */
export async function getIrbDecision(
  userId: string,
  role: SurveyRole,
): Promise<{ hasActiveForm: boolean; decision: IrbDecision }> {
  const active = await getActiveConsentVersion(role);
  if (!active) return { hasActiveForm: false, decision: null };
  const record = await prisma.consentRecord.findFirst({
    where: { userId, formVersionId: active.id },
    orderBy: [{ signedAt: "desc" }, { id: "desc" }],
    select: { decision: true },
  });
  const decision =
    record?.decision === "AGREE" || record?.decision === "DECLINE"
      ? record.decision
      : null;
  return { hasActiveForm: true, decision };
}

/**
 * Whether the user's latest decision on the ACTIVE consent form for their role
 * is AGREE — the study's "opted in to data collection". Mirrors
 * hasResearchConsent (src/lib/consent.ts), generalized to teachers.
 */
export async function hasIrbAgreement(
  userId: string,
  role: SurveyRole,
): Promise<boolean> {
  return (await getIrbDecision(userId, role)).decision === "AGREE";
}

/** Enabled, READY post-surveys the admin is prompting in-app for a role. */
export async function getPromptedPostForms(role: SurveyRole) {
  return prisma.surveyForm.findMany({
    where: {
      kind: "POST",
      role,
      isEnabled: true,
      status: "READY",
      promptInApp: true,
      promptStartedAt: { not: null },
    },
    orderBy: [{ period: "asc" }, { updatedAt: "desc" }],
  });
}

export type ConsentReprompt = { campaignKey: string; period: SurveyPeriod };

/**
 * The IRB re-consent prompt for someone who declined: shown while a
 * post-survey for their role is prompting in-app (a new study period is
 * starting), until they re-decide or choose "No thanks" for this campaign.
 * Students only: a teacher who declined is already hard-gated by src/proxy.ts
 * until they agree, so a softer prompt would never be reachable.
 */
export async function getConsentReprompt(
  userId: string,
  role: SurveyRole,
  known?: { decision: IrbDecision },
  promptedForms?: Awaited<ReturnType<typeof getPromptedPostForms>>,
): Promise<ConsentReprompt | null> {
  if (role !== "STUDENT") return null;
  const decision = known
    ? known.decision
    : (await getIrbDecision(userId, role)).decision;
  if (decision !== "DECLINE") return null;
  const forms = promptedForms ?? (await getPromptedPostForms(role));
  const campaignKey = repromptCampaignKey(forms);
  if (!campaignKey) return null;
  const dismissal = await prisma.consentRepromptDismissal.findUnique({
    where: { userId_campaignKey: { userId, campaignKey } },
    select: { id: true },
  });
  if (!shouldRepromptConsent({ decision, campaignKey, dismissed: !!dismissal }))
    return null;
  const form = forms.find((f) => f.id === campaignKey);
  return { campaignKey, period: parseSurveyPeriod(form?.period) };
}

export type PublicSurveyForm = {
  id: string;
  kind: string;
  role: string;
  period: number;
  title: string;
  description: string;
  questions: SurveyQuestion[];
};

export function toPublicForm(form: {
  id: string;
  kind: string;
  role: string;
  period: number;
  title: string;
  description: string;
  questions: string;
}): PublicSurveyForm {
  return {
    id: form.id,
    kind: form.kind,
    role: form.role,
    period: form.period,
    title: form.title,
    description: form.description,
    questions: parseSurveyQuestions(form.questions),
  };
}

export type PreSurveyStatus =
  | { state: "NONE" }
  | { state: "CONSENT_PENDING" }
  | {
      state: "DUE";
      mandatory: boolean;
      form: PublicSurveyForm;
    };

/**
 * The pre-survey alone, as /api/surveys/pre reports it (SurveyGate itself uses
 * getDueSurveyStatus, which also sequences in-app post-surveys).
 *
 * - Nothing until the IRB consent decision is on file — that modal comes first.
 * - Mandatory (non-dismissible) when they agreed to the IRB form.
 * - Otherwise an optional prompt, until they submit or choose "No thanks".
 */
export async function getPreSurveyStatus(
  userId: string,
  role: SurveyRole,
): Promise<PreSurveyStatus> {
  const form = await getEnabledSurveyForm("PRE", role);
  if (!form) return { state: "NONE" };

  const irb = await getIrbDecision(userId, role);
  if (irb.hasActiveForm && irb.decision === null)
    return { state: "CONSENT_PENDING" };
  const agreed = irb.decision === "AGREE";

  const [response, dismissal] = await Promise.all([
    prisma.surveyResponse.findFirst({
      where: { userId, formId: form.id },
      select: { id: true },
    }),
    agreed
      ? Promise.resolve(null)
      : prisma.surveyPromptDismissal.findUnique({
          where: { userId_formId: { userId, formId: form.id } },
          select: { id: true },
        }),
  ]);
  if (response || dismissal) return { state: "NONE" };

  return { state: "DUE", mandatory: agreed, form: toPublicForm(form) };
}

export type DueSurveyStatus =
  | { state: "NONE" }
  | { state: "CONSENT_PENDING" }
  | {
      state: "DUE";
      kind: SurveyKind;
      period: SurveyPeriod;
      mandatory: boolean;
      form: PublicSurveyForm;
    };

/**
 * Everything the dashboard SurveyGate may show a signed-in student/teacher,
 * one at a time: the pre-survey first, then a due in-app post-survey. The
 * rules live in resolveSurveyGate (src/lib/survey.ts); this only loads the
 * facts. Also the server-side check that a submitted form is the one due.
 */
export async function getDueSurveyStatus(
  userId: string,
  role: SurveyRole,
): Promise<DueSurveyStatus> {
  const [preForm, postForms, irb] = await Promise.all([
    getEnabledSurveyForm("PRE", role),
    getPromptedPostForms(role),
    getIrbDecision(userId, role),
  ]);
  if (!preForm && postForms.length === 0) return { state: "NONE" };

  const formIds = [preForm?.id, ...postForms.map((f) => f.id)].filter(
    (id): id is string => !!id,
  );
  const needHistory = postForms.length > 0 && irb.decision === "AGREE";
  const [responses, firstPre, firstAgree, preDismissal, reprompt] =
    await Promise.all([
      prisma.surveyResponse.findMany({
        where: { userId, formId: { in: formIds } },
        select: { formId: true },
      }),
      needHistory
        ? prisma.surveyResponse.findFirst({
            where: { userId, kind: "PRE", role },
            orderBy: { submittedAt: "asc" },
            select: { submittedAt: true },
          })
        : Promise.resolve(null),
      needHistory
        ? prisma.consentRecord.findFirst({
            where: { userId, role, decision: "AGREE" },
            orderBy: { signedAt: "asc" },
            select: { signedAt: true },
          })
        : Promise.resolve(null),
      preForm && irb.decision !== "AGREE"
        ? prisma.surveyPromptDismissal.findUnique({
            where: { userId_formId: { userId, formId: preForm.id } },
            select: { id: true },
          })
        : Promise.resolve(null),
      getConsentReprompt(userId, role, irb, postForms),
    ]);

  const gate = resolveSurveyGate({
    hasActiveConsentForm: irb.hasActiveForm,
    decision: irb.decision,
    repromptPending: reprompt !== null,
    preFormId: preForm?.id ?? null,
    preDismissed: !!preDismissal,
    postForms,
    respondedFormIds: new Set(responses.map((r) => r.formId)),
    firstPreSubmittedAt: firstPre?.submittedAt ?? null,
    firstAgreedAt: firstAgree?.signedAt ?? null,
  });
  if (gate.state !== "DUE") return gate;
  const form =
    gate.kind === "PRE" ? preForm : postForms.find((f) => f.id === gate.formId);
  if (!form) return { state: "NONE" };
  return {
    state: "DUE",
    kind: gate.kind,
    period: gate.kind === "POST" ? gate.period : 1,
    mandatory: gate.mandatory,
    form: toPublicForm(form),
  };
}

/**
 * For the admin list: how many people an in-app post-survey prompt targets
 * (isPostSurveyEligible: latest IRB decision AGREE, plus an AGREE and a
 * pre-survey before the prompt started) and how many of them have answered
 * it, in the app or by emailed link.
 */
export async function countPostPromptAudience(form: {
  id: string;
  role: string;
  promptStartedAt: Date | null;
}): Promise<{ eligible: number; completed: number } | null> {
  if (!form.promptStartedAt || !isSurveyRole(form.role)) return null;
  const active = await getActiveConsentVersion(form.role);
  if (!active) return { eligible: 0, completed: 0 };
  const [records, earlyAgrees, pres, done] = await Promise.all([
    prisma.consentRecord.findMany({
      where: { formVersionId: active.id, userId: { not: null } },
      orderBy: [{ signedAt: "desc" }, { id: "desc" }],
      select: { userId: true, decision: true },
    }),
    prisma.consentRecord.findMany({
      where: {
        role: form.role,
        decision: "AGREE",
        userId: { not: null },
        signedAt: { lt: form.promptStartedAt },
      },
      select: { userId: true },
    }),
    prisma.surveyResponse.findMany({
      where: {
        kind: "PRE",
        role: form.role,
        userId: { not: null },
        submittedAt: { lt: form.promptStartedAt },
      },
      select: { userId: true },
    }),
    prisma.surveyResponse.findMany({
      where: { formId: form.id, userId: { not: null } },
      select: { userId: true },
    }),
  ]);
  const latest = new Map<string, string>();
  for (const r of records)
    if (r.userId && !latest.has(r.userId)) latest.set(r.userId, r.decision);
  const agreedEarly = new Set(earlyAgrees.map((r) => r.userId as string));
  const eligible = new Set(
    pres
      .map((p) => p.userId as string)
      .filter((id) => latest.get(id) === "AGREE" && agreedEarly.has(id)),
  );
  const completed = new Set(
    done.map((d) => d.userId as string).filter((id) => eligible.has(id)),
  );
  return { eligible: eligible.size, completed: completed.size };
}

// ─── Post-survey invite tokens ───────────────────────────────────────────────

export function hashSurveyToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newSurveyToken(): { token: string; tokenHash: string } {
  const token = randomBytes(24).toString("base64url");
  return { token, tokenHash: hashSurveyToken(token) };
}

/** Invite for a link token plus its form, or null when the token is unknown. */
export async function findSurveyInvite(token: string) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) return null;
  return prisma.surveyInvite.findUnique({
    where: { tokenHash: hashSurveyToken(token) },
    include: { form: true },
  });
}

export type RecordResult =
  | { ok: true; responseId: string; duplicate: boolean }
  | { ok: false; status: number; error: string; questionId?: string };

/**
 * Validate and store one submission. A second submission for the same person
 * and form is treated as success (a double-click or a retried request), never
 * as a second response.
 */
export async function recordSurveyResponse(input: {
  form: { id: string; kind: string; role: string; questions: string };
  userId: string | null;
  name: string;
  email: string;
  source: "APP" | "LINK";
  answers: unknown;
  interview?: { optIn: boolean; email: string | null };
}): Promise<RecordResult> {
  const validation = validateSurveyAnswers(
    parseSurveyQuestions(input.form.questions),
    input.answers,
  );
  if (!validation.ok)
    return {
      ok: false,
      status: 400,
      error: validation.error,
      questionId: validation.questionId,
    };

  let interviewOptIn = false;
  let interviewEmail: string | null = null;
  if (input.form.kind === "PRE" && input.interview?.optIn) {
    const email = (input.interview.email ?? input.email).trim();
    if (!isEmailAddress(email) || email.length > 254)
      return {
        ok: false,
        status: 400,
        error: "Enter a valid email address for research contact.",
      };
    interviewOptIn = true;
    interviewEmail = email;
  }

  if (input.userId) {
    const existing = await prisma.surveyResponse.findFirst({
      where: { formId: input.form.id, userId: input.userId },
      select: { id: true },
    });
    if (existing) return { ok: true, responseId: existing.id, duplicate: true };
  }

  const irbAgreed =
    input.userId && isSurveyRole(input.form.role)
      ? await hasIrbAgreement(input.userId, input.form.role)
      : false;

  try {
    const created = await prisma.surveyResponse.create({
      data: {
        formId: input.form.id,
        userId: input.userId,
        kind: input.form.kind,
        role: input.form.role,
        answers: JSON.stringify(validation.answers),
        interviewOptIn,
        interviewEmail,
        irbAgreed,
        source: input.source,
        nameSnapshot: input.name.slice(0, 200),
        emailSnapshot: input.email.slice(0, 254),
      },
      select: { id: true },
    });
    return { ok: true, responseId: created.id, duplicate: false };
  } catch (error) {
    if ((error as { code?: string }).code === "P2002" && input.userId) {
      const existing = await prisma.surveyResponse.findFirst({
        where: { formId: input.form.id, userId: input.userId },
        select: { id: true },
      });
      if (existing)
        return { ok: true, responseId: existing.id, duplicate: true };
    }
    throw error;
  }
}
