import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getTeacherEmailQuota } from "@/lib/email-limits";
import { selectEmailRecipients } from "@/lib/message-email";
import { enqueueMessageEmails } from "@/lib/queue";
import { logApiError } from "@/lib/system-log";

/** Per-message delivery tallies, keyed by message id, for the history list. */
async function emailDeliveryCounts(messageIds: string[]) {
  const byMessage = new Map<string, { queued: number; sent: number; failed: number }>();
  if (messageIds.length === 0) return byMessage;

  const rows = await prisma.messageEmailDelivery.groupBy({
    by: ["messageId", "status"],
    where: { messageId: { in: messageIds } },
    _count: { _all: true },
  });

  for (const row of rows) {
    const count = row._count._all;
    const entry = byMessage.get(row.messageId) ?? { queued: 0, sent: 0, failed: 0 };
    if (row.status === "SENT") entry.sent += count;
    else if (row.status === "FAILED") entry.failed += count;
    else entry.queued += count;
    byMessage.set(row.messageId, entry);
  }
  return byMessage;
}

// GET: this class's message history (teacher only) plus the audience a new
// message would reach. Each row carries its live email delivery tally — sends
// are queued, so those counts keep moving after the compose request returns.
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

  const [messages, enrollments] = await Promise.all([
    prisma.message.findMany({
      where: { classId: id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { sender: { select: { firstName: true, lastName: true, role: true } } },
    }),
    prisma.classEnrollment.findMany({
      where: { classId: id },
      include: {
        student: {
          select: {
            user: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        },
      },
    }),
  ]);

  const counts = await emailDeliveryCounts(messages.map((m) => m.id));

  return NextResponse.json({
    className: cls.name,
    audience: {
      enrolled: enrollments.length,
      emailable: selectEmailRecipients(
        enrollments.map((e) => ({ email: e.student.user.email }))
      ).size,
    },
    recipients: enrollments
      .map((enrollment) => ({
        userId: enrollment.student.user.id,
        firstName: enrollment.student.user.firstName,
        lastName: enrollment.student.user.lastName,
        email: enrollment.student.user.email,
      }))
      .sort(
        (a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName)
      ),
    messages: messages.map((m) => ({
      ...m,
      email: counts.get(m.id) ?? { queued: 0, sent: 0, failed: 0 },
    })),
  });
}

// POST: teacher messages the class or selected enrolled students.
// Body: { subject, body, recipientUserIds? }
//
// One channel decision, made for the teacher: every targeted student gets an
// in-app notification, and every targeted student who has a valid email
// address on file also gets an automated email telling them it arrived. The
// email is not sent here — a MessageEmailDelivery row per recipient is written
// and queued, and the worker delivers it with retries (src/lib/message-email.ts).
// That keeps the compose request fast and, more importantly, means a flaky SMTP
// server delays the notification rather than losing it.
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

  const { subject, body, recipientUserIds } = await req.json();
  if (!subject?.trim() || !body?.trim()) {
    return NextResponse.json({ error: "Subject and message body are required." }, { status: 400 });
  }

  const hasExplicitRecipients = recipientUserIds !== undefined;
  if (hasExplicitRecipients && !Array.isArray(recipientUserIds)) {
    return NextResponse.json({ error: "Recipients must be an array." }, { status: 400 });
  }

  const selectedUserIds = hasExplicitRecipients
    ? [
        ...new Set(
          (recipientUserIds as unknown[]).filter(
            (value): value is string => typeof value === "string" && value.length > 0
          )
        ),
      ]
    : [];
  if (hasExplicitRecipients && selectedUserIds.length !== (recipientUserIds as unknown[]).length) {
    return NextResponse.json({ error: "Recipients must be unique student IDs." }, { status: 400 });
  }
  if (hasExplicitRecipients && selectedUserIds.length === 0) {
    return NextResponse.json({ error: "Select at least one student." }, { status: 400 });
  }

  // Recipients are the enrolled students — the people who will actually see the
  // message in their mailbox. Their account email is the address on file
  // (validated at signup), so email follows the in-app audience exactly.
  const enrollments = await prisma.classEnrollment.findMany({
    where: { classId: id },
    include: { student: { select: { userId: true, user: { select: { email: true } } } } },
  });

  const selectedUserIdSet = new Set(selectedUserIds);
  const recipientEnrollments = hasExplicitRecipients
    ? enrollments.filter((enrollment) => selectedUserIdSet.has(enrollment.student.userId))
    : enrollments;

  if (hasExplicitRecipients && recipientEnrollments.length !== selectedUserIds.length) {
    return NextResponse.json(
      { error: "One or more selected students are not enrolled in this class." },
      { status: 400 }
    );
  }

  if (recipientEnrollments.length === 0) {
    return NextResponse.json(
      { error: "No students have joined this class yet, so there is nobody to notify." },
      { status: 400 }
    );
  }

  const inAppUserIds = recipientEnrollments.map((enrollment) => enrollment.student.userId);

  const emailRecipients = selectEmailRecipients(
    recipientEnrollments.map((enrollment) => ({
      userId: enrollment.student.userId,
      email: enrollment.student.user.email,
    }))
  );

  // Quota is checked before anything is queued. Emailing an arbitrary subset of
  // a class is worse than emailing none, so an over-budget send drops the email
  // channel entirely and still delivers in-app — the teacher is told which.
  let emailSkippedReason: string | null = null;
  if (emailRecipients.size > 0) {
    const quota = await getTeacherEmailQuota(teacher.userId, {
      emailDailyLimit: teacher.emailDailyLimit,
      emailMonthlyLimit: teacher.emailMonthlyLimit,
    });
    if (emailRecipients.size > quota.remaining) {
      emailSkippedReason =
        `Email skipped: this message needs ${emailRecipients.size} emails but only ${quota.remaining} are left ` +
        `in your budget (${quota.dailyRemaining} today, ${quota.monthlyRemaining} this month). ` +
        `Students still got the in-app notification.`;
    }
  }

  const queueEmail = emailRecipients.size > 0 && !emailSkippedReason;
  const emailCount = queueEmail ? emailRecipients.size : 0;

  const message = await prisma.message.create({
    data: {
      classId: id,
      direction: "TEACHER_TO_STUDENTS",
      channels: queueEmail ? "IN_APP,EMAIL" : "IN_APP",
      senderUserId: teacher.userId,
      subject: subject.trim(),
      body: body.trim(),
      // recipientCount is what the quota counts, so it must reflect the emails
      // we committed to sending — queued now, delivered by the worker.
      recipientCount: emailCount,
      sentCount: 0,
      inAppCount: inAppUserIds.length,
      status: queueEmail ? "QUEUED" : "SENT",
      error: emailSkippedReason,
    },
  });

  await prisma.notification.createMany({
    data: inAppUserIds.map((userId) => ({ messageId: message.id, userId })),
  });

  let queued = 0;
  if (queueEmail) {
    // Rows first, jobs second: the row is the durable record of intent, so an
    // enqueue that fails here is picked up by the worker's sweeper rather than
    // silently dropping that student's email.
    await prisma.messageEmailDelivery.createMany({
      data: [...emailRecipients.entries()].map(([email, userId]) => ({
        messageId: message.id,
        userId,
        email,
      })),
    });

    const deliveries = await prisma.messageEmailDelivery.findMany({
      where: { messageId: message.id },
      select: { id: true },
    });

    try {
      enqueueMessageEmails(deliveries.map((d) => d.id));
      queued = deliveries.length;
    } catch (error) {
      logApiError("CLASS_MESSAGES_ENQUEUE", error);
    }
  }

  return NextResponse.json(
    {
      message,
      inApp: { count: inAppUserIds.length },
      email: {
        recipients: emailCount,
        queued,
        skippedReason: emailSkippedReason,
      },
    },
    { status: 201 }
  );
}
