import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET: validate token and return class info
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { class: { include: { teacher: { include: { user: true } } } } },
  });

  if (!invitation) return NextResponse.json({ error: "Invalid invitation link." }, { status: 404 });
  if (!invitation.active) return NextResponse.json({ error: "This invitation link has been deactivated." }, { status: 410 });
  if (invitation.expiresAt && invitation.expiresAt < new Date()) {
    return NextResponse.json({ error: "This invitation link has expired." }, { status: 410 });
  }
  if (invitation.maxUses && invitation.usedCount >= invitation.maxUses) {
    return NextResponse.json({ error: "This invitation link has reached its maximum uses." }, { status: 410 });
  }

  return NextResponse.json({
    valid: true,
    classId: invitation.classId,
    className: invitation.class.name,
    teacherName: `${invitation.class.teacher.user.firstName} ${invitation.class.teacher.user.lastName}`,
  });
}

// POST: use invitation (enroll current user, or create account + enroll)
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await prisma.invitation.findUnique({
    where: { token },
    include: { class: true },
  });

  if (!invitation || !invitation.active) {
    return NextResponse.json({ error: "Invalid invitation." }, { status: 404 });
  }
  if (invitation.expiresAt && invitation.expiresAt < new Date()) {
    return NextResponse.json({ error: "Invitation expired." }, { status: 410 });
  }
  if (invitation.maxUses && invitation.usedCount >= invitation.maxUses) {
    return NextResponse.json({ error: "Invitation limit reached." }, { status: 410 });
  }

  const session = await auth();
  let studentId: string;

  if (session?.user) {
    // Already logged in — enroll this user
    if (session.user.role !== "STUDENT") {
      return NextResponse.json({ error: "Only students can join classes." }, { status: 403 });
    }
    const student = await prisma.student.findUnique({ where: { userId: session.user.id } });
    if (!student) return NextResponse.json({ error: "Student record not found." }, { status: 404 });
    studentId = student.id;
  } else {
    // New signup flow
    const body = await req.json();
    const { firstName, lastName, username, email, password } = body;
    if (!firstName || !lastName || !username || !email || !password) {
      return NextResponse.json({ error: "All fields required for signup." }, { status: 400 });
    }

    const existing = await prisma.user.findFirst({
      where: { OR: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }] },
    });
    if (existing) return NextResponse.json({ error: "Email or username already in use." }, { status: 409 });

    const bcrypt = await import("bcryptjs");
    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        username: username.toLowerCase(),
        hashedPassword,
        firstName,
        lastName,
        role: "STUDENT",
        student: { create: {} },
      },
      include: { student: true },
    });
    studentId = user.student!.id;
  }

  // Enroll (upsert to avoid duplicate)
  await prisma.classEnrollment.upsert({
    where: { classId_studentId: { classId: invitation.classId, studentId } },
    update: {},
    create: { classId: invitation.classId, studentId },
  });

  // Increment use count
  await prisma.invitation.update({
    where: { id: invitation.id },
    data: { usedCount: { increment: 1 } },
  });

  return NextResponse.json({ success: true, classId: invitation.classId });
}
