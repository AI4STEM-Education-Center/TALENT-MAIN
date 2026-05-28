import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const subtopics = await prisma.subtopic.findMany({
    where: { topicId: id },
    include: { _count: { select: { questions: true } } },
    orderBy: { order: "asc" },
  });
  return NextResponse.json(subtopics);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  const { name, order } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "Subtopic name required." }, { status: 400 });
  const { id } = await params;

  const subtopic = await prisma.subtopic.create({
    data: { name: name.trim(), order: order ?? 0, topicId: id, createdById: teacher?.id },
  });
  return NextResponse.json(subtopic, { status: 201 });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { subtopicId, name, order } = await req.json();
  const { id } = await params;
  const updated = await prisma.subtopic.update({
    where: { id: subtopicId, topicId: id },
    data: { name: name?.trim(), order },
  });
  return NextResponse.json(updated);
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { subtopicId } = await req.json();
  const { id } = await params;
  await prisma.subtopic.delete({ where: { id: subtopicId, topicId: id } });
  return NextResponse.json({ success: true });
}
