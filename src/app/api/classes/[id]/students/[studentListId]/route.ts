import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// DELETE: Remove a student from the class roster (teacher only)
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; studentListId: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, studentListId } = await params;
  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  // Verify the teacher owns this class
  const cls = await prisma.class.findFirst({
    where: { id, teacherId: teacher.id },
  });
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  // Find the roster entry
  const entry = await prisma.classStudentList.findFirst({
    where: { id: studentListId, classId: id },
  });
  if (!entry) {
    return NextResponse.json({ error: "Student not found in roster." }, { status: 404 });
  }

  // If the student was registered, also remove their enrollment
  if (entry.isRegistered) {
    // Find the user with this orgDefinedId who is a student
    // We look up by matching the orgDefinedId in any ClassStudentList for this class
    // The enrollment is tied to the studentId, so we need to find the student
    const allEnrollments = await prisma.classEnrollment.findMany({
      where: { classId: id },
      include: { student: { include: { user: true } } },
    });

    // Find the enrollment for the student matching this roster entry's name
    const matchingEnrollment = allEnrollments.find(
      (e) =>
        e.student.user.firstName === entry.firstName &&
        e.student.user.lastName === entry.lastName
    );

    if (matchingEnrollment) {
      await prisma.classEnrollment.delete({
        where: { id: matchingEnrollment.id },
      });
    }
  }

  // Delete the roster entry
  await prisma.classStudentList.delete({
    where: { id: studentListId },
  });

  return NextResponse.json({ success: true });
}
