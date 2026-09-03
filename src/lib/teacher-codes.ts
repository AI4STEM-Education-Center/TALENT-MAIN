/**
 * Teacher registration code helpers that are safe to import from a client
 * component: string shaping, status naming and the admin-facing limits.
 *
 * Everything that touches crypto or the database lives in
 * src/lib/teacher-registration-codes.ts, so bundling the /register form or the
 * admin panel doesn't drag `node:crypto` and the Prisma client into the browser.
 */

/**
 * Crockford-style base32: 32 symbols, so five random bits map to one character
 * with no modulo bias, minus the I/L/O/U that get misread when a code is typed
 * off a slide or read down a phone.
 */
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Symbols per code. 16 × 5 bits = 80 bits of entropy. */
export const CODE_LENGTH = 16;

/** Characters per dash-separated group in the display form. */
const GROUP_SIZE = 4;

/** Longest input we will even try to normalize, so a huge body can't be scanned. */
const MAX_INPUT_LENGTH = 200;

export const MAX_LABEL_LENGTH = 100;

/** Bounds on the admin-supplied duration: 5 minutes to 5 years. */
export const MIN_EXPIRES_IN_MINUTES = 5;
export const MAX_EXPIRES_IN_MINUTES = 5 * 365 * 24 * 60;

/** Bound on the admin-supplied use limit. */
export const MAX_USES_LIMIT = 100_000;

/**
 * Fold a typed code back to the stored form: upper-cased, punctuation and
 * whitespace dropped, and the ambiguous glyphs excluded from CODE_ALPHABET
 * mapped onto the character they are usually mistaken for. So "ol1i-2345" and
 * "0L11 2345" both look up the same row as "01112345".
 */
export function normalizeTeacherCode(input: string): string {
  return input
    .slice(0, MAX_INPUT_LENGTH)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/[OU]/g, "0");
}

/** Group the stored code into dash-separated quads for display and copying. */
export function formatTeacherCode(code: string): string {
  return code.match(new RegExp(`.{1,${GROUP_SIZE}}`, "g"))?.join("-") ?? code;
}

export type TeacherCodeStatus = "ACTIVE" | "REVOKED" | "EXPIRED" | "EXHAUSTED";

/** What a code's status means, for the admin panel's badge tooltip. */
export const TEACHER_CODE_STATUS_LABELS: Record<TeacherCodeStatus, string> = {
  ACTIVE: "Usable",
  REVOKED: "Switched off by an administrator",
  EXPIRED: "Past its expiry",
  EXHAUSTED: "Used up to its limit",
};

/** The fields teacherCodeStatus needs — a row, or the panel's view of one. */
export interface TeacherCodeLimits {
  active: boolean;
  expiresAt: Date | null;
  maxUses: number | null;
  usedCount: number;
}

/**
 * Why a code cannot be redeemed, or "ACTIVE" if it can. Revocation is reported
 * ahead of expiry/exhaustion because it is the state an admin chose, and the
 * one they can undo.
 */
export function teacherCodeStatus(
  code: TeacherCodeLimits,
  now: Date = new Date(),
): TeacherCodeStatus {
  if (!code.active) return "REVOKED";
  if (code.expiresAt && code.expiresAt <= now) return "EXPIRED";
  if (code.maxUses !== null && code.usedCount >= code.maxUses)
    return "EXHAUSTED";
  return "ACTIVE";
}

/** The shape the admin panel and the code-issuing response render. */
export interface TeacherCodeView {
  id: string;
  /** Display form (dash-separated). The raw code, since an admin must re-share it. */
  code: string;
  /** Absolute /register link that pre-fills the code, ready to copy. */
  url: string;
  label: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  usedCount: number;
  active: boolean;
  status: TeacherCodeStatus;
  createdAt: string;
  lastUsedAt: string | null;
}
