import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeEmail, normalizeUsername, validatePassword } from "@/lib/account-validation";
import { isValidEmail, normalizeEmail as normalizeRosterEmail } from "@/lib/csv-roster";
import { rateLimit } from "@/lib/rate-limit";
import { logApiError } from "@/lib/system-log";

class InvitationUnavailableError extends Error {}
class RosterAlreadyClaimedError extends Error {}

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
    let existingStudentId: string | null = null;
    const firstName = rosterEntry.firstName;
    const lastName = rosterEntry.lastName;
    let rosterEmailUpdate: string | null = null;
    let signupData: {
      email: string;
      username: string;
      hashedPassword: string;
    } | null = null;

    if (session?.user) {
      // Already logged in — enroll this user
      if (session.user.role !== "STUDENT") {
        return NextResponse.json({ error: "Only students can join classes." }, { status: 403 });
      }
      const student = await prisma.student.findUnique({
        where: { userId: session.user.id },
        include: { user: { select: { email: true } } },
      });
      if (!student) return NextResponse.json({ error: "Student record not found." }, { status: 404 });
      // The account the student actually signs in to owns the mailbox, so the
      // roster follows it rather than the other way round. A roster address is
      // whatever the registrar exported; the confirmed account address is where
      // teacher notifications have to land.
      const canonicalUserEmail = normalizeRosterEmail(student.user.email);
      if (canonicalUserEmail !== rosterEntry.email) {
        rosterEmailUpdate = canonicalUserEmail;
      }
      existingStudentId = student.id;
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

      const normalizedEmail = normalizeRosterEmail(normalizeEmail(email));
      const normalizedUsername = normalizeUsername(username);

      // The address doubles as the roster's notification target, so reject
      // anything unsendable here rather than storing it and failing silently.
      if (!isValidEmail(normalizedEmail)) {
        return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
      }

      // The roster follows the address the student signed up with: registrar
      // exports go stale, and teacher notifications must reach the mailbox the
      // student actually confirmed. The 81 number is the identity check here —
      // it is unique per class, single-claim (isRegistered), and rate-limited.
      if (normalizedEmail !== rosterEntry.email) {
        rosterEmailUpdate = normalizedEmail;
      }

      const existingEmail = await prisma.user.findUnique({ where: { email: normalizedEmail } });
      if (existingEmail) {
        return NextResponse.json({ error: "Email already in use." }, { status: 409 });
      }

      const existingUsername = await prisma.user.findUnique({ where: { username: normalizedUsername } });
      if (existingUsername) {
        return NextResponse.json({ error: "Username already taken." }, { status: 409 });
      }

      signupData = {
        email: normalizedEmail,
        username: normalizedUsername,
        hashedPassword: await bcrypt.hash(password, 12),
      };
    }

    // SECURITY: claiming the invite slot, claiming the roster identity,
    // creating the account, and enrolling it are one transaction. Previously
    // two requests could both pass the preflight reads, create separate users,
    // enroll both under one 81 number, and exceed maxUses.
    await prisma.$transaction(async (tx) => {
      const currentInvitation = await tx.invitation.findUnique({
        where: { id: invitation.id },
      });
      const now = new Date();
      if (
        !currentInvitation ||
        !currentInvitation.active ||
        (currentInvitation.expiresAt && currentInvitation.expiresAt < now) ||
        (currentInvitation.maxUses &&
          currentInvitation.usedCount >= currentInvitation.maxUses)
      ) {
        throw new InvitationUnavailableError();
      }

      const inviteClaim = await tx.invitation.updateMany({
        where: {
          id: currentInvitation.id,
          active: true,
          usedCount: currentInvitation.usedCount,
        },
        data: { usedCount: { increment: 1 } },
      });
      if (inviteClaim.count !== 1) throw new InvitationUnavailableError();

      const rosterClaim = await tx.classStudentList.updateMany({
        where: { id: rosterEntry.id, isRegistered: false },
        data: {
          isRegistered: true,
          ...(rosterEmailUpdate ? { email: rosterEmailUpdate } : {}),
        },
      });
      if (rosterClaim.count !== 1) throw new RosterAlreadyClaimedError();

      let studentId = existingStudentId;
      if (!studentId) {
        if (!signupData) throw new Error("Missing signup data");
        const user = await tx.user.create({
          data: {
            email: signupData.email,
            username: signupData.username,
            hashedPassword: signupData.hashedPassword,
            firstName,
            lastName,
            role: "STUDENT",
            student: { create: {} },
          },
          include: { student: true },
        });
        studentId = user.student!.id;
      }

      await tx.classEnrollment.upsert({
        where: { classId_studentId: { classId: invitation.classId, studentId } },
        update: {},
        create: { classId: invitation.classId, studentId },
      });
    });

    return NextResponse.json({
      success: true,
      classId: invitation.classId,
      firstName,
      lastName,
    });
  } catch (err) {
    if (err instanceof InvitationUnavailableError) {
      return NextResponse.json({ error: "Invitation limit reached." }, { status: 410 });
    }
    if (err instanceof RosterAlreadyClaimedError) {
      return NextResponse.json(
        { error: "This 81 number is already registered." },
        { status: 409 }
      );
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(", ") : "";
      const field = target.includes("username") ? "Username" : "Email";
      return NextResponse.json({ error: `${field} already in use.` }, { status: 409 });
    }

    logApiError("INVITATION_POST", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}

