// Pure quiz-scoring logic, extracted from the quiz route so the
// correctness-critical grading rules can be unit-tested without a database.

export type ScorableOption = { id: string; isCorrect: boolean };

export type ScorableQuestion = {
  id: string;
  answerMode: string; // "SINGLE_SELECT" | "MULTI_SELECT" | "NUMERIC"
  options: ScorableOption[];
  // Present only for NUMERIC questions (which carry no options).
  answerNumeric?: number | null;
  answerTolerance?: number | null;
};

/** A raw, untrusted answer as posted by the client. */
export type SubmittedAnswer = {
  questionId: string;
  selectedOptionId?: unknown;
  selectedOptionIds?: unknown;
  numericValue?: unknown;
};

export type ScoredAnswerRecord = {
  quizAttemptId: string;
  questionId: string;
  selectedOptionId: string | null;
  selectedOptionIds: string[];
  numericValue: number | null;
  isCorrect: boolean;
};

export type QuizScore = {
  correct: number;
  total: number;
  score: number; // percentage 0–100
  answerRecords: ScoredAnswerRecord[];
};

/**
 * Default relative tolerance for grading NUMERIC answers, used when a question
 * does not carry its own `answerTolerance`. Expressed as a fraction of the
 * correct answer's magnitude (0.005 = 0.5%).
 */
const NUMERIC_REL_TOLERANCE = 0.005;

/**
 * Absolute floor for the default NUMERIC tolerance. Guarantees a sensible
 * window even for tiny (or zero) correct answers, where a purely relative
 * tolerance would collapse toward zero.
 */
const NUMERIC_ABS_TOLERANCE_FLOOR = 0.01;

/**
 * Coerce an untrusted submitted numeric answer into a clean finite number.
 * Accepts a finite `number`, or a `string` that trims to a parseable finite
 * decimal (e.g. "3.21", " -769.23 "). Returns null for null/undefined, blank
 * or whitespace-only strings, NaN/±Infinity, booleans, objects, and arrays.
 *
 * Note: `Number("")` is 0, so blank/whitespace strings are rejected explicitly
 * before coercion. Standard `Number()` semantics otherwise apply, so e.g.
 * "1e3" parses to 1000 and "0x10" parses to 16 — acceptable for this use.
 */
export function normalizeNumericValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Resolve the tolerance window for a NUMERIC answer. A positive, finite stored
 * tolerance (from the question) wins outright; otherwise fall back to the
 * larger of the absolute floor and a relative fraction of `|correct|`.
 */
export function numericTolerance(correct: number, stored?: number | null): number {
  if (typeof stored === "number" && Number.isFinite(stored) && stored > 0) {
    return stored;
  }
  return Math.max(NUMERIC_ABS_TOLERANCE_FLOOR, NUMERIC_REL_TOLERANCE * Math.abs(correct));
}

/**
 * Decide whether a submitted numeric `value` is correct for a NUMERIC question.
 * False when no value was submitted (null) or the question lacks a finite
 * `answerNumeric`; otherwise correct when `value` lies within the resolved
 * tolerance window (inclusive of the boundary).
 */
export function isNumericAnswerCorrect(question: ScorableQuestion, value: number | null): boolean {
  const correct = question.answerNumeric;
  if (value === null || typeof correct !== "number" || !Number.isFinite(correct)) {
    return false;
  }
  return Math.abs(value - correct) <= numericTolerance(correct, question.answerTolerance);
}

/**
 * Coerce a submitted answer's selection into a clean list of option-id strings.
 * Accepts either `selectedOptionIds` (array, multi-select) or a single
 * `selectedOptionId` (single-select). Non-string entries are discarded.
 */
export function normalizeSelectedOptionIds(answer: SubmittedAnswer): string[] {
  if (Array.isArray(answer.selectedOptionIds)) {
    return answer.selectedOptionIds.filter((id): id is string => typeof id === "string");
  }
  if (typeof answer.selectedOptionId === "string") {
    return [answer.selectedOptionId];
  }
  return [];
}

/**
 * Decide whether a selection is correct for a question.
 * - MULTI_SELECT: the selected set must equal the set of correct options
 *   exactly (no missing, no extra).
 * - SINGLE_SELECT: the first selected option must be a correct option.
 */
export function isAnswerCorrect(question: ScorableQuestion, selectedOptionIds: string[]): boolean {
  const selectedSet = new Set(selectedOptionIds);
  const correctOptionIds = question.options.flatMap((option) => (option.isCorrect ? [option.id] : []));

  if (question.answerMode === "MULTI_SELECT") {
    return (
      selectedSet.size === correctOptionIds.length &&
      correctOptionIds.every((id) => selectedSet.has(id))
    );
  }

  return question.options.some(
    (option) => option.id === selectedOptionIds[0] && option.isCorrect
  );
}

/**
 * Grade a full set of submitted answers against their questions.
 * `questionsById` must contain every answered question (the caller is
 * responsible for 404-ing on a missing question before calling this).
 */
export function scoreQuiz(params: {
  attemptId: string;
  questionsById: Map<string, ScorableQuestion>;
  answers: SubmittedAnswer[];
}): QuizScore {
  const { attemptId, questionsById, answers } = params;

  let correct = 0;
  const answerRecords: ScoredAnswerRecord[] = [];

  for (const answer of answers) {
    const question = questionsById.get(answer.questionId);
    if (!question) {
      throw new Error(`Question not found while scoring: ${answer.questionId}`);
    }

    if (question.answerMode === "NUMERIC") {
      const numericValue = normalizeNumericValue(answer.numericValue);
      const isCorrect = isNumericAnswerCorrect(question, numericValue);
      if (isCorrect) correct++;

      answerRecords.push({
        quizAttemptId: attemptId,
        questionId: answer.questionId,
        selectedOptionId: null,
        selectedOptionIds: [],
        numericValue,
        isCorrect,
      });
      continue;
    }

    const selectedOptionIds = normalizeSelectedOptionIds(answer);
    const isCorrect = isAnswerCorrect(question, selectedOptionIds);
    if (isCorrect) correct++;

    answerRecords.push({
      quizAttemptId: attemptId,
      questionId: answer.questionId,
      selectedOptionId:
        question.answerMode === "MULTI_SELECT" ? null : selectedOptionIds[0] ?? null,
      selectedOptionIds,
      numericValue: null,
      isCorrect,
    });
  }

  const total = answers.length;
  const score = total > 0 ? (correct / total) * 100 : 0;

  return { correct, total, score, answerRecords };
}
