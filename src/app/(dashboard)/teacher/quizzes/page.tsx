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

  // Flag which pool quizzes this teacher already imported, and which own
  // quizzes have generated versions waiting for approval (both depend on the
  // quiz ids above).
  const [imported, pendingVersions] = await Promise.all([
    prisma.quiz.findMany({
      where: {
        teacherId: actor.teacherId,
        sourceQuizId: { in: poolQuizzes.map((q) => q.id) },
      },
      select: { sourceQuizId: true },
    }),
    prisma.quizPracticeVersion.findMany({
      where: { quizId: { in: quizzes.map((q) => q.id) }, status: "REVIEW" },
      select: { quizId: true, batchId: true },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  // Newest first, so the first batch seen per quiz is its latest round.
  const pending = new Map<string, { count: number; batchId: string | null }>();
  for (const v of pendingVersions) {
    const entry = pending.get(v.quizId);
    if (entry) {
      entry.count += 1;
      entry.batchId ??= v.batchId;
    } else pending.set(v.quizId, { count: 1, batchId: v.batchId });
  }
  const ownQuizzes = quizzes.map((q) => ({
    ...q,
    pendingVariantCount: pending.get(q.id)?.count ?? 0,
    pendingBatchId: pending.get(q.id)?.batchId ?? null,
  }));
  const importedSourceIds = new Set(
    imported.flatMap((q) => (q.sourceQuizId ? [q.sourceQuizId] : [])),
  );
  const pool = poolQuizzes.map((q) => ({
    ...q,
    alreadyImported: importedSourceIds.has(q.id),
  }));

  return (
    <TeacherQuizzesClient
      initialQuizzes={ownQuizzes}
      initialPool={pool}
      initialTopics={topics}
    />
  );
}
