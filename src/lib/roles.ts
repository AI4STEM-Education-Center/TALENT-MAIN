/**
 * Account roles: the single source of truth for the strings stored on
 * `User.role`, their display labels and the routing/permission questions asked
 * about them.
 *
 * Pure and client-safe (no Prisma, no Node built-ins), so the proxy, server
 * routes and client components can all import it.
 *
 * - STUDENT    — joins via a class invitation link; never self-registers.
 * - TEACHER    — registers with an admin-issued invite code (or the legacy
 *                TEACHER_SIGNUP_TOKEN env var).
 * - RESEARCHER — "Research scientist": registers with an admin-issued invite
 *                code minted for that role. Lives in the admin dashboard with
 *                read-only access to research data (see canViewAdminData).
 * - ADMIN      — registers with the ADMIN_SIGNUP_TOKEN env var.
 */

export const ROLES = ["STUDENT", "TEACHER", "RESEARCHER", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const STUDENT = "STUDENT" satisfies Role;
export const TEACHER = "TEACHER" satisfies Role;
export const RESEARCHER = "RESEARCHER" satisfies Role;
export const ADMIN = "ADMIN" satisfies Role;

/** Human-readable role names for badges, headings and confirmation copy. */
export const ROLE_LABELS: Record<Role, string> = {
  STUDENT: "Student",
  TEACHER: "Teacher",
  RESEARCHER: "Research scientist",
  ADMIN: "Administrator",
};

/**
 * Roles an admin can mint an invite code for (TeacherRegistrationCode.role).
 * ADMIN is deliberately absent: admin accounts come only from the
 * ADMIN_SIGNUP_TOKEN env var, so a leaked code can never mint an admin.
 */
export const INVITE_CODE_ROLES = [TEACHER, RESEARCHER] as const;
export type InviteCodeRole = (typeof INVITE_CODE_ROLES)[number];

export function isRole(value: unknown): value is Role {
  return (
    typeof value === "string" && (ROLES as readonly string[]).includes(value)
  );
}

export function isInviteCodeRole(value: unknown): value is InviteCodeRole {
  return (
    typeof value === "string" &&
    (INVITE_CODE_ROLES as readonly string[]).includes(value)
  );
}

/** Display label for any stored role string; unknown values pass through. */
export function roleLabel(role: unknown): string {
  return isRole(role) ? ROLE_LABELS[role] : String(role ?? "");
}

export function isAdmin(role: unknown): role is typeof ADMIN {
  return role === ADMIN;
}

export function isResearcher(role: unknown): role is typeof RESEARCHER {
  return role === RESEARCHER;
}

/**
 * Whether the role may READ admin-dashboard data (research datasets, logs,
 * reports). True for ADMIN and RESEARCHER. Anything that changes state must
 * still check isAdmin.
 */
export function canViewAdminData(
  role: unknown,
): role is typeof ADMIN | typeof RESEARCHER {
  return role === ADMIN || role === RESEARCHER;
}

/** Where a signed-in user of this role lands (post-login and proxy redirects). */
export function homePathForRole(role: unknown): string {
  switch (role) {
    case ADMIN:
    case RESEARCHER:
      return "/admin";
    case TEACHER:
      return "/teacher";
    default:
      return "/student";
  }
}
