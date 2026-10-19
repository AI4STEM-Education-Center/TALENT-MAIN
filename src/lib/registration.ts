import { timingSafeEqual } from "node:crypto";
import type { TeacherRegistrationCode } from "@prisma/client";
import {
  findTeacherCode,
  hasRedeemableTeacherCode,
} from "@/lib/teacher-registration-codes";
import { teacherCodeStatus, type TeacherCodeStatus } from "@/lib/teacher-codes";
import {
  ADMIN,
  TEACHER,
  isInviteCodeRole,
  type InviteCodeRole,
  type Role,
} from "@/lib/roles";

/**
 * Self-registration has one endpoint (POST /api/auth/register) and one input,
 * the invite code. Which kind of account it creates is decided by the code,
 * never by the registrant:
 *
 *   1. ADMIN_SIGNUP_TOKEN env var, exact match       → ADMIN
 *   2. TEACHER_SIGNUP_TOKEN env var, exact match     → TEACHER (legacy)
 *   3. an active admin-minted TeacherRegistrationCode → that code's role
 *      (TEACHER or RESEARCHER)
 *
 * Students never self-register; they join through class invitation links.
 */

/** Same text for a wrong code, an expired one and a used-up one. */
export const INVALID_INVITE_CODE = "Invalid or expired invite code.";

export const REGISTRATION_NOT_CONFIGURED =
  "Registration is not configured on this server.";

export type InviteResolution =
  | { ok: true; role: Role; source: "ADMIN_ENV" | "TEACHER_ENV"; code: null }
  | {
      ok: true;
      role: InviteCodeRole;
      source: "CODE";
      code: TeacherRegistrationCode;
    }
  | { ok: false; reason: "NOT_CONFIGURED" }
  | {
      ok: false;
      reason: "INVALID";
      /** The matched row when it exists but isn't usable, for logging only. */
      code: TeacherRegistrationCode | null;
      status: Exclude<TeacherCodeStatus, "ACTIVE"> | "UNKNOWN" | "BAD_ROLE";
    };

/**
 * The invite code from a request body. `inviteCode` is the current key;
 * `teacherToken` and `adminToken` are what the old /register and
 * /admin-register forms sent, still accepted so cached clients keep working.
 */
export function submittedInviteCode(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  for (const key of ["inviteCode", "teacherToken", "adminToken"]) {
    const value = b[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/** Constant-time string equality; false when `expected` is unset/empty. */
export function tokenMatches(
  submitted: string,
  expected: string | undefined,
): boolean {
  if (!expected || !submitted) return false;
  const a = Buffer.from(submitted, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual needs equal lengths. The length check leaks only the
  // length of the secret, which a random token doesn't make useful.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Map a typed invite code to the account role it authorizes. */
export async function resolveInviteCode(
  submitted: string,
  env: {
    ADMIN_SIGNUP_TOKEN?: string;
    TEACHER_SIGNUP_TOKEN?: string;
  } = {
    ADMIN_SIGNUP_TOKEN: process.env.ADMIN_SIGNUP_TOKEN,
    TEACHER_SIGNUP_TOKEN: process.env.TEACHER_SIGNUP_TOKEN,
  },
  now: Date = new Date(),
): Promise<InviteResolution> {
  const adminToken = env.ADMIN_SIGNUP_TOKEN || undefined;
  const teacherToken = env.TEACHER_SIGNUP_TOKEN || undefined;

  // Env tokens are compared before any database work, so a deployment still
  // on env tokens does no extra query per attempt.
  if (tokenMatches(submitted, adminToken)) {
    return { ok: true, role: ADMIN, source: "ADMIN_ENV", code: null };
  }
  if (tokenMatches(submitted, teacherToken)) {
    return { ok: true, role: TEACHER, source: "TEACHER_ENV", code: null };
  }

  if (!adminToken && !teacherToken && !(await hasRedeemableTeacherCode(now))) {
    return { ok: false, reason: "NOT_CONFIGURED" };
  }

  const code = submitted ? await findTeacherCode(submitted) : null;
  if (!code) {
    return { ok: false, reason: "INVALID", code: null, status: "UNKNOWN" };
  }
  const status = teacherCodeStatus(code, now);
  if (status !== "ACTIVE") {
    return { ok: false, reason: "INVALID", code, status };
  }
  // A row edited by hand to some other role must not mint an account with it
  // (in particular never ADMIN).
  if (!isInviteCodeRole(code.role)) {
    return { ok: false, reason: "INVALID", code, status: "BAD_ROLE" };
  }
  return { ok: true, role: code.role, source: "CODE", code };
}
