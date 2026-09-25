import type { Prisma } from "@prisma/client";

/**
 * Canonical display order for a quiz's questions: the teacher-set position,
 * then creation time. The createdAt tiebreak keeps quizzes that were never
 * reordered (every row at the default 0) in their original import order.
 */
export const QUESTION_ORDER = [
  { order: "asc" },
  { createdAt: "asc" },
] satisfies Prisma.QuestionOrderByWithRelationInput[];

type QuestionOrderClient = Pick<Prisma.TransactionClient, "question">;

/** The position a question appended to the end of `quizId` should take. */
export async function nextQuestionOrder(
  db: QuestionOrderClient,
  quizId: string,
): Promise<number> {
  const { _max } = await db.question.aggregate({
    where: { quizId },
    _max: { order: true },
  });
  return _max.order === null ? 0 : _max.order + 1;
}
