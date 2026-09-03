import { prisma } from "@/lib/prisma";
import { APP_NAME } from "@/lib/email-purposes";
import { logSystemEvent } from "@/lib/system-log";

/**
 * Emails every administrator when a revoked ingestion token is used.
 *
 * A revoked token should never appear on the wire again — callers were shown
 * the replacement at mint time and told the old value is dead. A post-revoke
 * call therefore means the secret still lives somewhere it shouldn't (a stale
 * GitHub Actions secret, a forgotten pressure/.env, a pasted log), i.e. a
 * possible leak. The ingestion route still answers 401; this is the signal.
 *
 * Throttling is claimed atomically by pressure-token.ts before this function
 * runs, so concurrent or continuously looping callers cannot flood inboxes.
 * All sends are best-effort and never reject.
 */
export interface RevokedTokenUse {
  id: string;
  name: string;
  tokenPrefix: string;
  /** Uses since revocation *including* this one. */
  useCount: number;
  usedAt: Date;
  ip: string | null;
}

export async function notifyAdminsOfRevokedTokenUse(use: RevokedTokenUse): Promise<void> {
  try {
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { email: true },
    });
    const recipients = admins.map((admin) => admin.email);
    if (recipients.length === 0) return;

    // Lazy import so unit tests mocking @/lib/prisma for pressure-token don't
    // pay for nodemailer, and to keep the hot ingestion path light.
    const { getSmtpConfig, sendPurposeEmail } = await import("@/lib/email");
    const cfg = await getSmtpConfig().catch(() => null);
    if (!cfg || !cfg.isActive) {
      await logSystemEvent({
        category: "SYSTEM",
        type: "PRESSURE_TOKEN_REVOKED_USE",
        severity: "WARNING",
        message: `Revoked ingestion token "${use.name}" used (SMTP inactive — admin email skipped).`,
        ip: use.ip,
        metadata: { tokenId: use.id, tokenPrefix: use.tokenPrefix, useCount: use.useCount },
      });
      return;
    }

    const vars = {
      appName: APP_NAME,
      tokenName: use.name,
      tokenPrefix: use.tokenPrefix,
      usedAt: use.usedAt.toISOString(),
      ip: use.ip ?? "unknown",
      useCount: use.useCount,
    };
    await Promise.all(
      recipients.map(async (to) => {
        try {
          const result = await sendPurposeEmail("SECURITY_ALERT", to, vars);
          if (result.failed > 0) {
            console.error("[PressureTokenAlert] Failed to email admin", to, result.errors);
          }
        } catch (error) {
          console.error("[PressureTokenAlert] Failed to email admin", to, error);
        }
      })
    );
  } catch (error) {
    console.error("[PressureTokenAlert]", error);
  }
}
