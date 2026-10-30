// Shared by every student-facing surface that must decide whether the answer
// key may be revealed (the assistant's result lookup and the wrong-answer coach).
import { prisma } from "@/lib/prisma";
import { canAttemptAgain } from "@/lib/quiz-availability";
import { GRADED_ATTEMPTS } from "@/lib/alternative-retake";

/**
 * Can this student still submit another graded answer for the quiz an archived
 * result belongs to? This is what decides whether the tool may show the answer
 * key, so it errs toward "yes" (withhold) in every ambiguous case.
 */
export async function retakeStillPossible(
  studentId: string,
  classId: string,
  quizId: string,
): Promise<boolean> {
  const [classQuiz, completedAttempts, inProgress] = await Promise.all([
    prisma.classQuiz.findUnique({
      where: { classId_quizId: { classId, quizId } },
      select: {
        published: true,
        availableFrom: true,
        availableUntil: true,
        maxAttempts: true,
      },
    }),
    prisma.quizAttempt.count({
      where: {
        studentId,
        classId,
        quizId,
        completedAt: { not: null },
        ...GRADED_ATTEMPTS,
      },
    }),
    prisma.quizAttempt.count({
      where: {
        studentId,
        classId,
        quizId,
        completedAt: null,
        ...GRADED_ATTEMPTS,
      },
    }),
  ]);

  // No ClassQuiz row: the quiz was removed from the class (or deleted outright),
  // so nothing further can be submitted and the attempt is final.
  if (!classQuiz) return false;
  // Unpublished is a teacher hiding a quiz, not retiring it — one click brings it
  // back, so treat the attempt as still open.
  if (!classQuiz.published) return true;

  return canAttemptAgain(
    {
      availableFrom: classQuiz.availableFrom,
      availableUntil: classQuiz.availableUntil,
      maxAttempts: classQuiz.maxAttempts,
    },
    { completedAttempts, hasAttemptInProgress: inProgress > 0 },
  );
}
