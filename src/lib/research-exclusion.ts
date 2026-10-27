import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** Empty membership never grants an exemption; mixed membership still prompts. */
export function allClassesResearchExcluded(
  role: string,
  classes: ReadonlyArray<{ researchExcluded: boolean }>,
): boolean {
  return (
    (role === "STUDENT" || role === "TEACHER") &&
    classes.length > 0 &&
    classes.every((c) => c.researchExcluded)
  );
}

export async function isResearchExempt(
  userId: string,
  role: string,
): Promise<boolean> {
  if (role === "STUDENT") {
    const enrollments = await prisma.classEnrollment.findMany({
      where: { student: { userId } },
      select: { class: { select: { researchExcluded: true } } },
    });
    return allClassesResearchExcluded(
      role,
      enrollments.map((e) => e.class),
    );
  }
  if (role === "TEACHER") {
    const classes = await prisma.class.findMany({
      where: { teacher: { userId } },
      select: { researchExcluded: true },
    });
    return allClassesResearchExcluded(role, classes);
  }
  return false;
}

/** The complement of exemption, for batched prompt audiences (no per-user queries). */
export function researchParticipantWhere(
  role: "STUDENT" | "TEACHER",
): Prisma.UserWhereInput {
  return role === "STUDENT"
    ? {
        role,
        NOT: {
          student: {
            enrollments: {
              some: {},
              every: { class: { researchExcluded: true } },
            },
          },
        },
      }
    : {
        role,
        NOT: {
          teacher: { classes: { some: {}, every: { researchExcluded: true } } },
        },
      };
}
