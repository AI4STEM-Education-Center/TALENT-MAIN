import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { validatePassword } from "@/lib/account-validation";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { parseBody, resetPasswordSchema } from "@/lib/validation";
import { consumeResetToken, findValidResetToken } from "@/lib/password-reset";
import { sendPasswordChangedNotice } from "@/lib/password-notices";
import { logApiError, logSystemEvent } from "@/lib/system-log";

const INVALID_TOKEN_MESSAGE =
  "This reset link is invalid or has expired. Request a new one to continue.";

/**
 * GET /api/auth/reset-password?token=… — is this link still usable?
 * Lets the page show "link expired" before the user types a new password.
 */
export async function GET(req: NextRequest) {
  const limited = rateLimit(req, "auth-reset-password-check", 30, 60_000);
  if (limited) return limited;

  const token = req.nextUrl.searchParams.get("token") ?? "";
  const lookup = await findValidResetToken(token);
  if (!lookup.ok) {
    return NextResponse.json({ valid: false, error: INVALID_TOKEN_MESSAGE });
  }

  const user = await prisma.user.findUnique({
    where: { id: lookup.userId },
    select: { username: true },
  });
  return NextResponse.json({ valid: true, username: user?.username ?? null });
}

/**
 * POST /api/auth/reset-password — redeem a link and set a new password.
 * Public (see src/proxy.ts) and rate limited per IP; the token itself is
 * single-use, so a successful reset immediately voids the link.
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "auth-reset-password", 10, 60_000);
  if (limited) return limited;

  const ip = clientIp(req);

  try {
    const parsed = parseBody(resetPasswordSchema, await req.json());
    if (!parsed.ok) return parsed.response;
    const { token, password } = parsed.data;

    const lookup = await findValidResetToken(token);
    if (!lookup.ok) {
      await logSystemEvent({
        category: "AUTH",
        type: "PASSWORD_RESET_REJECTED",
        severity: "WARNING",
        message: `Password reset rejected: token ${lookup.reason}`,
        ip,
        metadata: { reason: lookup.reason },
      });
      return NextResponse.json({ error: INVALID_TOKEN_MESSAGE }, { status: 400 });
    }

    // Password strength is checked before the token is burned so a weak attempt
    // doesn't cost the user their link.
    const passwordError = validatePassword(password);
    if (passwordError) {
      return NextResponse.json({ error: passwordError }, { status: 400 });
    }

    const user = await prisma.user.findUnique({ where: { id: lookup.userId } });
    if (!user) {
      return NextResponse.json({ error: INVALID_TOKEN_MESSAGE }, { status: 400 });
    }

    const consumed = await consumeResetToken(
      lookup.tokenId,
      user.id,
      await bcrypt.hash(password, 12)
    );
    if (!consumed) {
      // Lost a race with a concurrent redemption of the same link.
      return NextResponse.json({ error: INVALID_TOKEN_MESSAGE }, { status: 400 });
    }

    await logSystemEvent({
      category: "AUTH",
      type: "PASSWORD_RESET_COMPLETED",
      message: `${user.username} reset their password via an emailed link`,
      userId: user.id,
      ip,
    });

    await sendPasswordChangedNotice(req, user);

    return NextResponse.json({ success: true, username: user.username });
  } catch (error) {
    logApiError("AUTH_RESET_PASSWORD", error);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
