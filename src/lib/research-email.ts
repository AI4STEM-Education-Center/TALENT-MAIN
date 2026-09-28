// Pure half of the research participant pool and its emails: who is in the
// pool, which version of an email each person gets, and the template
// variables. No Prisma / nodemailer imports — src/lib/research-email-server.ts
// is the side-effecting layer, and the admin composer shares this file for its
// live preview.

import { renderTemplate } from "@/lib/email-purposes";
import {
  isInterviewRecordingChoice,
  type InterviewRecordingChoice,
} from "@/lib/consent-fields";
import { isSurveyRole, type SurveyRole } from "@/lib/survey";

export const RESEARCH_EMAIL_KINDS = ["POOL", "POST_SURVEY"] as const;
export type ResearchEmailKind = (typeof RESEARCH_EMAIL_KINDS)[number];

export function isResearchEmailKind(
  value: unknown,
): value is ResearchEmailKind {
  return (
    typeof value === "string" &&
    (RESEARCH_EMAIL_KINDS as readonly string[]).includes(value)
  );
}

/** Where someone joined the pool: the IRB consent form, the pre-survey, or both. */
export const POOL_SOURCES = ["IRB", "SURVEY"] as const;
export type PoolSource = (typeof POOL_SOURCES)[number];

/**
 * Each campaign carries two versions of the email. People who agreed through
 * the IRB consent form get the IRB version (so it can reference their consent
 * level); everyone else — pre-survey opt-ins, and for the post-survey email
 * anyone without an IRB agreement — gets the survey version.
 */
export type EmailVariant = "IRB" | "SURVEY";

/** Short, email-friendly wording for the IRB interview-recording choice. */
export const CONSENT_LEVEL_LABELS: Record<InterviewRecordingChoice, string> = {
  VIDEO_AUDIO: "Interview with video and audio recording",
  AUDIO_ONLY: "Interview with audio-only recording",
  TRANSCRIPT_ONLY: "Interview transcribed, no audio or video recording",
  NO_INTERVIEW: "Study participation without an interview",
};

export function consentLevelLabel(choice: string | null | undefined): string {
  return choice && isInterviewRecordingChoice(choice)
    ? CONSENT_LEVEL_LABELS[choice]
    : "";
}

export type PoolEntry = {
  /** userId when the account still exists, otherwise the lowercased email. */
  key: string;
  userId: string | null;
  firstName: string;
  lastName: string;
  name: string;
  /** Where to write: the pre-survey contact email when given, else the account email. */
  email: string;
  role: SurveyRole;
  viaIrb: boolean;
  viaSurvey: boolean;
  /** IRB interview-recording choice; null when not agreed via IRB. */
  consentLevel: InterviewRecordingChoice | null;
  irbAgreedAt: string | null;
  surveyAgreedAt: string | null;
};

export type IrbPoolRow = {
  userId: string | null;
  role: string;
  decision: string;
  interviewRecordingChoice: string | null;
  signerNameSnapshot: string;
  signerEmailSnapshot: string;
  signedAt: Date | string;
  /** Live account fields when the account still exists. */
  user?: { firstName: string; lastName: string; email: string } | null;
};

export type SurveyPoolRow = {
  userId: string | null;
  role: string;
  interviewEmail: string | null;
  nameSnapshot: string;
  emailSnapshot: string;
  submittedAt: Date | string;
  user?: { firstName: string; lastName: string; email: string } | null;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  return {
    firstName: parts[0] ?? "",
    lastName: parts.slice(1).join(" "),
  };
}

/**
 * Build the pool from consent records and pre-survey opt-ins.
 *
 * Consent rows must be newest-first: a person's LATEST decision counts, so
 * someone who agreed and later withdrew (a newer DECLINE) is not in the pool
 * through the IRB route. Survey rows are the pre-survey responses that opted
 * in to interview contact (newest first); the newest contact email wins.
 */
export function mergePoolEntries(
  irbRows: readonly IrbPoolRow[],
  surveyRows: readonly SurveyPoolRow[],
): PoolEntry[] {
  const byKey = new Map<string, PoolEntry>();
  const seenIrb = new Set<string>();

  for (const row of irbRows) {
    const key = row.userId ?? row.signerEmailSnapshot.trim().toLowerCase();
    if (!key || seenIrb.has(key)) continue;
    seenIrb.add(key);
    if (row.decision !== "AGREE" || !isSurveyRole(row.role)) continue;
    const name = row.user
      ? { firstName: row.user.firstName, lastName: row.user.lastName }
      : splitName(row.signerNameSnapshot);
    byKey.set(key, {
      key,
      userId: row.userId,
      ...name,
      name: `${name.firstName} ${name.lastName}`.trim(),
      email: row.user?.email ?? row.signerEmailSnapshot,
      role: row.role,
      viaIrb: true,
      viaSurvey: false,
      consentLevel: isInterviewRecordingChoice(row.interviewRecordingChoice)
        ? row.interviewRecordingChoice
        : null,
      irbAgreedAt: iso(row.signedAt),
      surveyAgreedAt: null,
    });
  }

  for (const row of surveyRows) {
    const key = row.userId ?? row.emailSnapshot.trim().toLowerCase();
    if (!key || !isSurveyRole(row.role)) continue;
    const existing = byKey.get(key);
    const contact = row.interviewEmail?.trim() || null;
    if (existing) {
      if (existing.viaSurvey) continue;
      existing.viaSurvey = true;
      existing.surveyAgreedAt = iso(row.submittedAt);
      if (contact) existing.email = contact;
      continue;
    }
    const name = row.user
      ? { firstName: row.user.firstName, lastName: row.user.lastName }
      : splitName(row.nameSnapshot);
    byKey.set(key, {
      key,
      userId: row.userId,
      ...name,
      name: `${name.firstName} ${name.lastName}`.trim(),
      email: contact ?? row.user?.email ?? row.emailSnapshot,
      role: row.role,
      viaIrb: false,
      viaSurvey: true,
      consentLevel: null,
      irbAgreedAt: null,
      surveyAgreedAt: iso(row.submittedAt),
    });
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.lastName.localeCompare(b.lastName) ||
      a.firstName.localeCompare(b.firstName),
  );
}

export function agreedPlaceLabel(entry: {
  viaIrb: boolean;
  viaSurvey: boolean;
}): string {
  if (entry.viaIrb && entry.viaSurvey)
    return "the IRB consent form and the pre-survey";
  if (entry.viaIrb) return "the IRB consent form";
  if (entry.viaSurvey) return "the pre-survey";
  return "";
}

export function variantFor(entry: { viaIrb: boolean }): EmailVariant {
  return entry.viaIrb ? "IRB" : "SURVEY";
}

// ─── Audience ────────────────────────────────────────────────────────────────

/** "NONE" in consentLevels stands for pool members who did not agree via IRB. */
export type PoolAudience = {
  roles: SurveyRole[];
  sources: PoolSource[];
  consentLevels: Array<InterviewRecordingChoice | "NONE">;
};

/** Who receives a post-survey invitation, before per-person eligibility. */
export const POST_SURVEY_TARGETS = ["ALL", "PRE_COMPLETED", "POOL"] as const;
export type PostSurveyTarget = (typeof POST_SURVEY_TARGETS)[number];

export const POST_SURVEY_TARGET_LABELS: Record<PostSurveyTarget, string> = {
  ALL: "Everyone with an account in the selected roles",
  PRE_COMPLETED: "Only people who completed the pre-survey",
  POOL: "Only the research pool",
};

export type PostSurveyAudience = {
  roles: SurveyRole[];
  target: PostSurveyTarget;
};

export function normalizePoolAudience(input: unknown): PoolAudience {
  const r =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const roles = (Array.isArray(r.roles) ? r.roles : []).filter(isSurveyRole);
  const sources = (Array.isArray(r.sources) ? r.sources : []).filter(
    (s): s is PoolSource => s === "IRB" || s === "SURVEY",
  );
  const consentLevels = (
    Array.isArray(r.consentLevels) ? r.consentLevels : []
  ).filter(
    (c): c is InterviewRecordingChoice | "NONE" =>
      c === "NONE" || isInterviewRecordingChoice(c),
  );
  return {
    roles: roles.length ? [...new Set(roles)] : ["STUDENT"],
    sources: sources.length ? [...new Set(sources)] : ["IRB", "SURVEY"],
    consentLevels: [...new Set(consentLevels)],
  };
}

export function normalizePostSurveyAudience(
  input: unknown,
): PostSurveyAudience {
  const r =
    input && typeof input === "object"
      ? (input as Record<string, unknown>)
      : {};
  const roles = (Array.isArray(r.roles) ? r.roles : []).filter(isSurveyRole);
  const target = (POST_SURVEY_TARGETS as readonly unknown[]).includes(r.target)
    ? (r.target as PostSurveyTarget)
    : "ALL";
  return {
    roles: roles.length ? [...new Set(roles)] : ["STUDENT"],
    target,
  };
}

/** Pool members an audience selects. An empty consentLevels list means any level. */
export function filterPool(
  entries: readonly PoolEntry[],
  audience: PoolAudience,
): PoolEntry[] {
  return entries.filter((e) => {
    if (!audience.roles.includes(e.role)) return false;
    const sourceMatch =
      (e.viaIrb && audience.sources.includes("IRB")) ||
      (e.viaSurvey && audience.sources.includes("SURVEY"));
    if (!sourceMatch) return false;
    if (audience.consentLevels.length === 0) return true;
    return audience.consentLevels.includes(e.consentLevel ?? "NONE");
  });
}

// ─── Template variables ──────────────────────────────────────────────────────

export const RESEARCH_EMAIL_VARIABLES: ReadonlyArray<{
  name: string;
  description: string;
  kinds: readonly ResearchEmailKind[];
}> = [
  { name: "name", description: "Full name", kinds: ["POOL", "POST_SURVEY"] },
  {
    name: "firstName",
    description: "First name",
    kinds: ["POOL", "POST_SURVEY"],
  },
  {
    name: "lastName",
    description: "Last name",
    kinds: ["POOL", "POST_SURVEY"],
  },
  {
    name: "agreedPlace",
    description:
      "Where they agreed: the IRB consent form, the pre-survey, or both",
    kinds: ["POOL", "POST_SURVEY"],
  },
  {
    name: "consentLevel",
    description:
      "IRB consent level (blank for people who did not agree via IRB)",
    kinds: ["POOL", "POST_SURVEY"],
  },
  {
    name: "role",
    description: "Student or Teacher",
    kinds: ["POOL", "POST_SURVEY"],
  },
  {
    name: "appName",
    description: "Platform name",
    kinds: ["POOL", "POST_SURVEY"],
  },
  {
    name: "surveyLink",
    description: "Personal post-survey link — opens without signing in",
    kinds: ["POST_SURVEY"],
  },
];

export type RecipientVars = Record<string, string>;

export function recipientVars(
  person: {
    firstName: string;
    lastName: string;
    role: SurveyRole;
    viaIrb: boolean;
    viaSurvey: boolean;
    consentLevel: string | null;
  },
  appName: string,
  extra: Record<string, string> = {},
): RecipientVars {
  return {
    name: `${person.firstName} ${person.lastName}`.trim(),
    firstName: person.firstName,
    lastName: person.lastName,
    agreedPlace: agreedPlaceLabel(person),
    consentLevel: person.viaIrb ? consentLevelLabel(person.consentLevel) : "",
    role: person.role === "TEACHER" ? "Teacher" : "Student",
    appName,
    ...extra,
  };
}

export type ResearchEmailContent = {
  irbSubject: string;
  irbBody: string;
  surveySubject: string;
  surveyBody: string;
};

/**
 * Render one recipient's message. An empty version falls back to the other,
 * so a campaign written for one audience still sends something sensible to
 * the rest.
 */
export function renderResearchEmail(
  content: ResearchEmailContent,
  variant: EmailVariant,
  vars: RecipientVars,
): { subject: string; text: string } {
  const irb = { subject: content.irbSubject, body: content.irbBody };
  const survey = { subject: content.surveySubject, body: content.surveyBody };
  const [primary, fallback] = variant === "IRB" ? [irb, survey] : [survey, irb];
  const subject = primary.subject.trim() || fallback.subject.trim();
  const body = primary.body.trim() ? primary.body : fallback.body;
  return {
    subject: renderTemplate(subject, vars)
      .replace(/[\r\n]+/g, " ")
      .trim(),
    text: renderTemplate(body, vars),
  };
}

export type ResearchEmailAttachment = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  bucket: string;
  key: string;
};

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 15 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;

export function parseAttachments(
  json: string | null | undefined,
): ResearchEmailAttachment[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (a): a is ResearchEmailAttachment =>
          !!a &&
          typeof a.id === "string" &&
          typeof a.name === "string" &&
          typeof a.size === "number" &&
          typeof a.bucket === "string" &&
          typeof a.key === "string",
      )
      .map((a) => ({
        ...a,
        contentType:
          typeof a.contentType === "string"
            ? a.contentType
            : "application/octet-stream",
      }))
      .slice(0, MAX_ATTACHMENTS);
  } catch {
    return [];
  }
}

/** Starter copy for a fresh install; the admin edits it before first send. */
export const DEFAULT_RESEARCH_EMAIL_CONTENT: Record<
  ResearchEmailKind,
  ResearchEmailContent
> = {
  POOL: {
    irbSubject: "{{appName}} research study: follow-up",
    irbBody: `Hi {{firstName}},

Thank you for agreeing to take part in the {{appName}} research study through {{agreedPlace}} (consent level: {{consentLevel}}).

We would like to follow up with you. This is for research purposes only, to help us improve the platform.

Simply reply to this email if you have any questions.`,
    surveySubject: "{{appName}} research study: follow-up",
    surveyBody: `Hi {{firstName}},

Thank you for letting us contact you through {{agreedPlace}}.

We would like to follow up with you about a possible interview. This is for research purposes only, to help us improve the platform.

Simply reply to this email if you have any questions.`,
  },
  POST_SURVEY: {
    irbSubject: "Please share your experience with {{appName}}",
    irbBody: `Hi {{firstName}},

Thank you for taking part in the {{appName}} research study. We'd appreciate a few minutes of your time for a short survey about your experience with the platform. This is for research purposes only, to help us improve the platform.

Your personal survey link (no sign-in needed):
{{surveyLink}}

Please don't forward this link — it is unique to you.`,
    surveySubject: "Please share your experience with {{appName}}",
    surveyBody: `Hi {{firstName}},

We'd appreciate a few minutes of your time for a short survey about your experience with {{appName}}. This is for research purposes only, to help us improve the platform.

Your personal survey link (no sign-in needed):
{{surveyLink}}

Please don't forward this link — it is unique to you.`,
  },
};
