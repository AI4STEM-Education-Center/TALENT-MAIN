import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
    if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

    const classes = await prisma.class.findMany({
      where: { teacherId: teacher.id },
      include: {
        _count: { select: { enrollments: true, classTopics: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(classes);
  }

  // Student: return enrolled classes
  const student = await prisma.student.findUnique({ where: { userId: session.user.id } });
  if (!student) return NextResponse.json({ error: "Student not found" }, { status: 404 });

  const enrollments = await prisma.classEnrollment.findMany({
    where: { studentId: student.id },
    include: {
      class: {
        include: { _count: { select: { enrollments: true, classTopics: true } } },
      },
    },
    orderBy: { joinedAt: "desc" },
  });
  return NextResponse.json(enrollments.map((e) => e.class));
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const { name, description } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "Class name is required." }, { status: 400 });

  const cls = await prisma.class.create({
    data: { name: name.trim(), description: description?.trim() || null, teacherId: teacher.id },
  });
  return NextResponse.json(cls, { status: 201 });
}
