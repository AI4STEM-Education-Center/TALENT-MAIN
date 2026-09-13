import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValidEmail, normalizeEmail } from "@/lib/csv-roster";

export async function GET() {
  const session = await auth();
  if (!session?.user)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({
      where: { userId: session.user.id },
    });
    if (!teacher)
      return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

    const classes = await prisma.class.findMany({
      where: { teacherId: teacher.id },
      include: {
        _count: { select: { enrollments: true, classQuizzes: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json(classes);
  }

  // Student: return enrolled classes
  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
  });
  if (!student)
    return NextResponse.json({ error: "Student not found" }, { status: 404 });

  const enrollments = await prisma.classEnrollment.findMany({
    where: { studentId: student.id },
    include: {
      class: {
        include: {
          _count: { select: { enrollments: true, classQuizzes: true } },
        },
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

  const teacher = await prisma.teacher.findUnique({
    where: { userId: session.user.id },
  });
  if (!teacher)
    return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const { name, description, studentList } = await req.json();
  if (!name?.trim())
    return NextResponse.json(
      { error: "Class name is required." },
      { status: 400 },
    );

  // studentList is expected: [{ orgDefinedId, firstName, lastName, email }]
  // Email is required so teachers can send notifications to students.
  const students: {
    orgDefinedId: string;
    firstName: string;
    lastName: string;
    email: string;
  }[] = Array.isArray(studentList) ? studentList : [];

  // Validate every roster entry has a usable email before creating anything.
  const invalid = students.find(
    (s) => !s?.email || typeof s.email !== "string" || !isValidEmail(s.email),
  );
  if (invalid) {
    return NextResponse.json(
      { error: "Every student on the roster must have a valid email address." },
      { status: 400 },
    );
  }

  const result = await prisma.$transaction(async (tx) => {
    const cls = await tx.class.create({
      data: {
        name: name.trim(),
        description: description?.trim() || null,
        teacherId: teacher.id,
      },
    });

    if (students.length > 0) {
      await tx.classStudentList.createMany({
        data: students.map((s) => ({
          classId: cls.id,
          orgDefinedId: s.orgDefinedId.replace(/^#/, "").trim(),
          firstName: s.firstName.trim(),
          lastName: s.lastName.trim(),
          email: normalizeEmail(s.email),
        })),
      });
    }

    return cls;
  });

  return NextResponse.json(result, { status: 201 });
}
