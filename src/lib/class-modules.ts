import { z } from "zod";

export const moduleSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(1000),
  quizIds: z.array(z.string().min(1).max(100)).max(500),
});

export const moduleLayoutSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    modules: z.array(moduleSchema).max(100),
  })
  .superRefine(({ modules }, ctx) => {
    if (
      new Set(modules.map((m) => m.id)).size !== modules.length ||
      modules.some((m) => new Set(m.quizIds).size !== m.quizIds.length)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Duplicate module or quiz membership.",
      });
    }
  });

export type QuizModule = z.infer<typeof moduleSchema>;
export type ModuleLayout = z.infer<typeof moduleLayoutSchema>;

/** A move only removes memberships from the source section. Other reuse stays intact. */
export function moveModuleQuizzes(
  modules: QuizModule[],
  quizIds: string[],
  sourceId: string | null,
  targetId: string | null,
  beforeQuizId?: string,
): QuizModule[] {
  const moving = new Set(quizIds);
  return modules.map((module) => {
    if (module.id !== sourceId && module.id !== targetId) return module;
    const remaining = module.quizIds.filter((id) => !moving.has(id));
    if (module.id !== targetId) return { ...module, quizIds: remaining };
    const index = beforeQuizId ? remaining.indexOf(beforeQuizId) : -1;
    remaining.splice(index < 0 ? remaining.length : index, 0, ...quizIds);
    return { ...module, quizIds: remaining };
  });
}

/** Modules use published assignments only; empty sections are invisible to students. */
export function groupModuleQuizzes<T extends { id: string }>(
  modules: QuizModule[],
  quizzes: T[],
) {
  const byId = new Map(quizzes.map((quiz) => [quiz.id, quiz]));
  const groupedIds = new Set<string>();
  const groups = modules.flatMap((module) => {
    const items = module.quizIds.flatMap((id) => {
      const quiz = byId.get(id);
      if (!quiz) return [];
      groupedIds.add(id);
      return [quiz];
    });
    return items.length
      ? [
          {
            id: `module:${module.id}`,
            name: module.name,
            description: module.description,
            quizzes: items,
          },
        ]
      : [];
  });
  const other = quizzes.filter((quiz) => !groupedIds.has(quiz.id));
  if (other.length)
    groups.push({
      id: "other",
      name: "Other quizzes",
      description: "",
      quizzes: other,
    });
  return groups;
}
