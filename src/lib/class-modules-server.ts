import { prisma } from "@/lib/prisma";
import type { ModuleLayout } from "@/lib/class-modules";

export async function getClassModules(classId: string): Promise<ModuleLayout> {
  // Read revision and membership in the same snapshot.
  return prisma.$transaction(async (tx) => {
    const cls = await tx.class.findUniqueOrThrow({
      where: { id: classId },
      select: {
        modulesRevision: true,
        modules: {
          orderBy: { position: "asc" },
          include: {
            quizzes: {
              orderBy: { position: "asc" },
              include: { classQuiz: { select: { quizId: true } } },
            },
          },
        },
      },
    });
    return {
      revision: cls.modulesRevision,
      modules: cls.modules.map((module) => ({
        id: module.id,
        name: module.name,
        description: module.description,
        quizIds: module.quizzes.map((item) => item.classQuiz.quizId),
      })),
    };
  });
}
