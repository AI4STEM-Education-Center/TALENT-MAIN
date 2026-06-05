// Pure quiz-scoring logic, extracted from the quiz route so the
// correctness-critical grading rules can be unit-tested without a database.

export type ScorableOption = { id: string; isCorrect: boolean };

export type ScorableQuestion = {
  id: string;
  answerMode: string; // "SINGLE_SELECT" | "MULTI_SELECT"
  options: ScorableOption[];
};

/** A raw, untrusted answer as posted by the client. */
export type SubmittedAnswer = {
  questionId: string;
  selectedOptionId?: unknown;
  selectedOptionIds?: unknown;
};

export type ScoredAnswerRecord = {
  quizAttemptId: string;
  questionId: string;
  selectedOptionId: string | null;
  selectedOptionIds: string[];
  isCorrect: boolean;
};

export type QuizScore = {
  correct: number;
  total: number;
  score: number; // percentage 0–100
  answerRecords: ScoredAnswerRecord[];
};

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

    const selectedOptionIds = normalizeSelectedOptionIds(answer);
    const isCorrect = isAnswerCorrect(question, selectedOptionIds);
    if (isCorrect) correct++;

    answerRecords.push({
      quizAttemptId: attemptId,
      questionId: answer.questionId,
      selectedOptionId:
        question.answerMode === "MULTI_SELECT" ? null : selectedOptionIds[0] ?? null,
      selectedOptionIds,
      isCorrect,
    });
  }

  const total = answers.length;
  const score = total > 0 ? (correct / total) * 100 : 0;

  return { correct, total, score, answerRecords };
}
