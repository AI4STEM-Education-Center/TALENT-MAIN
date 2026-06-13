import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail, SmtpNotConfiguredError } from "@/lib/email";
import { isValidEmail } from "@/lib/csv-roster";

// GET: list messages for this class (teacher only)
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

  const cls = await prisma.class.findFirst({ where: { id, teacherId: teacher.id } });
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const messages = await prisma.message.findMany({
    where: { classId: id },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { sender: { select: { firstName: true, lastName: true, role: true } } },
  });

  return NextResponse.json(messages);
}

// POST: teacher broadcasts an email to students on the class roster
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const teacher = await prisma.teacher.findUnique({
    where: { userId: session.user.id },
    include: { user: true },
  });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const cls = await prisma.class.findFirst({ where: { id, teacherId: teacher.id } });
  if (!cls) return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const { subject, body, recipientIds } = await req.json();
  if (!subject?.trim() || !body?.trim()) {
    return NextResponse.json({ error: "Subject and message body are required." }, { status: 400 });
  }

  // Gather recipients from the roster. If recipientIds is provided, restrict to those.
  const roster = await prisma.classStudentList.findMany({
    where: {
      classId: id,
      ...(Array.isArray(recipientIds) && recipientIds.length > 0
        ? { id: { in: recipientIds } }
        : {}),
    },
  });

  const recipients = roster
    .map((s) => s.email)
    .filter((e): e is string => !!e && isValidEmail(e));

  if (recipients.length === 0) {
    return NextResponse.json(
      { error: "No roster students with a valid email address were found." },
      { status: 400 }
    );
  }

  const teacherName = `${teacher.user.firstName} ${teacher.user.lastName}`.trim();
  const text = `${body.trim()}\n\n— ${teacherName} (${cls.name})`;

  try {
    const result = await sendEmail({
      to: recipients,
      subject: subject.trim(),
      text,
      replyTo: teacher.user.email,
    });

    const status = result.failed === 0 ? "SENT" : result.sent === 0 ? "FAILED" : "PARTIAL";

    const message = await prisma.message.create({
      data: {
        classId: id,
        direction: "TEACHER_TO_STUDENTS",
        senderUserId: teacher.userId,
        subject: subject.trim(),
        body: body.trim(),
        recipientCount: recipients.length,
        sentCount: result.sent,
        status,
        error: result.errors.length > 0 ? result.errors.slice(0, 5).join("; ") : null,
      },
    });

    return NextResponse.json(
      { message, sent: result.sent, failed: result.failed, status },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof SmtpNotConfiguredError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error("[CLASS_MESSAGES_POST]", error);
    return NextResponse.json({ error: "Failed to send email." }, { status: 500 });
  }
}
