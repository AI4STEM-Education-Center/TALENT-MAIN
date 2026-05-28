import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function getTeacherClass(userId: string, classId: string) {
  const teacher = await prisma.teacher.findUnique({ where: { userId } });
  if (!teacher) return null;
  return prisma.class.findFirst({ where: { id: classId, teacherId: teacher.id } });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;

  const cls = await prisma.class.findUnique({
    where: { id },
    include: {
      teacher: { include: { user: true } },
      enrollments: { include: { student: { include: { user: true } } }, orderBy: { joinedAt: "desc" } },
      classTopics: { include: { topic: { include: { subtopics: { orderBy: { order: "asc" } } } } }, orderBy: { topic: { order: "asc" } } },
      invitations: { where: { active: true }, orderBy: { createdAt: "desc" } },
      _count: { select: { enrollments: true } },
    },
  });

  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  return NextResponse.json(cls);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const cls = await getTeacherClass(session.user.id, id);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const { name, description } = await req.json();
  const updated = await prisma.class.update({
    where: { id },
    data: { name: name?.trim() || cls.name, description: description?.trim() ?? cls.description },
  });
  return NextResponse.json(updated);
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;

  const cls = await getTeacherClass(session.user.id, id);
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  await prisma.class.delete({ where: { id } });
  return NextResponse.json({ success: true });
}
