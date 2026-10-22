import type { ContentActor } from "./quiz-access";

/** Admin oversight includes variants of teacher quizzes; source editing stays owner-only. */
export function canManageQuizVariants(
  actor: ContentActor,
  quiz: { teacherId: string | null },
): boolean {
  return actor.role === "ADMIN" || quiz.teacherId === actor.teacherId;
}
