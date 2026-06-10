import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getContentActor, ownScope } from "@/lib/quiz-access";

// GET: list the caller's quizzes (teacher → their own, admin → the global pool)
export async function GET() {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const quizzes = await prisma.quiz.findMany({
    where: { teacherId: ownScope(actor) },
    include: {
      topic: true,
      _count: { select: { questions: true } },
    },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(quizzes);
}

// POST: create a quiz in the caller's scope (optionally grouped under a topic)
export async function POST(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name, topicId, order } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "Quiz name required." }, { status: 400 });

  if (topicId) {
    const topic = await prisma.topic.findUnique({ where: { id: topicId } });
    if (!topic || topic.teacherId !== actor.teacherId) {
      return NextResponse.json({ error: "Topic not found." }, { status: 400 });
    }
  }

  const quiz = await prisma.quiz.create({
    data: {
      name: name.trim(),
      order: order ?? 0,
      topicId: topicId || null,
      teacherId: ownScope(actor),
    },
    include: { topic: true, _count: { select: { questions: true } } },
  });
  return NextResponse.json(quiz, { status: 201 });
}
