import { prisma } from "@/lib/prisma";

/**
 * May this student practice alternative versions of this quiz right now?
 * Enrollment, a published assignment and an open availability window are all
 * required — the same rule for the practice routes and the coach's offer of an
 * alternative question, so neither can hand out what the other would refuse.
 * (Submitting already-started work later is checked separately by the practice
 * route: it only needs enrollment.)
 */
export async function studentCanPractice(
  studentId: string,
  classId: string,
  quizId: string,
): Promise<boolean> {
  const [enrollment, assignment] = await Promise.all([
    prisma.classEnrollment.findUnique({
      where: { classId_studentId: { classId, studentId } },
    }),
    prisma.classQuiz.findUnique({
      where: { classId_quizId: { classId, quizId } },
    }),
  ]);
  if (!enrollment || !assignment?.published) return false;
  const now = new Date();
  return (
    !(assignment.availableFrom && now < assignment.availableFrom) &&
    !(assignment.availableUntil && now > assignment.availableUntil)
  );
}
