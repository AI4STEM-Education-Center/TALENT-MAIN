import { buildGradeHeader, buildGradesCsv, formatGrade } from "@/lib/grades-csv";

export type ParticipationMetric = "quizzes-completed" | "completed-attempts";

export interface ParticipationCreditRow {
  orgDefinedId: string;
  lastName: string;
  firstName: string;
  quizzesCompleted: number;
  completedAttempts: number;
}

export function participationCount(
  row: ParticipationCreditRow,
  metric: ParticipationMetric
): number {
  return metric === "quizzes-completed" ? row.quizzesCompleted : row.completedAttempts;
}

/**
 * Build an eLC-importable participation grade entirely from data already sent
 * to the teacher's browser. Every roster student receives an explicit grade:
 * full credit at/above the chosen activity threshold, otherwise zero.
 */
export function buildParticipationCreditCsv({
  gradeColumnName,
  pointsAwarded,
  metric,
  threshold,
  rows,
}: {
  gradeColumnName: string;
  pointsAwarded: number;
  metric: ParticipationMetric;
  threshold: number;
  rows: ParticipationCreditRow[];
}): string {
  return buildGradesCsv(
    buildGradeHeader(gradeColumnName, pointsAwarded),
    rows.map((row) => ({
      orgDefinedId: row.orgDefinedId,
      lastName: row.lastName,
      firstName: row.firstName,
      grade: formatGrade(participationCount(row, metric) >= threshold ? pointsAwarded : 0),
    }))
  );
}
