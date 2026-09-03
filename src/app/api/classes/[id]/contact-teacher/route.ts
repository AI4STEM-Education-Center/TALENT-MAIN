import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail, SmtpNotConfiguredError } from "@/lib/email";
import { logApiError } from "@/lib/system-log";

// POST: an enrolled student sends a message to their class teacher
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
    include: { user: true },
  });
  if (!student)
    return NextResponse.json({ error: "Student not found" }, { status: 404 });

  // Verify the student is enrolled in this class.
  const enrollment = await prisma.classEnrollment.findUnique({
    where: { classId_studentId: { classId: id, studentId: student.id } },
  });
  if (!enrollment)
    return NextResponse.json(
      { error: "Not enrolled in this class." },
      { status: 403 },
    );

  const cls = await prisma.class.findUnique({
    where: { id },
    include: { teacher: { include: { user: true } } },
  });
  if (!cls)
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const { subject, body } = await req.json();
  if (!subject?.trim() || !body?.trim()) {
    return NextResponse.json(
      { error: "Subject and message body are required." },
      { status: 400 },
    );
  }

  const teacherEmail = cls.teacher.user.email;
  const studentName =
    `${student.user.firstName} ${student.user.lastName}`.trim();
  const text =
    `${body.trim()}\n\n` +
    `— ${studentName}\n` +
    `Student email: ${student.user.email}\n` +
    `Class: ${cls.name}`;

  try {
    const result = await sendEmail({
      to: [teacherEmail],
      subject: `[${cls.name}] ${subject.trim()}`,
      text,
      purpose: "CONTACT_TEACHER",
      replyTo: student.user.email,
    });

    const status = result.sent > 0 ? "SENT" : "FAILED";

    const message = await prisma.message.create({
      data: {
        classId: id,
        direction: "STUDENT_TO_TEACHER",
        senderUserId: student.userId,
        subject: subject.trim(),
        body: body.trim(),
        recipientCount: 1,
        sentCount: result.sent,
        status,
        error: result.errors.length > 0 ? result.errors.join("; ") : null,
      },
    });

    if (status === "FAILED") {
      return NextResponse.json(
        { error: "Failed to deliver your message. Please try again later." },
        { status: 502 },
      );
    }

    return NextResponse.json({ message, status }, { status: 201 });
  } catch (error) {
    if (error instanceof SmtpNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    logApiError("CONTACT_TEACHER_POST", error);
    return NextResponse.json(
      { error: "Failed to send message." },
      { status: 500 },
    );
  }
}
