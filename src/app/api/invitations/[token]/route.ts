import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeEmail, normalizeUsername, validatePassword } from "@/lib/account-validation";
import { rateLimit } from "@/lib/rate-limit";
import { logApiError } from "@/lib/system-log";

// GET: validate token and return class info
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  // Throttle invitation-token guessing per IP.
  const limited = rateLimit(req, "invite-validate", 30, 60_000);
  if (limited) return limited;

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
// Now requires orgDefinedId (81 number) verification against the class roster.
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  // Throttle enrollment/signup attempts (token + 81-number guessing) per IP.
  const limited = rateLimit(req, "invite-enroll", 15, 60_000);
  if (limited) return limited;

  try {
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

    const body = await req.json();
    const rawOrgId = (body.orgDefinedId || "").replace(/^#/, "").trim();

    if (!rawOrgId) {
      return NextResponse.json({ error: "81 number is required." }, { status: 400 });
    }

    // Verify the 81 number against the class roster
    const rosterEntry = await prisma.classStudentList.findUnique({
      where: {
        classId_orgDefinedId: {
          classId: invitation.classId,
          orgDefinedId: rawOrgId,
        },
      },
    });

    if (!rosterEntry) {
      return NextResponse.json({ error: "81 not found for class retry again" }, { status: 404 });
    }

    if (rosterEntry.isRegistered) {
      return NextResponse.json({ error: "This 81 number is already registered." }, { status: 409 });
    }

    const session = await auth();
    let studentId: string;
    let firstName = rosterEntry.firstName;
    let lastName = rosterEntry.lastName;

    if (session?.user) {
      // Already logged in — enroll this user
      if (session.user.role !== "STUDENT") {
        return NextResponse.json({ error: "Only students can join classes." }, { status: 403 });
      }
      const student = await prisma.student.findUnique({ where: { userId: session.user.id } });
      if (!student) return NextResponse.json({ error: "Student record not found." }, { status: 404 });
      studentId = student.id;
    } else {
      // New signup flow — requires username, email, password
      const { username, email, password } = body;
      if (!username?.trim() || !email?.trim() || !password) {
        return NextResponse.json({ error: "Username, email, and password are required." }, { status: 400 });
      }

      const passwordError = validatePassword(password);
      if (passwordError) {
        return NextResponse.json({ error: passwordError }, { status: 400 });
      }

      const normalizedEmail = normalizeEmail(email);
      const normalizedUsername = normalizeUsername(username);

      const existingEmail = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existingEmail) {
        return NextResponse.json({ error: "Email already in use." }, { status: 409 });
      }

      const existingUsername = await prisma.user.findUnique({ where: { username: normalizedUsername } });
      if (existingUsername) {
        return NextResponse.json({ error: "Username already taken." }, { status: 409 });
      }

      const hashedPassword = await bcrypt.hash(password, 12);

      const user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          username: normalizedUsername,
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

    // Enroll + mark roster entry as registered + increment invite use count
    await prisma.$transaction([
      prisma.classEnrollment.upsert({
        where: { classId_studentId: { classId: invitation.classId, studentId } },
        update: {},
        create: { classId: invitation.classId, studentId },
      }),
      prisma.classStudentList.update({
        where: { id: rosterEntry.id },
        data: { isRegistered: true },
      }),
      prisma.invitation.update({
        where: { id: invitation.id },
        data: { usedCount: { increment: 1 } },
      }),
    ]);

    return NextResponse.json({
      success: true,
      classId: invitation.classId,
      firstName,
      lastName,
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(", ") : "";
      const field = target.includes("username") ? "Username" : "Email";
      return NextResponse.json({ error: `${field} already in use.` }, { status: 409 });
    }

    logApiError("INVITATION_POST", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

