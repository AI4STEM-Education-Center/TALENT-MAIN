import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, canRead, getContentActor } from "@/lib/quiz-access";

// GET: quiz detail with questions. Own quizzes are fully visible; pool quizzes
// are readable by any teacher/admin (so the pool can be previewed before import).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const [actor, { id }] = await Promise.all([getContentActor(), params]);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const quiz = await prisma.quiz.findUnique({
    where: { id },
    include: {
      topic: true,
      questions: { include: { options: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!quiz || !canRead(actor, quiz)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }
  return NextResponse.json({ ...quiz, editable: canManage(actor, quiz) });
}

// PATCH: rename / regroup a quiz (owner only)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const [actor, { id }, { name, topicId, order }] = await Promise.all([
    getContentActor(),
    params,
    req.json(),
  ]);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const quiz = await prisma.quiz.findUnique({ where: { id } });
  if (!quiz || !canManage(actor, quiz)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  if (topicId) {
    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic || topic.teacherId !== actor.teacherId) {
      return NextResponse.json({ error: "Topic not found." }, { status: 400 });
    }
  }

  const updated = await prisma.quiz.update({
    where: { id },
    data: {
      ...(name !== undefined && { name: name?.trim() }),
      // topicId: undefined = untouched, "" or null = ungroup, id = regroup
      ...(topicId !== undefined && { topicId: topicId || null }),
      ...(order !== undefined && { order }),
    },
    include: { topic: true, _count: { select: { questions: true } } },
  });
  return NextResponse.json(updated);
}

// DELETE: remove a quiz (owner only). Past attempts survive — QuizAttempt.quizId
// is SetNull and ExamResult is a relation-free snapshot.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const [actor, { id }] = await Promise.all([getContentActor(), params]);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const quiz = await prisma.quiz.findUnique({ where: { id } });
  if (!quiz || !canManage(actor, quiz)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  await prisma.quiz.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
