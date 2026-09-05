import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/account-validation";
import { rateLimit } from "@/lib/rate-limit";
import { parseBody, profileUpdateSchema } from "@/lib/validation";
import { logApiError, logSystemEvent } from "@/lib/system-log";

const PROFILE_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  username: true,
  role: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

/** GET /api/profile — the signed-in user's own account details. */
export async function GET() {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: PROFILE_SELECT,
  });
  if (!user)
    return NextResponse.json({ error: "Account not found." }, { status: 404 });

  return NextResponse.json({ profile: user });
}

/**
 * PATCH /api/profile — update the signed-in user's name and email address.
 * Username is the login identifier and is deliberately not editable here.
 */
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limited = rateLimit(req, "profile-update", 20, 60_000);
  if (limited) return limited;

  try {
    const parsed = parseBody(profileUpdateSchema, await req.json());
    if (!parsed.ok) return parsed.response;
    const { firstName, lastName, email } = parsed.data;

    const normalizedEmail = normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return NextResponse.json(
        { error: "Enter a valid email address." },
        { status: 400 },
      );
    }

    const clash = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });
    if (clash && clash.id !== session.user.id) {
      return NextResponse.json(
        { error: "Email already in use." },
        { status: 409 },
      );
    }

    const user = await prisma.user.update({
      where: { id: session.user.id },
      data: { firstName, lastName, email: normalizedEmail },
      select: PROFILE_SELECT,
    });

    return NextResponse.json({ profile: user });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return NextResponse.json(
        { error: "Email already in use." },
        { status: 409 },
      );
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Account not found." },
        { status: 404 },
      );
    }
    logApiError("PROFILE_PATCH", error);
    void logSystemEvent({
      category: "AUTH",
      type: "PROFILE_UPDATE_FAILED",
      severity: "WARNING",
      message: "Profile update failed",
      userId: session.user.id,
    });
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
