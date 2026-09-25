import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, deepCopyQuiz, getContentActor } from "@/lib/quiz-access";

// POST: duplicate a quiz the caller manages into the same scope — a teacher's
// own quiz stays private, an admin's pool quiz stays in the pool. Deep copy
// (questions, options, figures, settled simulations), so the duplicate can be
// edited or reordered independently without re-importing the source document.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [actor, { id }] = await Promise.all([getContentActor(), params]);
  if (!actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const source = await prisma.quiz.findUnique({ where: { id } });
  if (!source || !canManage(actor, source)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  const copy = await deepCopyQuiz(id, actor.teacherId, source.topicId, {
    name: `${source.name} (copy)`,
  });
  if (!copy)
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  return NextResponse.json(copy, { status: 201 });
}
