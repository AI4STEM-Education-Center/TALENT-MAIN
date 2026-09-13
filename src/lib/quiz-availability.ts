// Per-class quiz availability, as one pure decision.
//
// The gate has three independent parts — an open window, a close date, and an
// attempt cap — and they are read in three places that must agree: the student
// class page (which button to show), POST /api/quiz (the enforcement point), and
// the assistant's result-detail tool (whether the answer key may be revealed).
// A quiz the student can still attempt is one whose answers they must not see,
// so a drift between those readings is not cosmetic.

/** Per-class settings for one quiz. All fields null = always open, unlimited. */
export type QuizGateSettings = {
  availableFrom: Date | null;
  availableUntil: Date | null;
  /** Total completed attempts allowed. null or 0 = unlimited. */
  maxAttempts: number | null;
};

export type QuizGateState = {
  /** Completed attempts this student has already used. */
  completedAttempts: number;
  /** True when an attempt is started but not submitted — always resumable. */
  hasAttemptInProgress: boolean;
};

export type QuizAvailability = {
  notOpenYet: boolean;
  closed: boolean;
  attemptsExhausted: boolean;
  /** True when the student cannot start a NEW attempt right now. */
  locked: boolean;
};

export function quizAvailability(
  settings: QuizGateSettings,
  completedAttempts: number,
  now: Date = new Date()
): QuizAvailability {
  const notOpenYet = settings.availableFrom != null && now < settings.availableFrom;
  const closed = settings.availableUntil != null && now > settings.availableUntil;
  const attemptsExhausted =
    settings.maxAttempts != null &&
    settings.maxAttempts > 0 &&
    completedAttempts >= settings.maxAttempts;
  return {
    notOpenYet,
    closed,
    attemptsExhausted,
    locked: notOpenYet || closed || attemptsExhausted,
  };
}

/**
 * Could this student still submit another graded answer for the quiz?
 *
 * `settings` is null when the quiz is no longer offered to the class at all (the
 * ClassQuiz row was removed or unpublished) — nothing more can be submitted.
 *
 * An attempt already in progress counts as "yes" even when the cap is reached or
 * the window has closed: POST /api/quiz always resumes an unfinished attempt
 * rather than allocating a new one, so those answers can still be graded.
 * "Not open yet" also counts as yes — the window reopens, and treating a future
 * opening as final would hand out an answer key ahead of the quiz.
 */
export function canAttemptAgain(
  settings: QuizGateSettings | null,
  state: QuizGateState,
  now: Date = new Date()
): boolean {
  if (state.hasAttemptInProgress) return true;
  if (!settings) return false;
  const availability = quizAvailability(settings, state.completedAttempts, now);
  if (availability.notOpenYet) return true;
  return !availability.locked;
}
