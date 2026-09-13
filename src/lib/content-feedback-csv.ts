/**
 * CSV builders for the consolidated feedback panel's export.
 *
 * Unlike `grades-csv.ts` (and the consent/participation builders that reuse
 * it), this is NOT an eLC gradebook file — nothing here is imported back into
 * a grade column. It is an analysis extract, so it gets a plain named header
 * row and one line per verdict, which is what a spreadsheet or an R/pandas
 * read expects.
 *
 * Pure (no Prisma / Next imports): the route hands it rows it has already
 * authorized and scoped.
 */

import {
  FEEDBACK_RATING_LABELS,
  formatAverageRating,
  type FeedbackSubjectBreakdown,
} from "@/lib/content-feedback";

/**
 * RFC 4180 quoting, matching the tokenizer rules in
 * csv-roster / concept-csv / grades-csv.
 *
 * The leading-character guard is not about RFC 4180 at all: a field that
 * starts with =, +, -, or @ is executed as a formula by Excel and Sheets when
 * the file is opened, and every free-text column below is attacker-supplied
 * (a student types the explanation). Prefixing a tab keeps the text readable
 * while making the cell unambiguously a string.
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

/** ISO-8601 UTC — sortable, unambiguous, and locale-free for downstream tools. */
function csvTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

/** One verdict as exported. Mirrors the ContentFeedback row plus its context. */
export type FeedbackExportRow = {
  id: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  audience: string;
  subjectType: string;
  subjectId: string | null;
  subjectLabel: string;
  subjectDetail: string | null;
  rating: number;
  comment: string;
  authorName: string | null;
  authorEmail: string | null;
  authorRole: string;
  className: string | null;
  quizName: string | null;
  attemptId: string | null;
};

const DETAIL_HEADER = [
  "Feedback ID",
  "Submitted At (UTC)",
  "Updated At (UTC)",
  "Audience",
  "Author Role",
  "Author Name",
  "Author Email",
  "Subject Type",
  "Subject",
  "Subject Detail",
  "Subject ID",
  "Rating",
  "Rating Label",
  "Explanation",
  "Class",
  "Quiz",
  "Attempt ID",
] as const;

/** One line per verdict, newest first as the caller ordered them. */
export function buildFeedbackCsv(rows: readonly FeedbackExportRow[]): string {
  const lines = [
    csvRow(DETAIL_HEADER),
    ...rows.map((row) =>
      csvRow([
        row.id,
        csvTimestamp(row.createdAt),
        csvTimestamp(row.updatedAt),
        row.audience,
        row.authorRole,
        row.authorName ?? "",
        row.authorEmail ?? "",
        row.subjectType,
        row.subjectLabel,
        row.subjectDetail ?? "",
        row.subjectId ?? "",
        String(row.rating),
        FEEDBACK_RATING_LABELS[row.rating] ?? "",
        row.comment,
        row.className ?? "",
        row.quizName ?? "",
        row.attemptId ?? "",
      ]),
    ),
  ];
  return lines.join("\r\n") + "\r\n";
}

const SUMMARY_HEADER = [
  "Subject Type",
  "Subject",
  "Subject ID",
  "Ratings",
  "Average Rating",
  "1 - Not useful",
  "2 - Slightly useful",
  "3 - Somewhat useful",
  "4 - Useful",
  "5 - Very useful",
] as const;

/**
 * One line per rated subject: volume, mean, and the full 1-5 histogram. This
 * is the view that answers "which recommendations are not landing", so it is
 * exported in the panel's own worst-first order.
 */
export function buildFeedbackSummaryCsv(
  rows: readonly FeedbackSubjectBreakdown[],
): string {
  const lines = [
    csvRow(SUMMARY_HEADER),
    ...rows.map((row) =>
      csvRow([
        row.subjectType,
        row.subjectLabel,
        row.subjectId ?? "",
        String(row.count),
        formatAverageRating(row.average),
        String(row.distribution[1] ?? 0),
        String(row.distribution[2] ?? 0),
        String(row.distribution[3] ?? 0),
        String(row.distribution[4] ?? 0),
        String(row.distribution[5] ?? 0),
      ]),
    ),
  ];
  return lines.join("\r\n") + "\r\n";
}

/** `feedback-2026-09-04.csv` — stable, sortable download name. */
export function feedbackCsvFilename(
  view: "detail" | "summary",
  now: Date = new Date(),
): string {
  const day = now.toISOString().slice(0, 10);
  return view === "summary"
    ? `feedback-summary-${day}.csv`
    : `feedback-${day}.csv`;
}
