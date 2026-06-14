import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import { getContentActor, ownScope } from "@/lib/quiz-access";
import { ClassQuizzesClient } from "./quizzes-client";

export default async function ClassQuizzesPage({ params }: { params: Promise<{ id: string }> }) {
  // params and the actor lookup are independent, so race them.
  const [{ id: classId }, actor] = await Promise.all([params, getContentActor()]);
  if (!actor || actor.role !== "TEACHER") redirect("/login");

  // Only the owning teacher can manage this class's quizzes.
  const cls = await prisma.class.findFirst({ where: { id: classId, teacherId: actor.teacherId } });
  if (!cls) notFound();

  const [classQuizzes, allQuizzes] = await Promise.all([
    prisma.classQuiz.findMany({
      where: { classId },
      include: { quiz: { include: { topic: true, _count: { select: { questions: true } } } } },
      orderBy: [{ quiz: { order: "asc" } }, { quiz: { createdAt: "asc" } }],
    }),
    prisma.quiz.findMany({
      where: { teacherId: ownScope(actor) },
      include: { topic: true, _count: { select: { questions: true } } },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    }),
  ]);

  return (
    <ClassQuizzesClient
      classId={classId}
      initialClassQuizzes={classQuizzes}
      initialAllQuizzes={allQuizzes}
    />
  );
}
