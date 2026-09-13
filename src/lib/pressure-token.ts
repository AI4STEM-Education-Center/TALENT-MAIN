import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";

export const REVOKED_TOKEN_ALERT_THROTTLE_MS = 60 * 60 * 1_000;

/**
 * Bearer tokens for machine-to-machine pressure/API result ingestion.
 *
 * Tokens are minted in Admin -> Pressure Tests and stored only as SHA-256
 * digests, so a deployment needs no PRESSURE_RESULTS_TOKEN in its environment:
 * whatever the admin generated in that site's web UI is what that site accepts.
 * A plain digest (rather than a slow KDF) is the right fit here because the
 * secret is 32 bytes of CSPRNG output, not a user-chosen password, and the
 * lookup happens on every ingest request.
 */

const TOKEN_PREFIX = "ptr_";
const TOKEN_BYTES = 32;

/** Length of the leading, non-secret slice kept for display in the admin list. */
const DISPLAY_PREFIX_LENGTH = TOKEN_PREFIX.length + 6;

export function generatePressureToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

export function hashPressureToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function pressureTokenPrefix(token: string): string {
  return token.slice(0, DISPLAY_PREFIX_LENGTH);
}

/** Extracts the credential from an `Authorization: Bearer <token>` header. */
export function bearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const [scheme, ...rest] = authorization.split(" ");
  if (scheme.toLowerCase() !== "bearer") return null;
  const token = rest.join(" ").trim();
  return token.length > 0 ? token : null;
}

/**
 * Resolves a bearer credential to a live token record, or null when the header
 * is absent, unknown, or revoked. Looking the digest up by unique index means
 * the comparison never walks the stored secrets, so there is no timing signal
 * to leak. `lastUsedAt` is refreshed opportunistically and never blocks auth.
 *
 * A revoked token still returns null (the caller answers 401), but the attempt
 * is counted on the row and surfaced: the admin token list highlights tokens
 * used after revocation, a SystemLog WARNING is written, and every admin is
 * emailed (throttled to one mail per token per hour) — a post-revoke call
 * means the secret still lives somewhere, i.e. a possible leak.
 */
export async function verifyPressureToken(
  authorization: string | null,
  opts?: { ip?: string | null },
): Promise<{ id: string; name: string } | null> {
  const token = bearerToken(authorization);
  if (!token) return null;

  const record = await prisma.pressureResultToken.findUnique({
    where: { tokenHash: hashPressureToken(token) },
    select: {
      id: true,
      name: true,
      tokenPrefix: true,
      revokedAt: true,
      revokedUseCount: true,
    },
  });
  if (!record) return null;
  if (record.revokedAt) {
    await recordRevokedTokenUse(record, opts?.ip ?? null);
    return null;
  }

  await prisma.pressureResultToken
    .update({ where: { id: record.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return { id: record.id, name: record.name };
}

/**
 * Counts a post-revocation use, logs it, and alerts admins. Best-effort: a
 * logging/email failure must never turn a 401 into a 500 or slow ingestion.
 */
async function recordRevokedTokenUse(
  record: {
    id: string;
    name: string;
    tokenPrefix: string;
    revokedUseCount: number;
  },
  ip: string | null,
): Promise<void> {
  const usedAt = new Date();
  let useCount = (record.revokedUseCount ?? 0) + 1;

  try {
    const updated = await prisma.pressureResultToken.update({
      where: { id: record.id },
      data: {
        revokedUseCount: { increment: 1 },
        lastRevokedUseAt: usedAt,
        lastRevokedIp: ip,
      },
      select: { revokedUseCount: true },
    });
    useCount = updated.revokedUseCount;
  } catch {
    // Counting must not block auth.
  }

  // Claim this token's hourly alert window with one conditional write. Unlike
  // throttling against lastRevokedUseAt, a dedicated timestamp permits a fresh
  // alert every hour even when the leaked token is used continuously. The
  // conditional update also ensures concurrent requests cannot all send mail.
  let shouldAlert = false;
  try {
    const alertCutoff = new Date(
      usedAt.getTime() - REVOKED_TOKEN_ALERT_THROTTLE_MS,
    );
    const claim = await prisma.pressureResultToken.updateMany({
      where: {
        id: record.id,
        OR: [
          { lastRevokedAlertAt: null },
          { lastRevokedAlertAt: { lte: alertCutoff } },
        ],
      },
      data: { lastRevokedAlertAt: usedAt },
    });
    shouldAlert = claim.count === 1;
  } catch {
    // Alerting is best-effort.
  }

  try {
    const { logSystemEvent } = await import("@/lib/system-log");
    await logSystemEvent({
      category: "AUTH",
      type: "PRESSURE_TOKEN_REVOKED_USE",
      severity: "WARNING",
      message: `Revoked ingestion token "${record.name}" was used (possible leak).`,
      ip,
      metadata: {
        tokenId: record.id,
        tokenPrefix: record.tokenPrefix,
        useCount,
        usedAt: usedAt.toISOString(),
      },
    });
  } catch {
    // Logging is best-effort.
  }

  if (shouldAlert) {
    try {
      const { notifyAdminsOfRevokedTokenUse } =
        await import("./pressure-token-alert");
      // Await completion so a serverless request cannot be torn down while the
      // notification promise is still in flight. Only the hourly claimant pays
      // this cost; every other revoked request returns immediately after logging.
      await notifyAdminsOfRevokedTokenUse({
        id: record.id,
        name: record.name,
        tokenPrefix: record.tokenPrefix,
        useCount,
        usedAt,
        ip,
      });
    } catch {
      // Alerting is best-effort.
    }
  }
}
