import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  normalizeEmail,
  normalizeUsername,
  validatePassword,
} from "@/lib/account-validation";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, registerSchema } from "@/lib/validation";
import { logApiError, logSystemEvent } from "@/lib/system-log";
import {
  claimTeacherCode,
  TeacherCodeUnavailableError,
} from "@/lib/teacher-registration-codes";
import {
  INVALID_INVITE_CODE,
  REGISTRATION_NOT_CONFIGURED,
  resolveInviteCode,
  submittedInviteCode,
} from "@/lib/registration";
import { TEACHER } from "@/lib/roles";

/**
 * The one self-registration endpoint for every non-student account. The
 * submitted invite code decides the role — ADMIN, TEACHER or RESEARCHER; see
 * src/lib/registration.ts for the resolution order. The registrant never picks
 * a role. Students cannot self-register; they join via class invitation links.
 */
export async function POST(req: NextRequest) {
  // Throttle invite-code guessing and account-creation abuse per IP.
  const limited = rateLimit(req, "auth-register", 10, 60_000);
  if (limited) return limited;

  try {
    const body = await req.json();

    const resolution = await resolveInviteCode(submittedInviteCode(body));

    if (!resolution.ok && resolution.reason === "NOT_CONFIGURED") {
      return NextResponse.json(
        { error: REGISTRATION_NOT_CONFIGURED },
        { status: 503 },
      );
    }

    if (!resolution.ok) {
      const { code, status } = resolution;
      void logSystemEvent({
        category: "AUTH",
        type: "REGISTRATION_CODE_REJECTED",
        severity: "WARNING",
        message: code
          ? `Registration refused: invite code is ${status.toLowerCase().replace("_", " ")}.`
          : "Registration refused: unrecognized invite code.",
        metadata: code ? { codeId: code.id, status } : undefined,
      });
      // One generic answer for every unusable code, so the response never
      // says whether a code exists, expired or was used up.
      return NextResponse.json({ error: INVALID_INVITE_CODE }, { status: 403 });
    }

    const { role, code, source } = resolution;

    const parsed = parseBody(registerSchema, body);
    if (!parsed.ok) return parsed.response;
    const { firstName, lastName, username, email, password } = parsed.data;

    const passwordError = validatePassword(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const normalizedEmail = normalizeEmail(email);
    const normalizedUsername = normalizeUsername(username);

    const existingEmail = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (existingEmail) {
      return NextResponse.json(
        { error: "Email already in use." },
        { status: 409 },
      );
    }

    const existingUsername = await prisma.user.findUnique({
      where: { username: normalizedUsername },
    });
    if (existingUsername) {
      return NextResponse.json(
        { error: "Username already taken." },
        { status: 409 },
      );
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // SECURITY: consuming the code's slot and creating the account are one
    // transaction, so two concurrent registrations can't both pass the
    // status check above and get two accounts out of a single-use code. A
    // duplicate email/username further down rolls the claim back with it,
    // which is why a failed signup doesn't burn a use.
    const user = await prisma.$transaction(async (tx) => {
      if (code) await claimTeacherCode(tx, code.id);
      return tx.user.create({
        data: {
          email: normalizedEmail,
          username: normalizedUsername,
          hashedPassword,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          role,
          // Only teachers own classes and content; ADMIN and RESEARCHER
          // accounts get no Teacher row.
          ...(role === TEACHER ? { teacher: { create: {} } } : {}),
        },
        select: { id: true, username: true },
      });
    });

    void logSystemEvent({
      category: "AUTH",
      type: "ACCOUNT_REGISTERED",
      message: `${user.username} registered as ${role}.`,
      userId: user.id,
      metadata: { role, source, ...(code ? { codeId: code.id } : {}) },
    });

    return NextResponse.json({ success: true, role }, { status: 201 });
  } catch (err) {
    // Lost the race for the code's last slot — report it like any other
    // unusable code rather than as a server fault.
    if (err instanceof TeacherCodeUnavailableError) {
      return NextResponse.json({ error: INVALID_INVITE_CODE }, { status: 403 });
    }

    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const target = Array.isArray(err.meta?.target)
        ? err.meta.target.join(", ")
        : "";
      const field = target.includes("username") ? "Username" : "Email";
      return NextResponse.json(
        { error: `${field} already in use.` },
        { status: 409 },
      );
    }

    logApiError("REGISTER", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
