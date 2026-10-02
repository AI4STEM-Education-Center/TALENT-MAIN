import type { ContentActor } from "@/lib/quiz-access";

/** Admins manage every simulation; teachers manage only their own copies. */
export function canManageSimulation(
  actor: ContentActor,
  quiz: { teacherId: string | null },
): boolean {
  return actor.role === "ADMIN" || quiz.teacherId === actor.teacherId;
}
