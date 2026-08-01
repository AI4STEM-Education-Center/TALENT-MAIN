// Pure CSV builder for the teacher "export quiz grades" download. The output
// mirrors the UGA eLC gradebook export that the roster import consumes —
// header `OrgDefinedId,Last Name,First Name,End-of-Line Indicator`, CRLF line
// endings, "#"-prefixed OrgDefinedId, "#" end-of-line marker — with one
// teacher-named grade column inserted right before the End-of-Line Indicator
// so the file can be imported back into eLC's Grades tool.

export type GradeExportRow = {
  orgDefinedId: string; // stored without the leading "#" (see ClassStudentList)
  lastName: string;
  firstName: string;
  grade: string; // preformatted; "" when the student has no completed attempt
};

export type GradeExportMode = "best-attempt" | "completion";

type ExportGradeInput = {
  bestScore: number | null | undefined;
  hasCompletedAttempt: boolean;
  manualGrade: number | null | undefined;
  mode: GradeExportMode;
  maxPoints: number;
};

// RFC 4180 quoting, matching the tokenizer rules in csv-roster/concept-csv.
function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** Best score (0-100 float) as eLC-friendly number text: max 2 decimals, no trailing zeros. */
export function formatGrade(score: number | null | undefined): string {
  if (score === null || score === undefined) return "";
  return String(Math.round(score * 100) / 100);
}

/** Build the eLC numeric-column header from a teacher-visible grade item name. */
export function buildGradeHeader(name: string, maxPoints: number): string {
  return `${name} Points Grade <Numeric MaxPoints:${formatGrade(maxPoints)}>`;
}

/**
 * Convert a percentage into points for export. A manual percentage always
 * wins; otherwise completion mode awards full credit and best-attempt mode
 * scales the student's highest completed-attempt percentage to maxPoints.
 */
export function calculateExportGrade({
  bestScore,
  hasCompletedAttempt,
  manualGrade,
  mode,
  maxPoints,
}: ExportGradeInput): number | null {
  const percentage =
    manualGrade ??
    (hasCompletedAttempt
      ? mode === "completion"
        ? 100
        : bestScore ?? 0
      : null);
  return percentage === null ? null : (percentage / 100) * maxPoints;
}

export function buildGradesCsv(gradeHeader: string, rows: GradeExportRow[]): string {
  const lines = [
    [
      "OrgDefinedId",
      "Last Name",
      "First Name",
      csvField(gradeHeader),
      "End-of-Line Indicator",
    ].join(","),
    ...rows.map((r) =>
      [
        csvField(`#${r.orgDefinedId}`),
        csvField(r.lastName),
        csvField(r.firstName),
        csvField(r.grade),
        "#",
      ].join(",")
    ),
  ];
  return lines.join("\r\n") + "\r\n";
}
