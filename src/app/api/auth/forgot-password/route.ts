import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { appOrigin } from "@/lib/app-url";
import { normalizeEmail, normalizeUsername } from "@/lib/account-validation";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { parseBody, forgotPasswordSchema } from "@/lib/validation";
import { issueResetToken, resetRequestsExhausted, RESET_TOKEN_TTL_MINUTES } from "@/lib/password-reset";
import { sendPurposeEmail, SmtpNotConfiguredError } from "@/lib/email";
import { logApiError, logSystemEvent } from "@/lib/system-log";

/**
 * The same reply for every outcome — unknown account, throttled account, or a
 * link actually sent. Anything else turns this endpoint into an account
 * enumeration oracle.
 */
const GENERIC_RESPONSE = {
  success: true,
  message:
    "If an account matches what you entered, we've emailed a password reset link. " +
    "Check your inbox (and spam folder).",
};

/**
 * POST /api/auth/forgot-password — start a password reset.
 *
 * Public by design (see src/proxy.ts: /api/auth/* is unauthenticated), so it is
 * rate limited per IP here and per account in resetRequestsExhausted.
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "auth-forgot-password", 5, 60_000);
  if (limited) return limited;

  const ip = clientIp(req);

  try {
    const parsed = parseBody(forgotPasswordSchema, await req.json());
    if (!parsed.ok) return parsed.response;

    const identifier = parsed.data.identifier;
    const user = await prisma.user.findFirst({
      where: {
        OR: [{ email: normalizeEmail(identifier) }, { username: normalizeUsername(identifier) }],
      },
    });

    if (!user) {
      await logSystemEvent({
        category: "AUTH",
        type: "PASSWORD_RESET_REQUESTED",
        severity: "WARNING",
        message: `Password reset requested for unknown account "${identifier}"`,
        ip,
        metadata: { identifier, outcome: "unknown_account" },
      });
      return NextResponse.json(GENERIC_RESPONSE);
    }

    if (await resetRequestsExhausted(user.id)) {
      await logSystemEvent({
        category: "AUTH",
        type: "PASSWORD_RESET_THROTTLED",
        severity: "WARNING",
        message: `Password reset requests throttled for ${user.username}`,
        userId: user.id,
        ip,
      });
      return NextResponse.json(GENERIC_RESPONSE);
    }

    const { token } = await issueResetToken(user.id, ip);
    const resetUrl = `${appOrigin(req)}/reset-password?token=${encodeURIComponent(token)}`;

    const result = await sendPurposeEmail("PASSWORD_RESET", user.email, {
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      resetUrl,
      expiresInMinutes: RESET_TOKEN_TTL_MINUTES,
    });

    await logSystemEvent({
      category: "AUTH",
      type: "PASSWORD_RESET_REQUESTED",
      severity: result.sent > 0 ? "INFO" : "ERROR",
      message:
        result.sent > 0
          ? `Password reset link emailed to ${user.username}`
          : `Password reset link could not be emailed to ${user.username}`,
      userId: user.id,
      ip,
      metadata: result.errors.length > 0 ? { errors: result.errors.slice(0, 3) } : undefined,
    });

    return NextResponse.json(GENERIC_RESPONSE);
  } catch (error) {
    // SMTP being unconfigured is an operator problem, not a hint about whether
    // the account exists — surface it plainly so the user stops retrying.
    if (error instanceof SmtpNotConfiguredError) {
      await logSystemEvent({
        category: "AUTH",
        type: "PASSWORD_RESET_UNAVAILABLE",
        severity: "ERROR",
        message: `Password reset requested but email is not available: ${error.message}`,
        ip,
      });
      return NextResponse.json(
        {
          error:
            "Password reset emails are unavailable right now. Please contact your administrator.",
        },
        { status: 503 }
      );
    }

    logApiError("AUTH_FORGOT_PASSWORD", error);
    return NextResponse.json({ error: "Internal server error." }, { status: 500 });
  }
}
