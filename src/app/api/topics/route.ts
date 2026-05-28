import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const topics = await prisma.topic.findMany({
    include: {
      subtopics: { orderBy: { order: "asc" } },
      _count: { select: { questions: true } },
    },
    orderBy: { order: "asc" },
  });
  return NextResponse.json(topics);
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  const { name, order } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "Topic name required." }, { status: 400 });

  const topic = await prisma.topic.create({
    data: { name: name.trim(), order: order ?? 0, createdById: teacher?.id },
  });
  return NextResponse.json(topic, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, name, order } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const topic = await prisma.topic.update({
    where: { id },
    data: { ...(name && { name: name.trim() }), ...(order !== undefined && { order }) },
  });
  return NextResponse.json(topic);
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  await prisma.topic.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
