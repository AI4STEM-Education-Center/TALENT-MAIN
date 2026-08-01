import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor, ownScope } from "@/lib/quiz-access";

// Topics are optional grouping labels for quizzes, scoped like quizzes:
// teacher → their own labels, admin → the global pool's labels.

export async function GET() {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const topics = await prisma.topic.findMany({
    where: { teacherId: ownScope(actor) },
    include: { _count: { select: { quizzes: true, learningMaterials: true } } },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
  });
  return NextResponse.json(topics);
}

export async function POST(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { name, order } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "Topic name required." }, { status: 400 });

  const topic = await prisma.topic.create({
    data: { name: name.trim(), order: order ?? 0, teacherId: ownScope(actor) },
  });
  return NextResponse.json(topic, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id, name, order } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const topic = await prisma.topic.findUnique({ where: { id } });
  if (!topic || !canManage(actor, topic)) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  const updated = await prisma.topic.update({
    where: { id },
    data: { ...(name && { name: name.trim() }), ...(order !== undefined && { order }) },
  });
  return NextResponse.json(updated);
}

// DELETE: removes the label only — its quizzes are detached (topicId SetNull),
// never deleted.
export async function DELETE(req: NextRequest) {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const topic = await prisma.topic.findUnique({ where: { id } });
  if (!topic || !canManage(actor, topic)) {
    return NextResponse.json({ error: "Topic not found" }, { status: 404 });
  }

  await prisma.topic.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
