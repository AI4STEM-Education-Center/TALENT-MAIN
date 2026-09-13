import {
  buildGradeHeader,
  buildGradesCsv,
  formatGrade,
  type GradeExportRow,
} from "@/lib/grades-csv";

/**
 * CSV builder for the teacher "export signed students" request (§7 of
 * docs/plans/consent-compliance-plan.md). Deliberately reuses the same eLC
 * header/row conventions as grades-csv.ts so the file imports into eLC's
 * Grades tool the same way a quiz grade export does — this is a credit-points
 * file, not a disclosure of who did or didn't consent beyond the point value
 * a student earns for having signed.
 */

export interface ConsentExportRosterRow {
  orgDefinedId: string;
  lastName: string;
  firstName: string;
  /** Whether this roster student's account has an AGREE decision on file. */
  signed: boolean;
}

export function buildConsentExportCsv(
  gradeColumnName: string,
  pointsAwarded: number,
  rows: ConsentExportRosterRow[],
): string {
  const header = buildGradeHeader(gradeColumnName, pointsAwarded);
  const gradeRows: GradeExportRow[] = rows.map((r) => ({
    orgDefinedId: r.orgDefinedId,
    lastName: r.lastName,
    firstName: r.firstName,
    grade: r.signed ? formatGrade(pointsAwarded) : "",
  }));
  return buildGradesCsv(header, gradeRows);
}
