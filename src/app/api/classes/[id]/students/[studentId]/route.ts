import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isValidEmail } from "@/lib/csv-roster";

// PATCH: Edit a roster entry's details (teacher only). The [studentId] slug
// carries a ClassStudentList roster-entry id (see the DELETE note below).
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; studentId: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, studentId: studentListId } = await params;
  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const cls = await prisma.class.findFirst({ where: { id, teacherId: teacher.id } });
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const entry = await prisma.classStudentList.findFirst({
    where: { id: studentListId, classId: id },
  });
  if (!entry) return NextResponse.json({ error: "Student not found in roster." }, { status: 404 });

  const { orgDefinedId, firstName, lastName, email } = await req.json();
  if (!orgDefinedId?.trim() || !firstName?.trim() || !lastName?.trim()) {
    return NextResponse.json({ error: "81 number, first name, and last name are required." }, { status: 400 });
  }
  if (!email?.trim() || !isValidEmail(email)) {
    return NextResponse.json({ error: "A valid email address is required." }, { status: 400 });
  }

  const cleanId = orgDefinedId.replace(/^#/, "").trim();

  // If the 81 number changed, ensure it doesn't collide with another roster entry.
  if (cleanId !== entry.orgDefinedId) {
    const dup = await prisma.classStudentList.findUnique({
      where: { classId_orgDefinedId: { classId: id, orgDefinedId: cleanId } },
    });
    if (dup) {
      return NextResponse.json({ error: "This 81 number is already in the class roster." }, { status: 409 });
    }
  }

  const updated = await prisma.classStudentList.update({
    where: { id: studentListId },
    data: {
      orgDefinedId: cleanId,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email: email.trim().toLowerCase(),
    },
  });

  return NextResponse.json(updated);
}

// DELETE: Remove a student from the class roster (teacher only).
// Note: the [studentId] slug here carries a ClassStudentList roster-entry id,
// not a Student id. The segment must share the slug name of the sibling
// `students/[studentId]/stats` route — Next.js disallows differing slug names
// at the same path level — so we alias it to `studentListId` internally.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; studentId: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id, studentId: studentListId } = await params;
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
