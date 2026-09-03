import { prisma } from "@/lib/prisma";

/**
 * The given teacher-user's class, but only if they own it. Returns null when
 * the user isn't a teacher or doesn't own the class. Used to gate class-scoped
 * teacher actions (read + mutate) on ownership.
 */
export async function getTeacherClass(userId: string, classId: string) {
  const teacher = await prisma.teacher.findUnique({ where: { userId } });
  if (!teacher) return null;
  return prisma.class.findFirst({
    where: { id: classId, teacherId: teacher.id },
  });
}

/**
 * Whether the session user may READ this class's quiz/curriculum data: the
 * owning teacher, or a student enrolled in it. Mirrors the enrollment check
 * used by the quiz-taking flow (src/app/api/quiz/route.ts). Returns false for
 * everyone else. Use this for class-scoped reads that enrolled students
 * legitimately need; for payloads that expose other students' PII or
 * invitation tokens, gate on getTeacherClass (owner-only) instead.
 */
export async function canReadClass(
  user: { id: string; role?: string | null },
  classId: string,
): Promise<boolean> {
  if (user.role === "TEACHER") {
    return (await getTeacherClass(user.id, classId)) !== null;
  }
  if (user.role === "STUDENT") {
    const student = await prisma.student.findUnique({
      where: { userId: user.id },
    });
    if (!student) return false;
    const enrollment = await prisma.classEnrollment.findUnique({
      where: { classId_studentId: { classId, studentId: student.id } },
    });
    return enrollment !== null;
  }
  return false;
}
