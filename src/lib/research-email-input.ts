// Request parsing shared by the research-email admin routes (template save,
// campaign create, test send). Returns a normalized payload or a user-facing
// error — kept separate from the routes so they validate identically.

import { isEmailAddress } from "@/lib/email-purposes";
import {
  isResearchEmailKind,
  MAX_TOTAL_ATTACHMENT_BYTES,
  normalizePoolAudience,
  normalizePostSurveyAudience,
  parseAttachments,
  type ResearchEmailAttachment,
  type ResearchEmailKind,
} from "@/lib/research-email";

const MAX_SUBJECT = 300;
const MAX_BODY = 20_000;

export type ResearchEmailInput = {
  kind: ResearchEmailKind;
  replyTo: string;
  irbSubject: string;
  irbBody: string;
  surveySubject: string;
  surveyBody: string;
  attachments: ResearchEmailAttachment[];
  audience: string;
};

function str(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").slice(0, max)
    : "";
}

/**
 * `strict` is for sending (campaigns, tests): a reply-to address is required,
 * at least one version must be written, and a post-survey email must carry
 * {{surveyLink}} in every version it will send. Saving a draft is lenient.
 */
export function parseResearchEmailInput(
  body: Record<string, unknown>,
  strict: boolean,
): { ok: true; value: ResearchEmailInput } | { ok: false; error: string } {
  if (!isResearchEmailKind(body.kind))
    return { ok: false, error: "Unknown email type." };
  const kind = body.kind;
  const replyTo = str(body.replyTo, 254).trim();
  if (replyTo && !isEmailAddress(replyTo))
    return { ok: false, error: "The reply-to address is not a valid email." };

  const value: ResearchEmailInput = {
    kind,
    replyTo,
    irbSubject: str(body.irbSubject, MAX_SUBJECT),
    irbBody: str(body.irbBody, MAX_BODY),
    surveySubject: str(body.surveySubject, MAX_SUBJECT),
    surveyBody: str(body.surveyBody, MAX_BODY),
    attachments: parseAttachments(JSON.stringify(body.attachments ?? [])),
    audience: JSON.stringify(
      kind === "POOL"
        ? normalizePoolAudience(body.audience)
        : normalizePostSurveyAudience(body.audience),
    ),
  };

  const total = value.attachments.reduce((sum, a) => sum + a.size, 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES)
    return { ok: false, error: "Attachments add up to more than 15 MB." };

  if (strict) {
    if (!replyTo)
      return {
        ok: false,
        error:
          "Enter a dedicated reply-to address so replies reach the research team.",
      };
    const versions = [
      { label: "IRB version", subject: value.irbSubject, body: value.irbBody },
      {
        label: "Survey version",
        subject: value.surveySubject,
        body: value.surveyBody,
      },
    ].filter((v) => v.subject.trim() || v.body.trim());
    if (versions.length === 0)
      return { ok: false, error: "Write the email before sending it." };
    for (const v of versions) {
      if (!v.subject.trim() || !v.body.trim())
        return {
          ok: false,
          error: `The ${v.label} needs both a subject and a message.`,
        };
      if (kind === "POST_SURVEY" && !/\{\{\s*surveyLink\s*\}\}/.test(v.body))
        return {
          ok: false,
          error: `The ${v.label} must include {{surveyLink}} so each person gets their survey link.`,
        };
    }
  }
  return { ok: true, value };
}
