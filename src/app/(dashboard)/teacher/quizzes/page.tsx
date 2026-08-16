import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { getContentActor, ownScope } from "@/lib/quiz-access";
import { TeacherQuizzesClient } from "./quizzes-client";

export default async function TeacherQuizzesPage() {
  const actor = await getContentActor();
  if (!actor || actor.role !== "TEACHER") redirect("/login");

  const [quizzes, poolQuizzes, topics] = await Promise.all([
    prisma.quiz.findMany({
      where: { teacherId: ownScope(actor) },
      include: { topic: true, _count: { select: { questions: true } } },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    }),
    prisma.quiz.findMany({
      where: { teacherId: null },
      include: { topic: true, _count: { select: { questions: true } } },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    }),
    prisma.topic.findMany({
      where: { teacherId: ownScope(actor), contentType: "QUIZ" },
      include: { _count: { select: { quizzes: true } } },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  // Flag which pool quizzes this teacher already imported (depends on the pool ids above).
  const imported = await prisma.quiz.findMany({
    where: { teacherId: actor.teacherId, sourceQuizId: { in: poolQuizzes.map((q) => q.id) } },
    select: { sourceQuizId: true },
  });
  const importedSourceIds = new Set(imported.flatMap((q) => (q.sourceQuizId ? [q.sourceQuizId] : [])));
  const pool = poolQuizzes.map((q) => ({ ...q, alreadyImported: importedSourceIds.has(q.id) }));

  return <TeacherQuizzesClient initialQuizzes={quizzes} initialPool={pool} initialTopics={topics} />;
}
