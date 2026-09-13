import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeEmail, normalizeUsername, validatePassword } from "@/lib/account-validation";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, registerSchema } from "@/lib/validation";
import { logApiError, logSystemEvent } from "@/lib/system-log";
import {
  claimTeacherCode,
  findTeacherCode,
  hasRedeemableTeacherCode,
  TeacherCodeUnavailableError,
} from "@/lib/teacher-registration-codes";
import { teacherCodeStatus } from "@/lib/teacher-codes";

/** Same text for a wrong code, an expired one and a used-up one. */
const INVALID_CODE = "Invalid or expired teacher registration code.";

export async function POST(req: NextRequest) {
  // Throttle signup-token guessing and account-creation abuse per IP.
  const limited = rateLimit(req, "auth-register", 10, 60_000);
  if (limited) return limited;

  try {
    const body = await req.json();

    // Students cannot self-register — they must use an invitation link.
    // This endpoint is exclusively for teacher registration.
    //
    // Two things can authorize it: an admin-issued code from the panel
    // (TeacherRegistrationCode, with its own expiry and use limit), or the
    // legacy TEACHER_SIGNUP_TOKEN env var. The env var is still honoured when
    // set so upgrading a deployment doesn't lock its admins out of onboarding
    // teachers before they mint their first code.
    const envToken = process.env.TEACHER_SIGNUP_TOKEN;
    const submitted = typeof body?.teacherToken === "string" ? body.teacherToken : "";

    if (!envToken && !(await hasRedeemableTeacherCode())) {
      return NextResponse.json(
        { error: "Teacher registration is not configured on this server." },
        { status: 503 }
      );
    }

    const envTokenMatches = !!envToken && submitted === envToken;
    // Only look the code up when the env var didn't already authorize it, so a
    // deployment still on the env var does no extra query per attempt.
    const code = envTokenMatches || !submitted ? null : await findTeacherCode(submitted);

    if (!envTokenMatches && (!code || teacherCodeStatus(code) !== "ACTIVE")) {
      void logSystemEvent({
        category: "AUTH",
        type: "TEACHER_CODE_REJECTED",
        severity: "WARNING",
        message: code
          ? `Teacher registration refused: code is ${teacherCodeStatus(code).toLowerCase()}.`
          : "Teacher registration refused: unrecognized code.",
        metadata: code ? { codeId: code.id } : undefined,
      });
      return NextResponse.json({ error: INVALID_CODE }, { status: 403 });
    }

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
      return NextResponse.json({ error: "Email already in use." }, { status: 409 });
    }

    const existingUsername = await prisma.user.findUnique({
      where: { username: normalizedUsername },
    });
    if (existingUsername) {
      return NextResponse.json({ error: "Username already taken." }, { status: 409 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // SECURITY: consuming the code's slot and creating the account are one
    // transaction, so two concurrent registrations can't both pass the
    // status check above and get two teachers out of a single-use code. A
    // duplicate email/username further down rolls the claim back with it,
    // which is why a failed signup doesn't burn a use.
    await prisma.$transaction(async (tx) => {
      if (code) await claimTeacherCode(tx, code.id);
      await tx.user.create({
        data: {
          email: normalizedEmail,
          username: normalizedUsername,
          hashedPassword,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          role: "TEACHER",
          teacher: { create: {} },
        },
      });
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
    // Lost the race for the code's last slot — report it like any other
    // unusable code rather than as a server fault.
    if (err instanceof TeacherCodeUnavailableError) {
      return NextResponse.json({ error: INVALID_CODE }, { status: 403 });
    }

    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(", ") : "";
      const field = target.includes("username") ? "Username" : "Email";
      return NextResponse.json({ error: `${field} already in use.` }, { status: 409 });
    }

    logApiError("REGISTER", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
