import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getContentReader } from "@/lib/quiz-access";
import { AdminQuizPoolClient } from "./quizzes-client";

export default async function AdminQuizPoolPage() {
  // Admins manage the pool; research scientists browse it read-only. Both
  // read the global pool scope (teacherId null).
  const actor = await getContentReader();
  if (!actor || (actor.role !== "ADMIN" && actor.role !== "RESEARCHER"))
    redirect("/login");
  const canEdit = actor.role === "ADMIN";

  const [pool, teacherOwned, topics] = await Promise.all([
    prisma.quiz.findMany({
      where: { teacherId: null },
      include: { topic: true, _count: { select: { questions: true } } },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    }),
    prisma.quiz.findMany({
      where: { teacherId: { not: null } },
      include: {
        topic: true,
        teacher: {
          include: {
            user: { select: { firstName: true, lastName: true, email: true } },
          },
        },
        _count: { select: { questions: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.topic.findMany({
      where: { teacherId: null, contentType: "QUIZ" },
      include: { _count: { select: { quizzes: true } } },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  // Flag which teacher quizzes already have a pool copy (depends on the ids above).
  const promoted = await prisma.quiz.findMany({
    where: {
      teacherId: null,
      sourceQuizId: { in: teacherOwned.map((q) => q.id) },
    },
    select: { sourceQuizId: true },
  });
  const promotedIds = new Set(promoted.map((q) => q.sourceQuizId));
  const teacherQuizzes = teacherOwned.map((q) => ({
    ...q,
    teacher: q.teacher!,
    alreadyPromoted: promotedIds.has(q.id),
  }));

  return (
    <AdminQuizPoolClient
      initialPool={pool}
      initialTeacherQuizzes={teacherQuizzes}
      initialTopics={topics}
      canEdit={canEdit}
    />
  );
}
