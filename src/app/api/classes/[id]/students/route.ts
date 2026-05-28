import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET: Return all ClassStudentList entries for this class with enrollment status (teacher only)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  // Verify the teacher owns this class
  const cls = await prisma.class.findFirst({
    where: { id, teacherId: teacher.id },
  });
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const [students, enrollments] = await Promise.all([
    prisma.classStudentList.findMany({
      where: { classId: id },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    }),
    // Cross-reference with enrollments to get enrollment status
    prisma.classEnrollment.findMany({
      where: { classId: id },
      include: { student: { include: { user: true } } },
    }),
  ]);

  // Build a lookup map: orgDefinedId -> enrollment info
  // Match roster entries to enrollments by looking up users who registered with matching names
  const enrollmentByName = new Map<string, { enrolledAt: Date }>();
  for (const e of enrollments) {
    const key = `${e.student.user.firstName.toLowerCase()}|${e.student.user.lastName.toLowerCase()}`;
    enrollmentByName.set(key, { enrolledAt: e.joinedAt });
  }

  const studentsWithStatus = students.map((s) => {
    const key = `${s.firstName.toLowerCase()}|${s.lastName.toLowerCase()}`;
    const enrollment = enrollmentByName.get(key);
    return {
      ...s,
      isEnrolled: !!enrollment,
      enrolledAt: enrollment?.enrolledAt ?? null,
    };
  });

  return NextResponse.json(studentsWithStatus);
}

// POST: Manually add a student to the class roster (teacher only)
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const cls = await prisma.class.findFirst({
    where: { id, teacherId: teacher.id },
  });
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const { orgDefinedId, firstName, lastName } = await req.json();

  if (!orgDefinedId?.trim() || !firstName?.trim() || !lastName?.trim()) {
    return NextResponse.json({ error: "81 number, first name, and last name are required." }, { status: 400 });
  }

  const cleanId = orgDefinedId.replace(/^#/, "").trim();

  // Check for duplicate
  const existing = await prisma.classStudentList.findUnique({
    where: { classId_orgDefinedId: { classId: id, orgDefinedId: cleanId } },
  });
  if (existing) {
    return NextResponse.json({ error: "This 81 number is already in the class roster." }, { status: 409 });
  }

  const entry = await prisma.classStudentList.create({
    data: {
      classId: id,
      orgDefinedId: cleanId,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
    },
  });

  return NextResponse.json(entry, { status: 201 });
}
