// Alternative-version retakes: how a run on a QuizPracticeVersion is recorded
// in the same attempt/result pipeline as an ordinary retake, and how a student
// may leave out the questions they already answered correctly. Pure helpers
// (no DB) plus one Prisma-typed history query, kept apart from the route so
// both are unit-testable. See docs/features/alternative-quiz-versions.md.

import type { Prisma } from "@prisma/client";
import type { ScoredAnswerRecord } from "./quiz-scoring";
import type {
  SnapshotAnswerInput,
  SnapshotQuestionInput,
} from "./exam-results";
import type { VariantQuestion } from "./quiz-variants";

/**
 * Prisma `where` fragment selecting the attempts that count toward the graded
 * record: best score, mean/pass-rate stats, the attempt cap, grade exports and
 * per-question correctness on the quiz's own questions. Alternative-version
 * retakes are recorded as QuizAttempt rows (history, exam results, research
 * export, simulation/learning-resource telemetry) but are deliberately kept
 * out of these. Every grade-affecting QuizAttempt query spreads this; flipping
 * alternative retakes into the grade means changing it in one place (and
 * extending the same filter on the QuizAnswer → quizAttempt relation).
 */
export const GRADED_ATTEMPTS = { practiceVersionId: null } as const;

/** One answer from a completed attempt, for working out last-known correctness. */
export type AnswerHistoryRow = {
  questionId: string;
  isCorrect: boolean;
  completedAt: Date;
};

/**
 * Source-question ids the student currently has "correct": for each question,
 * its result in the most recent completed attempt that asked it (graded or
 * alternative). Equals "correct in your last attempt" when the last attempt
 * covered the whole quiz, and stays well defined when it left some questions out.
 */
export function previouslyCorrectQuestionIds(
  rows: AnswerHistoryRow[],
): Set<string> {
  const latest = new Map<string, { at: number; isCorrect: boolean }>();
  for (const row of rows) {
    const at = row.completedAt.getTime();
    const seen = latest.get(row.questionId);
    if (!seen || at > seen.at)
      latest.set(row.questionId, { at, isCorrect: row.isCorrect });
  }
  return new Set([...latest].flatMap(([id, v]) => (v.isCorrect ? [id] : [])));
}

type History = Pick<Prisma.TransactionClient, "quizAnswer">;

/** Load the student's answer history for a quiz and reduce it. */
export async function loadPreviouslyCorrect(
  db: History,
  who: { studentId: string; classId: string; quizId: string },
): Promise<{ correct: Set<string>; answered: Set<string> }> {
  const rows = await db.quizAnswer.findMany({
    where: { quizAttempt: { ...who, completedAt: { not: null } } },
    select: {
      questionId: true,
      isCorrect: true,
      quizAttempt: { select: { completedAt: true } },
    },
  });
  const history = rows.flatMap((r) =>
    r.quizAttempt.completedAt
      ? [
          {
            questionId: r.questionId,
            isCorrect: r.isCorrect,
            completedAt: r.quizAttempt.completedAt,
          },
        ]
      : [],
  );
  return {
    correct: previouslyCorrectQuestionIds(history),
    answered: new Set(history.map((h) => h.questionId)),
  };
}

export type RetakeSelection = {
  questions: VariantQuestion[];
  /** Source question ids left out of this retake. */
  excludedSourceIds: string[];
  /**
   * True when the student asked to exclude correct questions but nothing would
   * remain (everything was already correct), so the full version is used.
   */
  exclusionIgnored: boolean;
};

/**
 * Choose the questions a retake asks. Excluding is opt-in per start; if it
 * would leave nothing, the whole version is asked instead (and flagged) so a
 * student who aced the quiz can still practise rather than hit an empty run.
 */
export function selectRetakeQuestions(
  questions: VariantQuestion[],
  correctSourceIds: ReadonlySet<string>,
  excludeCorrect: boolean,
): RetakeSelection {
  if (!excludeCorrect)
    return { questions, excludedSourceIds: [], exclusionIgnored: false };
  const kept = questions.filter(
    (q) => !correctSourceIds.has(q.sourceQuestionId),
  );
  if (kept.length === 0)
    return { questions, excludedSourceIds: [], exclusionIgnored: true };
  return {
    questions: kept,
    excludedSourceIds: questions
      .filter((q) => correctSourceIds.has(q.sourceQuestionId))
      .map((q) => q.sourceQuestionId),
    exclusionIgnored: false,
  };
}

/**
 * QuizAnswer rows for a scored alternative run. QuizAnswer.questionId is a
 * foreign key to a live Question, so rows are filed under the variant's SOURCE
 * question (which also keeps "previously correct" history per original
 * question) and only for source questions that still exist. The alternative's
 * own choice ids go in selectedOptionIds (no FK); selectedOptionId stays null
 * because it references the Option table.
 */
export function variantAnswerRows(
  quizAttemptId: string,
  questions: VariantQuestion[],
  records: ScoredAnswerRecord[],
  existingSourceIds: ReadonlySet<string>,
) {
  const sourceByVariant = new Map(
    questions.map((q) => [q.id, q.sourceQuestionId]),
  );
  return records.flatMap((r) => {
    const questionId = sourceByVariant.get(r.questionId);
    if (!questionId || !existingSourceIds.has(questionId)) return [];
    return [
      {
        quizAttemptId,
        questionId,
        selectedOptionId: null,
        selectedOptionIds: JSON.stringify(r.selectedOptionIds),
        numericValue: r.numericValue,
        isCorrect: r.isCorrect,
      },
    ];
  });
}

/**
 * Inputs for buildReviewSnapshot so an alternative run produces the same
 * durable ExamResult snapshot as an ordinary attempt. The snapshot's
 * questionId is the SOURCE question, so incorrect answers still map to the
 * simulations attached to that question and to the misconception labelling.
 */
export function variantSnapshotInputs(
  questions: VariantQuestion[],
  records: ScoredAnswerRecord[],
): { questions: SnapshotQuestionInput[]; answers: SnapshotAnswerInput[] } {
  const sourceByVariant = new Map(
    questions.map((q) => [q.id, q.sourceQuestionId]),
  );
  return {
    questions: questions.map((q) => ({
      id: q.sourceQuestionId,
      text: q.text,
      options: q.options,
      answerMode: q.answerMode,
      answerNumeric: q.answerNumeric,
      answerTolerance: q.answerTolerance,
      answerUnit: q.answerUnit,
    })),
    answers: records.map((r) => ({
      questionId: sourceByVariant.get(r.questionId) ?? r.questionId,
      selectedOptionIds: r.selectedOptionIds,
      isCorrect: r.isCorrect,
      numericValue: r.numericValue,
    })),
  };
}

/** One-line context for a results view of an alternative-version retake. */
export function alternativeNotice(
  versionName: string,
  excludedCount: number,
): string {
  const left = excludedCount
    ? ` ${excludedCount} question${excludedCount === 1 ? "" : "s"} you answered correctly before ${excludedCount === 1 ? "was" : "were"} left out, so this score covers only the rest.`
    : "";
  return `Alternative version: ${versionName}. Recorded as a retake; your graded score is unchanged.${left}`;
}

/** How many source questions a stored `excludedQuestionIds` JSON array lists. */
export function excludedCountOf(raw: string | null | undefined): number {
  try {
    const parsed: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
