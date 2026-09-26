// Impure half of the research-survey feature: which form is live, whether a
// signed-in user owes the pre-survey, and recording a response. See
// src/lib/survey.ts for the pure question/answer model.

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { getActiveConsentVersion } from "@/lib/consent";
import { isEmailAddress } from "@/lib/email-purposes";
import {
  isSurveyRole,
  parseSurveyQuestions,
  validateSurveyAnswers,
  type SurveyKind,
  type SurveyQuestion,
  type SurveyRole,
} from "@/lib/survey";

/** The enabled form for a (kind, role), or null when the admin hasn't enabled one. */
export async function getEnabledSurveyForm(kind: SurveyKind, role: SurveyRole) {
  return prisma.surveyForm.findFirst({
    where: { kind, role, isEnabled: true, status: "READY" },
    orderBy: { updatedAt: "desc" },
  });
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
  const active = await getActiveConsentVersion(role);
  if (!active) return false;
  const record = await prisma.consentRecord.findFirst({
    where: { userId, formVersionId: active.id },
    orderBy: [{ signedAt: "desc" }, { id: "desc" }],
    select: { decision: true },
  });
  return record?.decision === "AGREE";
}

export type PublicSurveyForm = {
  id: string;
  kind: string;
  role: string;
  title: string;
  description: string;
  questions: SurveyQuestion[];
};

export function toPublicForm(form: {
  id: string;
  kind: string;
  role: string;
  title: string;
  description: string;
  questions: string;
}): PublicSurveyForm {
  return {
    id: form.id,
    kind: form.kind,
    role: form.role,
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
 * What the dashboard's SurveyGate should show a signed-in student/teacher.
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

  const active = await getActiveConsentVersion(role);
  let agreed = false;
  if (active) {
    const record = await prisma.consentRecord.findFirst({
      where: { userId, formVersionId: active.id },
      orderBy: [{ signedAt: "desc" }, { id: "desc" }],
      select: { decision: true },
    });
    if (!record) return { state: "CONSENT_PENDING" };
    agreed = record.decision === "AGREE";
  }

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
    const email = (input.interview.email ?? "").trim() || input.email;
    if (!isEmailAddress(email) || email.length > 254)
      return {
        ok: false,
        status: 400,
        error: "Enter a valid email address for interview contact.",
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
