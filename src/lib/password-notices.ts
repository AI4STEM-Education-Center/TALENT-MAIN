import { appOrigin } from "@/lib/app-url";
import { sendPurposeEmail, SmtpNotConfiguredError } from "@/lib/email";
import { logSystemEvent } from "@/lib/system-log";

/**
 * The "your password was changed" security notice, sent after both a
 * self-service change and a completed reset.
 *
 * Always best-effort: the password has already changed by the time this runs,
 * so a missing or failing SMTP server is logged and swallowed rather than
 * surfaced as a failure the user can't act on. Returns whether the mail went out.
 */
export async function sendPasswordChangedNotice(
  req: Request,
  user: {
    id: string;
    email: string;
    username: string;
    firstName: string;
    lastName: string;
  },
): Promise<boolean> {
  try {
    const result = await sendPurposeEmail("PASSWORD_CHANGED", user.email, {
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      changedAt:
        new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC",
      resetRequestUrl: `${appOrigin(req)}/forgot-password`,
    });
    if (result.sent > 0) return true;

    await logSystemEvent({
      category: "AUTH",
      type: "PASSWORD_CHANGED_NOTICE_FAILED",
      severity: "WARNING",
      message: `Could not email the password-change notice to ${user.username}`,
      userId: user.id,
      metadata: { errors: result.errors.slice(0, 3) },
    });
    return false;
  } catch (error) {
    await logSystemEvent({
      category: "AUTH",
      type: "PASSWORD_CHANGED_NOTICE_FAILED",
      severity: error instanceof SmtpNotConfiguredError ? "INFO" : "WARNING",
      message: `Could not email the password-change notice to ${user.username}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      userId: user.id,
    });
    return false;
  }
}
