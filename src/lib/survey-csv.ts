/**
 * CSV builders for the admin survey-response and research-pool exports —
 * analysis extracts (one named header row, one line per response/person), not
 * gradebook files. Pure: routes hand in rows they have already authorized.
 */

import {
  formatAnswer,
  type SurveyAnswers,
  type SurveyQuestion,
} from "@/lib/survey";
import {
  agreedPlaceLabel,
  consentLevelLabel,
  type PoolEntry,
} from "@/lib/research-email";

/**
 * RFC 4180 quoting plus the formula-injection guard used by the other CSV
 * builders: respondents type free text, and a cell starting with =, +, - or @
 * would run as a formula in Excel/Sheets.
 */
function csvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `\t${value}` : value;
  return /[",\r\n\t]/.test(guarded)
    ? `"${guarded.replaceAll('"', '""')}"`
    : guarded;
}

function csvRow(fields: readonly string[]): string {
  return fields.map(csvField).join(",");
}

function csvTimestamp(value: Date | string | null): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export type SurveyResponseExportRow = {
  id: string;
  submittedAt: Date | string;
  role: string;
  source: string;
  nameSnapshot: string;
  emailSnapshot: string;
  userId: string | null;
  irbAgreed: boolean;
  interviewOptIn: boolean;
  interviewEmail: string | null;
  answers: SurveyAnswers;
};

function questionHeader(q: SurveyQuestion, index: number): string {
  const text = q.text.replace(/\s+/g, " ").trim();
  return `Q${index + 1}: ${text.length > 120 ? `${text.slice(0, 117)}…` : text}`;
}

/** One line per response; one column per answerable question, in form order. */
export function buildSurveyResponsesCsv(
  questions: readonly SurveyQuestion[],
  rows: readonly SurveyResponseExportRow[],
  options: { includeInterview: boolean },
): string {
  const answerable = questions.filter((q) => q.type !== "section");
  const header = [
    "Response ID",
    "Submitted At (UTC)",
    "Role",
    "Source",
    "Name",
    "Email",
    "User ID",
    "IRB Agreed",
    ...(options.includeInterview
      ? ["Interview Contact OK", "Interview Contact Email"]
      : []),
    ...answerable.map(questionHeader),
  ];
  const lines = [csvRow(header)];
  for (const r of rows) {
    lines.push(
      csvRow([
        r.id,
        csvTimestamp(r.submittedAt),
        r.role,
        r.source === "LINK" ? "Email link" : "Signed in",
        r.nameSnapshot,
        r.emailSnapshot,
        r.userId ?? "",
        r.irbAgreed ? "Yes" : "No",
        ...(options.includeInterview
          ? [r.interviewOptIn ? "Yes" : "No", r.interviewEmail ?? ""]
          : []),
        ...answerable.map((q) => formatAnswer(r.answers[q.id])),
      ]),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function buildPoolCsv(entries: readonly PoolEntry[]): string {
  const lines = [
    csvRow([
      "Name",
      "First Name",
      "Last Name",
      "Email",
      "Role",
      "Agreed Via",
      "IRB Consent Level",
      "IRB Agreed At (UTC)",
      "Pre-survey Opt-in At (UTC)",
      "User ID",
    ]),
  ];
  for (const e of entries) {
    lines.push(
      csvRow([
        e.name,
        e.firstName,
        e.lastName,
        e.email,
        e.role,
        agreedPlaceLabel(e),
        consentLevelLabel(e.consentLevel),
        csvTimestamp(e.irbAgreedAt),
        csvTimestamp(e.surveyAgreedAt),
        e.userId ?? "",
      ]),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function csvFilename(base: string, now: Date = new Date()): string {
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${slug || "export"}_${now.toISOString().slice(0, 10)}.csv`;
}
