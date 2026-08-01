import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail, SmtpNotConfiguredError } from "@/lib/email";
import { isValidEmail } from "@/lib/csv-roster";
import { getTeacherEmailQuota, parseChannels, serializeChannels } from "@/lib/email-limits";
import { logApiError } from "@/lib/system-log";

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

// POST: teacher broadcasts to a class via in-app notification and/or email.
// Body: { subject, body, channels: { inApp, email }, recipientIds? }
// In-app notifications are unlimited and go to every enrolled student; email is
// capped per teacher (per-day and per-month, see src/lib/email-limits.ts).
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

  const { subject, body, channels: channelsInput, recipientIds } = await req.json();
  if (!subject?.trim() || !body?.trim()) {
    return NextResponse.json({ error: "Subject and message body are required." }, { status: 400 });
  }

  const channels = parseChannels(channelsInput);
  if (!channels.inApp && !channels.email) {
    return NextResponse.json(
      { error: "Select at least one channel: in-app notification or email." },
      { status: 400 }
    );
  }

  // In-app recipients: every enrolled student (those with an account). Announcements
  // always go to the whole class, so recipientIds only narrows the email channel.
  let inAppUserIds: string[] = [];
  if (channels.inApp) {
    const enrollments = await prisma.classEnrollment.findMany({
      where: { classId: id },
      include: { student: { select: { userId: true } } },
    });
    inAppUserIds = enrollments.map((e) => e.student.userId);
  }

  // Email recipients: roster entries with a valid email (optionally narrowed).
  let emailRecipients: string[] = [];
  if (channels.email) {
    const roster = await prisma.classStudentList.findMany({
      where: {
        classId: id,
        ...(Array.isArray(recipientIds) && recipientIds.length > 0
          ? { id: { in: recipientIds } }
          : {}),
      },
    });
    emailRecipients = roster
      .map((s) => s.email)
      .filter((e): e is string => !!e && isValidEmail(e));
  }

  if (inAppUserIds.length === 0 && emailRecipients.length === 0) {
    const msg = channels.email && !channels.inApp
      ? "No roster students with a valid email address were found."
      : "No students found to receive this message.";
    return NextResponse.json({ error: msg }, { status: 400 });
  }

  // Enforce the email quota up front so nothing is sent when it would exceed the
  // cap — the teacher can uncheck Email or reduce recipients and retry.
  if (channels.email && emailRecipients.length > 0) {
    const quota = await getTeacherEmailQuota(teacher.userId, {
      emailDailyLimit: teacher.emailDailyLimit,
      emailMonthlyLimit: teacher.emailMonthlyLimit,
    });
    if (emailRecipients.length > quota.remaining) {
      return NextResponse.json(
        {
          error:
            `This would send ${emailRecipients.length} emails but you have ${quota.remaining} left ` +
            `(${quota.dailyRemaining} today, ${quota.monthlyRemaining} this month). ` +
            `Uncheck Email or reduce recipients — in-app notifications are unlimited.`,
          quota,
        },
        { status: 429 }
      );
    }
  }

  const teacherName = `${teacher.user.firstName} ${teacher.user.lastName}`.trim();

  // Send email (if requested). In-app delivery still proceeds even if email
  // fails, so a misconfigured SMTP server never blocks an announcement.
  let emailAttempted = false;
  let emailSent = 0;
  let emailStatus = "SENT";
  let emailError: string | null = null;

  if (channels.email && emailRecipients.length > 0) {
    const text = `${body.trim()}\n\n— ${teacherName} (${cls.name})`;
    try {
      emailAttempted = true;
      const result = await sendEmail({
        to: emailRecipients,
        subject: subject.trim(),
        text,
        purpose: "NOTIFICATION",
        replyTo: teacher.user.email,
      });
      emailSent = result.sent;
      emailStatus = result.failed === 0 ? "SENT" : result.sent === 0 ? "FAILED" : "PARTIAL";
      emailError = result.errors.length > 0 ? result.errors.slice(0, 5).join("; ") : null;
    } catch (error) {
      emailAttempted = false; // sendEmail threw before attempting — don't count it
      if (error instanceof SmtpNotConfiguredError) {
        if (!channels.inApp) {
          return NextResponse.json({ error: error.message }, { status: 503 });
        }
        emailStatus = "FAILED";
        emailError = error.message;
      } else {
        logApiError("CLASS_MESSAGES_POST", error);
        if (!channels.inApp) {
          return NextResponse.json({ error: "Failed to send email." }, { status: 500 });
        }
        emailStatus = "FAILED";
        emailError = "Failed to send email.";
      }
    }
  } else if (!channels.email) {
    emailStatus = "SENT"; // email channel not used; status describes email only
  }

  const message = await prisma.message.create({
    data: {
      classId: id,
      direction: "TEACHER_TO_STUDENTS",
      channels: serializeChannels(channels),
      senderUserId: teacher.userId,
      subject: subject.trim(),
      body: body.trim(),
      // Count attempted email recipients (0 if the send was never attempted) so a
      // failed-before-send never burns quota.
      recipientCount: emailAttempted ? emailRecipients.length : 0,
      sentCount: emailSent,
      inAppCount: inAppUserIds.length,
      status: emailStatus,
      error: emailError,
    },
  });

  if (inAppUserIds.length > 0) {
    await prisma.notification.createMany({
      data: inAppUserIds.map((userId) => ({ messageId: message.id, userId })),
    });
  }

  return NextResponse.json(
    {
      message,
      channels: serializeChannels(channels),
      inApp: { count: inAppUserIds.length },
      email: channels.email
        ? { sent: emailSent, attempted: emailAttempted ? emailRecipients.length : 0, status: emailStatus, error: emailError }
        : null,
    },
    { status: 201 }
  );
}
