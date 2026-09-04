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
import { logApiError } from "@/lib/system-log";

export async function POST(req: NextRequest) {
  // Throttle admin signup-token guessing per IP.
  const limited = rateLimit(req, "auth-admin-register", 10, 60_000);
  if (limited) return limited;

  try {
    const body = await req.json();

    const expectedToken = process.env.ADMIN_SIGNUP_TOKEN;
    if (!expectedToken) {
      return NextResponse.json(
        { error: "Admin registration is not configured on this server." },
        { status: 503 },
      );
    }
    if (!body?.adminToken || body.adminToken !== expectedToken) {
      return NextResponse.json(
        { error: "Invalid admin registration code." },
        { status: 403 },
      );
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

    await prisma.user.create({
      data: {
        email: normalizedEmail,
        username: normalizedUsername,
        hashedPassword,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        role: "ADMIN",
      },
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
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

    logApiError("ADMIN REGISTER", err);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
