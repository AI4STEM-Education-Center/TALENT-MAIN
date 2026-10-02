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
  parseVersions,
  VERSION_LABELS,
  versionKeysFor,
  type ResearchEmailAttachment,
  type ResearchEmailKind,
  type ResearchEmailVersions,
  type VersionKey,
} from "@/lib/research-email";

const MAX_SUBJECT = 300;
const MAX_BODY = 20_000;

export type ResearchEmailInput = {
  kind: ResearchEmailKind;
  replyTo: string;
  versions: ResearchEmailVersions;
  attachments: ResearchEmailAttachment[];
  audience: string;
  /** The versions a send to the selected roles uses. */
  sendKeys: VersionKey[];
};

function str(value: string, max: number): string {
  return value.replace(/\r\n?/g, "\n").slice(0, max);
}

/**
 * `strict` is for sending (campaigns, tests): every version the selected roles
 * use needs a subject and a message, a post-survey email must carry
 * {{surveyLink}} in each, and the interview email needs a reply-to address
 * (people answer it to book a time). Saving a draft is lenient.
 */
export function parseResearchEmailInput(
  body: Record<string, unknown>,
  strict: boolean,
): { ok: true; value: ResearchEmailInput } | { ok: false; error: string } {
  if (!isResearchEmailKind(body.kind))
    return { ok: false, error: "Unknown email type." };
  const kind = body.kind;
  const replyTo =
    typeof body.replyTo === "string" ? body.replyTo.slice(0, 254).trim() : "";
  if (replyTo && !isEmailAddress(replyTo))
    return { ok: false, error: "The reply-to address is not a valid email." };

  const versions: ResearchEmailVersions = {};
  for (const [key, v] of Object.entries(parseVersions(kind, body.versions))) {
    versions[key as VersionKey] = {
      subject: str(v.subject, MAX_SUBJECT),
      body: str(v.body, MAX_BODY),
    };
  }
  const audience =
    kind === "POOL"
      ? normalizePoolAudience(body.audience)
      : normalizePostSurveyAudience(body.audience);
  const value: ResearchEmailInput = {
    kind,
    replyTo,
    versions,
    attachments: parseAttachments(JSON.stringify(body.attachments ?? [])),
    audience: JSON.stringify(audience),
    sendKeys: versionKeysFor(kind, audience.roles),
  };

  const total = value.attachments.reduce((sum, a) => sum + a.size, 0);
  if (total > MAX_TOTAL_ATTACHMENT_BYTES)
    return { ok: false, error: "Attachments add up to more than 15 MB." };

  if (strict) {
    if (kind === "POOL" && !replyTo)
      return {
        ok: false,
        error:
          "Enter a reply-to address so people can reply to the interview invitation.",
      };
    for (const key of value.sendKeys) {
      const v = versions[key];
      const label = VERSION_LABELS[key];
      if (!v?.subject.trim() || !v.body.trim())
        return {
          ok: false,
          error: `The ${label} needs both a subject and a message.`,
        };
      if (kind === "POST_SURVEY" && !/\{\{\s*surveyLink\s*\}\}/.test(v.body))
        return {
          ok: false,
          error: `The ${label} must include {{surveyLink}} so each person gets their survey link.`,
        };
    }
  }
  return { ok: true, value };
}
