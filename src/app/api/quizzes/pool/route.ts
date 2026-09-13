import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getContentActor } from "@/lib/quiz-access";

// GET: browse the global quiz pool (teachers and admins)
export async function GET() {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const quizzes = await prisma.quiz.findMany({
    where: { teacherId: null },
    include: {
      topic: true,
      _count: { select: { questions: true } },
    },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });

  // Tell the teacher which pool quizzes they already imported.
  let importedSourceIds: string[] = [];
  if (actor.role === "TEACHER") {
    const imported = await prisma.quiz.findMany({
      where: { teacherId: actor.teacherId, sourceQuizId: { in: quizzes.map((q) => q.id) } },
      select: { sourceQuizId: true },
    });
    importedSourceIds = imported.flatMap((q) => (q.sourceQuizId ? [q.sourceQuizId] : []));
  }

  return NextResponse.json(
    quizzes.map((q) => ({ ...q, alreadyImported: importedSourceIds.includes(q.id) }))
  );
}
