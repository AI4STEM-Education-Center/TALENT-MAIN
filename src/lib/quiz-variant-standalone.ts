import type { Prisma } from "@prisma/client";
import type { VariantQuestion } from "./quiz-variants";

type SourceQuiz = {
  id: string;
  name: string;
  order: number;
  topicId: string | null;
  teacherId: string | null;
  questions: {
    id: string;
    title: string | null;
    difficultyLevel: string;
    points: number | null;
  }[];
};

/**
 * Create a separate exam from a verified alternative, in the source quiz's
 * scope and topic. Per-question metadata the variant does not carry (title,
 * difficulty, points) comes from the matching source question; the worked
 * solution becomes the general feedback. Lineage points back at the source.
 */
export async function createStandaloneQuiz(
  tx: Prisma.TransactionClient,
  source: SourceQuiz,
  questions: VariantQuestion[],
  name: string,
  createdById: string | null,
) {
  const sourceById = new Map(source.questions.map((q) => [q.id, q]));
  const quiz = await tx.quiz.create({
    data: {
      name,
      order: source.order,
      topicId: source.topicId,
      teacherId: source.teacherId,
      sourceQuizId: source.id,
    },
  });
  for (const [position, question] of questions.entries()) {
    const original = sourceById.get(question.sourceQuestionId);
    await tx.question.create({
      data: {
        quizId: quiz.id,
        title: original?.title ?? null,
        text: question.text,
        order: position,
        difficultyLevel: original?.difficultyLevel ?? "BEGINNER",
        answerMode: question.answerMode,
        points: original?.points ?? null,
        feedbackGeneral: question.solution,
        createdById,
        answerNumeric: question.answerNumeric,
        answerTolerance: question.answerTolerance,
        answerUnit: question.answerUnit,
        options: {
          create: question.options.map((o) => ({
            text: o.text,
            isCorrect: o.isCorrect,
          })),
        },
      },
    });
  }
  return quiz;
}
