import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { firstName, lastName, username, email, password, teacherToken } = body;

    // Students cannot self-register — they must use an invitation link.
    // This endpoint is exclusively for teacher registration.
    const expectedToken = process.env.TEACHER_SIGNUP_TOKEN;
    if (!expectedToken) {
      return NextResponse.json(
        { error: "Teacher registration is not configured on this server." },
        { status: 503 }
      );
    }
    if (!teacherToken || teacherToken !== expectedToken) {
      return NextResponse.json(
        { error: "Invalid teacher registration code." },
        { status: 403 }
      );
    }

    if (!firstName || !lastName || !username || !email || !password) {
      return NextResponse.json({ error: "All fields are required." }, { status: 400 });
    }

    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters." },
        { status: 400 }
      );
    }

    const existingEmail = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (existingEmail) {
      return NextResponse.json({ error: "Email already in use." }, { status: 409 });
    }

    const existingUsername = await prisma.user.findUnique({
      where: { username: username.toLowerCase() },
    });
    if (existingUsername) {
      return NextResponse.json({ error: "Username already taken." }, { status: 409 });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    await prisma.user.create({
      data: {
        email: email.toLowerCase(),
        username: username.toLowerCase(),
        hashedPassword,
        firstName,
        lastName,
        role: "TEACHER",
        teacher: { create: {} },
      },
    });

    return NextResponse.json({ success: true }, { status: 201 });
  } catch (err) {
    console.error("[REGISTER]", err);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
