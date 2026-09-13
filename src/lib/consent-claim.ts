/**
 * The consent claim carried on the session JWT, and the single predicate that
 * decides whether it blocks a teacher.
 *
 * Deliberately dependency-free: src/proxy.ts imports this, so it must never
 * pull in Prisma (src/lib/consent.ts does) — while still keeping the meaning
 * of the claim in one place instead of a bare string literal in the proxy.
 */

/**
 * Stamped instead of a decision when the role has no active consent form
 * published at all. Distinct from `null` ("this user still owes us an
 * answer"), because the two need opposite handling: null gates a teacher,
 * NOT_REQUIRED must not — a deployment that hasn't published a form yet would
 * otherwise bounce every teacher between /teacher and /teacher/consent-required
 * forever (ERR_TOO_MANY_REDIRECTS), since that page has no form to show them.
 */
export const CONSENT_NOT_REQUIRED = "NOT_REQUIRED";

/**
 * Whether a TEACHER's session claim should block them out of instructor
 * tools. Only an explicit AGREE — or the absence of any published form —
 * lets them through; null (undecided) and DECLINE both gate.
 */
export function isTeacherConsentBlocked(
  decision: string | null | undefined,
): boolean {
  return decision !== "AGREE" && decision !== CONSENT_NOT_REQUIRED;
}
