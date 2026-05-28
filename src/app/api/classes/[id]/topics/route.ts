import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET: list topics assigned to this class (with published status)
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const classTopics = await prisma.classTopic.findMany({
    where: { classId: id },
    include: {
      topic: {
        include: {
          subtopics: { orderBy: { order: "asc" } },
          _count: { select: { questions: true } },
        },
      },
    },
    orderBy: { topic: { order: "asc" } },
  });

  return NextResponse.json(classTopics);
}

// POST: assign a topic to a class
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { topicId } = await req.json();
  if (!topicId) return NextResponse.json({ error: "topicId required" }, { status: 400 });
  const { id } = await params;

  try {
    const ct = await prisma.classTopic.create({
      data: { classId: id, topicId, published: false },
      include: { topic: true },
    });
    return NextResponse.json(ct, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Topic already assigned to this class." }, { status: 409 });
  }
}

// PATCH: toggle published or remove a topic from a class
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { topicId, published } = await req.json();
  if (!topicId) return NextResponse.json({ error: "topicId required" }, { status: 400 });
  const { id } = await params;

  const ct = await prisma.classTopic.updateMany({
    where: { classId: id, topicId },
    data: { published: Boolean(published) },
  });

  return NextResponse.json(ct);
}

// DELETE: remove topic from class
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { topicId } = await req.json();
  const { id } = await params;
  await prisma.classTopic.deleteMany({ where: { classId: id, topicId } });
  return NextResponse.json({ success: true });
}
