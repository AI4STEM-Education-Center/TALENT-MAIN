import crypto from "crypto";
import { prisma } from "@/lib/prisma";

/**
 * Password reset tokens.
 *
 * The raw token only ever exists in the email we send; the database stores its
 * SHA-256 hash, so a leaked backup can't be replayed into account takeover.
 * Issuing a token invalidates the user's outstanding ones, and consuming a
 * token marks it used inside the same transaction as the password write, so a
 * link can't be redeemed twice.
 */

export const RESET_TOKEN_TTL_MINUTES = 60;

/** How many reset requests one account may trigger inside RESET_REQUEST_WINDOW_MS. */
export const MAX_RESET_REQUESTS_PER_USER = 5;
export const RESET_REQUEST_WINDOW_MS = 60 * 60 * 1000;

/** 32 random bytes, url-safe base64 — 256 bits of entropy in a copy-pasteable link. */
export function generateResetToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function resetTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);
}

/**
 * Issue a fresh token for a user, invalidating any still-valid ones so only the
 * newest email works. Returns the raw token for the email body.
 */
export async function issueResetToken(
  userId: string,
  requestIp: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateResetToken();
  const expiresAt = resetTokenExpiry();

  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.passwordResetToken.create({
      data: { userId, tokenHash: hashResetToken(token), expiresAt, requestIp },
    }),
  ]);

  return { token, expiresAt };
}

/**
 * Per-account throttle so an attacker can't use the (deliberately
 * enumeration-proof) forgot-password endpoint to mail-bomb one user. The
 * per-IP limit lives in the route; this bounds a single mailbox.
 */
export async function resetRequestsExhausted(userId: string): Promise<boolean> {
  const since = new Date(Date.now() - RESET_REQUEST_WINDOW_MS);
  const recent = await prisma.passwordResetToken.count({
    where: { userId, createdAt: { gte: since } },
  });
  return recent >= MAX_RESET_REQUESTS_PER_USER;
}

export type ResetTokenLookup =
  | { ok: true; tokenId: string; userId: string }
  | { ok: false; reason: "unknown" | "used" | "expired" };

/** Resolve a raw token to its (still valid) grant. */
export async function findValidResetToken(
  rawToken: string,
  now: Date = new Date(),
): Promise<ResetTokenLookup> {
  if (!rawToken) return { ok: false, reason: "unknown" };

  const record = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(rawToken) },
  });
  if (!record) return { ok: false, reason: "unknown" };
  if (record.usedAt) return { ok: false, reason: "used" };
  if (record.expiresAt <= now) return { ok: false, reason: "expired" };

  return { ok: true, tokenId: record.id, userId: record.userId };
}

/**
 * Set the new password and burn the token atomically. The conditional
 * updateMany (usedAt: null) makes concurrent redemptions of the same link
 * race-safe: the loser updates 0 rows and the transaction is rolled back.
 */
export async function consumeResetToken(
  tokenId: string,
  userId: string,
  hashedPassword: string,
): Promise<boolean> {
  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.passwordResetToken.updateMany({
        where: { id: tokenId, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) throw new Error("TOKEN_ALREADY_USED");

      await tx.user.update({ where: { id: userId }, data: { hashedPassword } });
      // Any other outstanding links for this account are void once the
      // password changes.
      await tx.passwordResetToken.updateMany({
        where: { userId, usedAt: null },
        data: { usedAt: new Date() },
      });
    });
    return true;
  } catch (error) {
    if (error instanceof Error && error.message === "TOKEN_ALREADY_USED")
      return false;
    throw error;
  }
}

/** Void every outstanding link for a user (used when they change their own password). */
export async function invalidateResetTokens(userId: string): Promise<void> {
  await prisma.passwordResetToken.updateMany({
    where: { userId, usedAt: null },
    data: { usedAt: new Date() },
  });
}
