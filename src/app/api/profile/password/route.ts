import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validatePassword } from "@/lib/account-validation";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { parseBody, changePasswordSchema } from "@/lib/validation";
import { invalidateResetTokens } from "@/lib/password-reset";
import { sendPasswordChangedNotice } from "@/lib/password-notices";
import { logApiError, logSystemEvent } from "@/lib/system-log";

/**
 * POST /api/profile/password — change the signed-in user's password.
 * The current password is required, so a hijacked session alone can't lock the
 * owner out. Any outstanding reset links are voided, and the account is emailed
 * a security notice.
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Tight limit: this endpoint verifies a password, so it's an oracle if left open.
  const limited = rateLimit(req, "profile-password", 10, 60_000);
  if (limited) return limited;

  try {
    const parsed = parseBody(changePasswordSchema, await req.json());
    if (!parsed.ok) return parsed.response;
    const { currentPassword, newPassword } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
    });
    if (!user)
      return NextResponse.json(
        { error: "Account not found." },
        { status: 404 },
      );

    const currentValid = await bcrypt.compare(
      currentPassword,
      user.hashedPassword,
    );
    if (!currentValid) {
      await logSystemEvent({
        category: "AUTH",
        type: "PASSWORD_CHANGE_FAILED",
        severity: "WARNING",
        message: `Failed password change for ${user.username}: wrong current password`,
        userId: user.id,
        ip: clientIp(req),
      });
      return NextResponse.json(
        { error: "Your current password is incorrect." },
        { status: 403 },
      );
    }

    const passwordError = validatePassword(newPassword);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }
    if (currentPassword === newPassword) {
      return NextResponse.json(
        { error: "Your new password must be different from your current one." },
        { status: 400 },
      );
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { hashedPassword: await bcrypt.hash(newPassword, 12) },
    });
    await invalidateResetTokens(user.id);

    await logSystemEvent({
      category: "AUTH",
      type: "PASSWORD_CHANGED",
      message: `${user.username} changed their password`,
      userId: user.id,
      ip: clientIp(req),
    });

    // Best-effort: a missing or broken SMTP server must not fail the change the
    // user just made successfully.
    const emailed = await sendPasswordChangedNotice(req, user);

    return NextResponse.json({ success: true, notified: emailed });
  } catch (error) {
    logApiError("PROFILE_PASSWORD_POST", error);
    return NextResponse.json(
      { error: "Internal server error." },
      { status: 500 },
    );
  }
}
