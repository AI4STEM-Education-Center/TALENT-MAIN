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

/** POOL is the interview invitation to the research pool. */
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
 * Interview emails come in two versions per role: people who agreed through
 * the IRB consent form get the IRB version (so it can reference their consent
 * level); pre-survey opt-ins get the survey version.
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

/** IRB consent levels that include an interview. */
export const INTERVIEW_CONSENT_LEVELS = [
  "VIDEO_AUDIO",
  "AUDIO_ONLY",
  "TRANSCRIPT_ONLY",
] as const satisfies readonly InterviewRecordingChoice[];
export type InterviewConsentLevel = (typeof INTERVIEW_CONSENT_LEVELS)[number];

export function isInterviewConsentLevel(
  value: unknown,
): value is InterviewConsentLevel {
  return (INTERVIEW_CONSENT_LEVELS as readonly unknown[]).includes(value);
}

// ─── Versions ────────────────────────────────────────────────────────────────

/**
 * Each email is written separately for students and teachers. The post-survey
 * email has one version per role; the interview email has an IRB and a survey
 * version per role.
 */
export const VERSION_KEYS = {
  POST_SURVEY: ["STUDENT", "TEACHER"],
  POOL: ["STUDENT_IRB", "STUDENT_SURVEY", "TEACHER_IRB", "TEACHER_SURVEY"],
} as const satisfies Record<ResearchEmailKind, readonly string[]>;

export type VersionKey =
  | (typeof VERSION_KEYS.POST_SURVEY)[number]
  | (typeof VERSION_KEYS.POOL)[number];

export type EmailVersion = { subject: string; body: string };
export type ResearchEmailVersions = Partial<Record<VersionKey, EmailVersion>>;

export const VERSION_LABELS: Record<VersionKey, string> = {
  STUDENT: "Student email",
  TEACHER: "Teacher email",
  STUDENT_IRB: "Student · IRB version",
  STUDENT_SURVEY: "Student · survey version",
  TEACHER_IRB: "Teacher · IRB version",
  TEACHER_SURVEY: "Teacher · survey version",
};

export function isVersionKey(
  kind: ResearchEmailKind,
  value: unknown,
): value is VersionKey {
  return (VERSION_KEYS[kind] as readonly unknown[]).includes(value);
}

/** The versions a send to these roles uses, in display order. */
export function versionKeysFor(
  kind: ResearchEmailKind,
  roles: readonly SurveyRole[],
): VersionKey[] {
  return VERSION_KEYS[kind].filter((k) =>
    roles.some((role) => k === role || k.startsWith(`${role}_`)),
  );
}

/** Which version one recipient gets. */
export function versionKeyFor(
  kind: ResearchEmailKind,
  person: { role: SurveyRole; viaIrb: boolean },
): VersionKey {
  return kind === "POST_SURVEY"
    ? person.role
    : (`${person.role}_${variantFor(person)}` as VersionKey);
}

/** Keep only well-formed versions this kind uses. */
export function parseVersions(
  kind: ResearchEmailKind,
  input: unknown,
): ResearchEmailVersions {
  let raw = input;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  if (!raw || typeof raw !== "object") return {};
  const out: ResearchEmailVersions = {};
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isVersionKey(kind, key) || !v || typeof v !== "object") continue;
    const { subject, body } = v as Record<string, unknown>;
    out[key] = {
      subject: typeof subject === "string" ? subject : "",
      body: typeof body === "string" ? body : "",
    };
  }
  return out;
}

/**
 * Campaigns scheduled before per-role versions existed kept an IRB and a
 * survey version in columns, keyed on the delivery's "IRB" | "SURVEY"
 * variant. An empty one fell back to the other, so that is kept here.
 */
export function legacyVersions(row: {
  irbSubject: string;
  irbBody: string;
  surveySubject: string;
  surveyBody: string;
}): Record<EmailVariant, EmailVersion> {
  const irb = { subject: row.irbSubject, body: row.irbBody };
  const survey = { subject: row.surveySubject, body: row.surveyBody };
  const pick = (primary: EmailVersion, fallback: EmailVersion) => ({
    subject: primary.subject.trim() ? primary.subject : fallback.subject,
    body: primary.body.trim() ? primary.body : fallback.body,
  });
  return { IRB: pick(irb, survey), SURVEY: pick(survey, irb) };
}

// ─── Audience ────────────────────────────────────────────────────────────────

/**
 * Who gets the interview email. consentLevels narrows the IRB route (empty
 * means any level that includes an interview); pre-survey opt-ins all agreed
 * to an interview, so it does not apply to them.
 */
export type PoolAudience = {
  roles: SurveyRole[];
  sources: PoolSource[];
  consentLevels: InterviewConsentLevel[];
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
  ).filter(isInterviewConsentLevel);
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

/**
 * Pool members the interview email reaches: people who agreed to an interview,
 * either on the IRB consent form (a level other than "no interview") or by
 * opting in on the pre-survey.
 */
export function filterPool(
  entries: readonly PoolEntry[],
  audience: PoolAudience,
): PoolEntry[] {
  return entries.filter((e) => {
    if (!audience.roles.includes(e.role)) return false;
    const viaIrb =
      e.viaIrb &&
      audience.sources.includes("IRB") &&
      isInterviewConsentLevel(e.consentLevel) &&
      (audience.consentLevels.length === 0 ||
        audience.consentLevels.includes(e.consentLevel));
    const viaSurvey = e.viaSurvey && audience.sources.includes("SURVEY");
    return viaIrb || viaSurvey;
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
    kinds: ["POOL"],
  },
  {
    name: "consentLevel",
    description:
      "IRB consent level (blank for people who did not agree via IRB)",
    kinds: ["POOL"],
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

/** Render one recipient's message from the version they get. */
export function renderResearchEmail(
  versions: Partial<Record<string, EmailVersion>>,
  key: string,
  vars: RecipientVars,
): { subject: string; text: string } {
  const version = versions[key] ?? { subject: "", body: "" };
  return {
    subject: renderTemplate(version.subject.trim(), vars)
      .replace(/[\r\n]+/g, " ")
      .trim(),
    text: renderTemplate(version.body, vars),
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

const INTERVIEW_BOOKING_LINK =
  "https://bookings.cloud.microsoft/book/AI4TalentStudentInterview@groups.uga.edu/?ismsaljsauthenabled";

const INTERVIEW_SUBJECT =
  "Invitation to share your experience with {{appName}}";

const INTERVIEW_CLOSING = `If you would like to participate, please use the link below to choose a time that works best for you:
${INTERVIEW_BOOKING_LINK}

If none of the available times work for you, please feel free to reply to this email.

Thank you very much for considering our invitation. We truly welcome and appreciate your feedback, and your input would be very valuable in helping us improve {{appName}}.

Best,
AI4Talent Research Team
University of Georgia`;

const POST_SURVEY_LINK = `Your personal survey link (no sign-in needed):
{{surveyLink}}

Please don't forward this link — it is unique to you.`;

/** Starter copy until the admin saves their own; every version is editable. */
export const DEFAULT_RESEARCH_EMAIL_VERSIONS: Record<
  ResearchEmailKind,
  ResearchEmailVersions
> = {
  POOL: {
    STUDENT_IRB: {
      subject: INTERVIEW_SUBJECT,
      body: `Hi {{firstName}},

Thank you again for taking part in the {{appName}} research study and for using the platform.

We would greatly appreciate the opportunity to hear more about your experience with {{appName}}. If you are willing, we would be very happy to invite you to participate in an interview and share your thoughts about what worked well, what was challenging, and how we could improve the platform.

The interview is completely optional. There is no obligation to participate, and choosing not to participate will not affect your course or your participation in the study.

${INTERVIEW_CLOSING}`,
    },
    STUDENT_SURVEY: {
      subject: INTERVIEW_SUBJECT,
      body: `Hi {{firstName}},

Thank you for completing the {{appName}} pre-survey and for letting us know you would be open to an interview.

We would greatly appreciate the opportunity to hear more about your experience with {{appName}}. If you are still willing, we would be very happy to invite you to participate in an interview and share your thoughts about what worked well, what was challenging, and how we could improve the platform.

The interview is completely optional. There is no obligation to participate, and choosing not to participate will not affect your course in any way.

${INTERVIEW_CLOSING}`,
    },
    TEACHER_IRB: {
      subject: INTERVIEW_SUBJECT,
      body: `Hi {{firstName}},

Thank you again for taking part in the {{appName}} research study and for using the platform with your students.

We would greatly appreciate the opportunity to hear more about your experience teaching with {{appName}}. If you are willing, we would be very happy to invite you to participate in an interview and share your thoughts about what worked well in your classes, what was challenging, and how we could improve the platform.

The interview is completely optional. There is no obligation to participate, and choosing not to participate will not affect your use of the platform or your participation in the study.

${INTERVIEW_CLOSING}`,
    },
    TEACHER_SURVEY: {
      subject: INTERVIEW_SUBJECT,
      body: `Hi {{firstName}},

Thank you for completing the {{appName}} pre-survey and for letting us know you would be open to an interview.

We would greatly appreciate the opportunity to hear more about your experience teaching with {{appName}}. If you are still willing, we would be very happy to invite you to participate in an interview and share your thoughts about what worked well in your classes, what was challenging, and how we could improve the platform.

The interview is completely optional. There is no obligation to participate, and choosing not to participate will not affect your use of the platform in any way.

${INTERVIEW_CLOSING}`,
    },
  },
  POST_SURVEY: {
    STUDENT: {
      subject: "Please share your experience with {{appName}}",
      body: `Hi {{firstName}},

We'd appreciate a few minutes of your time for a short survey about your experience with {{appName}}. This is for research purposes only, to help us improve the platform.

${POST_SURVEY_LINK}`,
    },
    TEACHER: {
      subject: "Please share your experience with {{appName}}",
      body: `Hi {{firstName}},

We'd appreciate a few minutes of your time for a short survey about your experience teaching with {{appName}}. This is for research purposes only, to help us improve the platform.

${POST_SURVEY_LINK}`,
    },
  },
};
