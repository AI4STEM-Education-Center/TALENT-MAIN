import { prisma } from "@/lib/prisma";

/**
 * Shared types + pure/impure helpers for the IRB research-consent feature.
 * See docs/plans/consent-compliance-plan.md for the full design.
 *
 * Storage is deliberately minimal: a ConsentRecord never duplicates the legal
 * text (that lives once per ConsentFormVersion) and never stores a rendered
 * signature image (drawn initials/signatures are small vector stroke-path
 * JSON — see normalizeStrokeData). PDFs are generated on demand from these
 * rows by src/lib/consent-pdf.ts and are never persisted for one signature.
 */

export const CONSENT_ROLES = ["STUDENT", "TEACHER"] as const;
export type ConsentRole = (typeof CONSENT_ROLES)[number];

export function isConsentRole(value: unknown): value is ConsentRole {
  return typeof value === "string" && (CONSENT_ROLES as readonly string[]).includes(value);
}

export const CONSENT_DECISIONS = ["AGREE", "DECLINE"] as const;
export type ConsentDecision = (typeof CONSENT_DECISIONS)[number];

export function isConsentDecision(value: unknown): value is ConsentDecision {
  return typeof value === "string" && (CONSENT_DECISIONS as readonly string[]).includes(value);
}

export const DEVICE_TYPES = ["desktop", "mobile", "tablet", "unknown"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

/**
 * Coarse device classification from the User-Agent header, captured once at
 * signing time for the audit record. Deliberately a small regex helper rather
 * than a full UA-parsing dependency — this app prefers small custom utilities
 * for narrow needs (see clientIp in src/lib/rate-limit.ts).
 */
export function parseDeviceType(userAgent: string | null | undefined): DeviceType {
  if (!userAgent) return "unknown";
  const ua = userAgent.toLowerCase();
  if (!ua.trim()) return "unknown";
  if (/ipad|tablet|nexus 7|nexus 9|nexus 10|kindle|playbook|(android(?!.*mobile))/.test(ua)) {
    return "tablet";
  }
  if (/mobi|iphone|ipod|android|blackberry|windows phone/.test(ua)) return "mobile";
  if (/windows|macintosh|mac os x|linux|x11|cros/.test(ua)) return "desktop";
  return "unknown";
}

/**
 * Signature/initials capture is stored as vector stroke-path data (the shape
 * signature_pad's `toData()` produces — an array of point groups) rather than
 * a rendered image, keeping a drawn signature at a few hundred bytes to a
 * couple KB instead of tens of KB as a PNG. This only validates shape + a
 * generous size ceiling; it does not interpret the points.
 *
 * Returns the normalized JSON string to store, or null for "nothing drawn"
 * (a typed-only signature is valid — the consent form's own text treats a
 * typed name as a full legal signature).
 *
 * Throws when the payload is present but implausibly large, so a malformed or
 * abusive client payload is rejected with a clear 400 rather than silently
 * accepted or silently dropped.
 */
export const MAX_STROKE_DATA_BYTES = 40_000;

export function normalizeStrokeData(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;

  let serialized: string;
  try {
    serialized = typeof raw === "string" ? raw : JSON.stringify(raw);
  } catch {
    return null;
  }
  if (!serialized || serialized === "null" || serialized === "[]") return null;
  if (serialized.length > MAX_STROKE_DATA_BYTES) {
    throw new Error("Signature data is too large.");
  }

  try {
    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
  } catch {
    return null;
  }
  return serialized;
}

/** The single active form version for a role, or null if none is published yet. */
export async function getActiveConsentVersion(role: ConsentRole) {
  return prisma.consentFormVersion.findFirst({
    where: { role, isActive: true },
    orderBy: { createdAt: "desc" },
  });
}

export interface ConsentClaim {
  /** The ConsentFormVersion.version the user last decided on for this role. */
  version: string;
  decision: ConsentDecision;
}

/**
 * What to stamp on a session's JWT at sign-in and on an explicit
 * `update()` refresh (see src/lib/auth.ts). Null means "nothing to enforce
 * yet" — either the role has no published form (misconfiguration; treated as
 * open) or this user hasn't decided on the currently active version.
 *
 * Deliberately NOT called from src/proxy.ts on every request: proxy.ts only
 * ever reads the JWT claim it already carries (no Prisma/DB access there),
 * consistent with how the existing role guards work today. A brand-new form
 * version therefore takes effect for an already-signed-in user at their next
 * sign-in or session refresh, not instantly mid-session — the same
 * eventual-consistency tradeoff the profile-rename flow already accepts.
 */
export async function getUserConsentClaim(
  userId: string,
  role: ConsentRole
): Promise<ConsentClaim | null> {
  const active = await getActiveConsentVersion(role);
  if (!active) return null;

  const record = await prisma.consentRecord.findFirst({
    where: { userId, formVersionId: active.id },
    orderBy: { signedAt: "desc" },
    select: { decision: true },
  });
  if (!record || !isConsentDecision(record.decision)) return null;

  return { version: active.version, decision: record.decision };
}

/**
 * Gates the research-telemetry write paths ONLY — never grading. Concretely:
 * SimulationSession creation, and the exam-results-engine's summary /
 * recommendation / misconception-labeling generation. Quiz attempts, scores,
 * answers, and manual grades are always collected for every student
 * regardless of this check (see docs/plans/consent-compliance-plan.md §9).
 *
 * Checked against the CURRENTLY ACTIVE student form version specifically —
 * an AGREE recorded under a since-superseded version does not carry over, so
 * publishing an amended form pauses telemetry collection for a student until
 * they explicitly agree again under the new text.
 *
 * Defaults to false (no active form, or no AGREE decision on file) so a gap
 * or misconfiguration fails closed rather than silently collecting data.
 */
export async function hasResearchConsent(studentUserId: string): Promise<boolean> {
  const active = await getActiveConsentVersion("STUDENT");
  if (!active) return false;

  const record = await prisma.consentRecord.findFirst({
    where: { userId: studentUserId, formVersionId: active.id },
    orderBy: [{ signedAt: "desc" }, { id: "desc" }],
    select: { decision: true },
  });
  return record?.decision === "AGREE";
}

/** Collapse newest-first consent rows to the current decision for each email. */
export function latestConsentDecisionsByEmail(
  records: ReadonlyArray<{ signerEmailSnapshot: string; decision: string }>
): Map<string, ConsentDecision> {
  const latest = new Map<string, ConsentDecision>();
  for (const record of records) {
    const email = record.signerEmailSnapshot.trim().toLowerCase();
    if (email && !latest.has(email) && isConsentDecision(record.decision)) {
      latest.set(email, record.decision);
    }
  }
  return latest;
}

/** Display name for a device type, used in the admin browse/preview UI. */
export function formatDeviceType(deviceType: string): string {
  switch (deviceType) {
    case "desktop":
      return "Desktop";
    case "mobile":
      return "Mobile";
    case "tablet":
      return "Tablet";
    default:
      return "Unknown";
  }
}
