import { randomBytes } from "node:crypto";
import type { Prisma, TeacherRegistrationCode } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  MAX_LABEL_LENGTH,
  formatTeacherCode,
  normalizeTeacherCode,
  teacherCodeStatus,
  type TeacherCodeView,
} from "@/lib/teacher-codes";

/**
 * Admin-issued teacher registration codes — the server half (crypto + database).
 * The client-safe string/limit helpers live in src/lib/teacher-codes.ts.
 *
 * Teacher self-registration used to accept exactly one value, the
 * TEACHER_SIGNUP_TOKEN env var: rotating it meant a redeploy, it never expired,
 * and it could be reused forever by anyone it had ever been shared with. Codes
 * are now rows an admin mints in the panel, each with its own expiry and use
 * limit, and each revocable on its own.
 *
 * The env var still works when it is set, so existing deployments keep
 * registering teachers across the upgrade; see src/app/api/auth/register.
 */

/**
 * A fresh code in canonical (dash-free, upper-case) form.
 *
 * This is a BEARER CREDENTIAL — whoever holds it can create a TEACHER account —
 * so it comes from crypto.randomBytes rather than a `cuid()` schema default;
 * see the note on TeacherRegistrationCode in prisma/schema.prisma.
 */
export function generateTeacherCode(): string {
  // One byte per symbol, reduced mod 32: 32 divides 256, so every symbol stays
  // equally likely and there is no rejection loop to get wrong.
  const bytes = randomBytes(CODE_LENGTH);
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return code;
}

export function toTeacherCodeView(
  row: TeacherRegistrationCode,
  origin: string,
  now: Date = new Date()
): TeacherCodeView {
  return {
    id: row.id,
    code: formatTeacherCode(row.code),
    url: `${origin}/register?code=${encodeURIComponent(row.code)}`,
    label: row.label,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    maxUses: row.maxUses,
    usedCount: row.usedCount,
    active: row.active,
    status: teacherCodeStatus(row, now),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/**
 * Mint a code, retrying on the (practically impossible) chance that 80 random
 * bits collide with an existing row rather than surfacing a P2002 to the admin.
 */
export async function createTeacherCode(input: {
  label?: string | null;
  expiresInMinutes?: number | null;
  maxUses?: number | null;
  createdById?: string | null;
}): Promise<TeacherRegistrationCode> {
  const expiresAt = input.expiresInMinutes
    ? new Date(Date.now() + input.expiresInMinutes * 60_000)
    : null;

  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await prisma.teacherRegistrationCode.create({
        data: {
          code: generateTeacherCode(),
          label: input.label?.trim() ? input.label.trim().slice(0, MAX_LABEL_LENGTH) : null,
          expiresAt,
          maxUses: input.maxUses ?? null,
          createdById: input.createdById ?? null,
        },
      });
    } catch (err) {
      lastError = err;
      if ((err as { code?: string })?.code !== "P2002") throw err;
    }
  }
  throw lastError ?? new Error("Could not generate a unique registration code.");
}

/**
 * Look up a typed code. Returns the row whatever its status, so the caller can
 * tell "no such code" from "expired" when it decides what to log — the
 * registrant is always told the same thing.
 */
export async function findTeacherCode(rawCode: string): Promise<TeacherRegistrationCode | null> {
  const normalized = normalizeTeacherCode(rawCode);
  if (!normalized) return null;
  return prisma.teacherRegistrationCode.findUnique({ where: { code: normalized } });
}

/**
 * True when at least one code could plausibly be redeemed, i.e. teacher signup
 * is open even without TEACHER_SIGNUP_TOKEN. Exhaustion is not checked here:
 * SQLite cannot compare usedCount to maxUses in a filter, and an exhausted code
 * should read as "wrong code" rather than "server not configured" anyway.
 */
export async function hasRedeemableTeacherCode(now: Date = new Date()): Promise<boolean> {
  const count = await prisma.teacherRegistrationCode.count({
    where: { active: true, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
  });
  return count > 0;
}

/** Thrown when a code lost its last slot between the preflight read and the claim. */
export class TeacherCodeUnavailableError extends Error {
  constructor() {
    super("Teacher registration code is no longer available.");
    this.name = "TeacherCodeUnavailableError";
  }
}

/**
 * Consume one use of a code inside the caller's transaction.
 *
 * SECURITY: claiming the slot and creating the account must be one transaction,
 * or two concurrent registrations both pass the preflight check and a
 * single-use code mints two teachers. The re-read plus the `usedCount` guard in
 * the WHERE clause make the increment a compare-and-swap, so the loser of a
 * race updates zero rows and is rejected — the same shape as the class-invite
 * claim in src/app/api/invitations/[token]/route.ts.
 */
export async function claimTeacherCode(
  tx: Prisma.TransactionClient,
  id: string,
  now: Date = new Date()
): Promise<void> {
  const current = await tx.teacherRegistrationCode.findUnique({ where: { id } });
  if (!current || teacherCodeStatus(current, now) !== "ACTIVE") {
    throw new TeacherCodeUnavailableError();
  }

  const claimed = await tx.teacherRegistrationCode.updateMany({
    where: { id, active: true, usedCount: current.usedCount },
    data: { usedCount: { increment: 1 }, lastUsedAt: now },
  });
  if (claimed.count !== 1) throw new TeacherCodeUnavailableError();
}
