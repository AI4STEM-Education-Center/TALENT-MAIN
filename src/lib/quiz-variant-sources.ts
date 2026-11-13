import { prisma } from "@/lib/prisma";
import { getContentActor } from "@/lib/quiz-access";
import { canManageQuizVariants } from "@/lib/quiz-variant-access";
import { QUESTION_ORDER } from "@/lib/question-order";
import { validateVariant, type VariantQuestion } from "@/lib/quiz-variants";

/**
 * Shared by the alternative-version API routes: load a quiz the current actor
 * may manage, check it can be varied, and snapshot its questions as sources.
 * (Route modules may only export handlers, so these live here.)
 */

export type VariantRouteContext = { params: Promise<{ id: string }> };

export async function managedVariantQuiz(context: VariantRouteContext) {
  const [actor, { id }] = await Promise.all([
    getContentActor(),
    context.params,
  ]);
  if (!actor) return null;
  const quiz = await prisma.quiz.findUnique({
    where: { id },
    include: {
      questions: { include: { options: true }, orderBy: QUESTION_ORDER },
    },
  });
  return quiz && canManageQuizVariants(actor, quiz)
    ? Object.assign(quiz, { actor })
    : null;
}

export type ManagedVariantQuiz = NonNullable<
  Awaited<ReturnType<typeof managedVariantQuiz>>
>;
type QuizQuestion = ManagedVariantQuiz["questions"][number];

export const UNSUPPORTED_QUIZ_ERROR =
  "Practice generation currently supports 1–40 text-only single-select or numeric questions. Remove image-dependent and multi-select questions from this quiz first.";
export const INVALID_KEYS_ERROR =
  "Fix missing or invalid source answer keys before generating alternatives.";

/** Null when the quiz's question set can be varied, else the reason. */
export function variantSupportError(quiz: {
  questions: QuizQuestion[];
}): string | null {
  if (
    !quiz.questions.length ||
    quiz.questions.length > 40 ||
    quiz.questions.some(
      (q) =>
        !["SINGLE_SELECT", "NUMERIC"].includes(q.answerMode) ||
        q.figureStorageKey ||
        q.options.some((o) => o.imageStorageKey),
    )
  )
    return UNSUPPORTED_QUIZ_ERROR;
  return null;
}

/** Assessment content only: student data is never sent to generation. */
export function sourceFromQuestion(
  q: QuizQuestion,
  objective: string,
): VariantQuestion {
  return {
    id: q.id,
    sourceQuestionId: q.id,
    text: q.text,
    answerMode: q.answerMode as VariantQuestion["answerMode"],
    answerUnit: q.answerUnit,
    answerNumeric: q.answerNumeric,
    answerTolerance: q.answerTolerance,
    options: q.options.map((o) => ({
      id: o.id,
      text: o.text,
      isCorrect: o.isCorrect,
    })),
    solution: q.feedbackGeneral || "Source answer key",
    intentExplanation: objective,
  };
}

/** True when the sources validate as a well-formed, fully keyed quiz. */
export function sourcesHaveValidKeys(sources: VariantQuestion[]): boolean {
  try {
    validateVariant({ questions: sources }, sources);
    return true;
  } catch {
    return false;
  }
}

function fingerprint(q: {
  id: string;
  text: string;
  answerMode: string;
  answerUnit: string | null;
  answerNumeric: number | null;
  answerTolerance: number | null;
  options: { id: string; text: string; isCorrect: boolean }[];
}) {
  return JSON.stringify([
    q.id,
    q.text.trim(),
    q.answerMode,
    q.answerUnit ?? null,
    q.answerNumeric ?? null,
    q.answerTolerance ?? null,
    [...q.options]
      .map((o) => [o.id, o.text.trim(), o.isCorrect])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  ]);
}

/**
 * Whether a draft's sourceSnapshot still describes the quiz as it is now
 * (same questions, wording, answer formats and keys). Publishing a draft
 * generated from an older quiz would grade students against stale content.
 */
export function snapshotMatchesQuiz(
  sourceSnapshot: string,
  quiz: { questions: QuizQuestion[] },
): boolean {
  let snapshot: VariantQuestion[];
  try {
    snapshot = JSON.parse(sourceSnapshot);
  } catch {
    return false;
  }
  if (!Array.isArray(snapshot) || snapshot.length !== quiz.questions.length)
    return false;
  const current = new Map(
    quiz.questions.map((q) => [q.id, fingerprint(sourceFromQuestion(q, ""))]),
  );
  return snapshot.every((s) => current.get(s.id) === fingerprint(s));
}

/**
 * Whether every question of a draft still maps onto a current quiz question
 * with the same answer format (questions were not deleted or retyped).
 */
export function questionsStillMatchQuiz(
  questions: string,
  quiz: { questions: QuizQuestion[] },
): boolean {
  let parsed: VariantQuestion[];
  try {
    parsed = JSON.parse(questions);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || !parsed.length) return false;
  const modes = new Map(quiz.questions.map((q) => [q.id, q.answerMode]));
  return parsed.every((q) => modes.get(q.sourceQuestionId) === q.answerMode);
}
