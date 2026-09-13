import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { deepCopyQuiz, getContentActor } from "@/lib/quiz-access";

// POST: import a global-pool quiz into the calling teacher's own quizzes.
// Deep copy — the teacher's copy is fully independent of the pool version.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [actor, { id }] = await Promise.all([getContentActor(), params]);
  if (!actor || actor.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const source = await prisma.quiz.findUnique({ where: { id } });
  if (!source || source.teacherId !== null) {
    return NextResponse.json(
      { error: "Quiz not found in the global pool" },
      { status: 404 },
    );
  }

  const copy = await deepCopyQuiz(id, actor.teacherId);
  return NextResponse.json(copy, { status: 201 });
}
