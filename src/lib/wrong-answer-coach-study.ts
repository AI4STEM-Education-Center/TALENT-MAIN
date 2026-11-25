// De-identified study codes and IRB consent snapshot helpers for Wrong Answer
// Coach. Stored exclusively in StudentStudyCode & WrongAnswerCoachResearchMeta
// (admin-only tables; never returned to teachers).

import { randomBytes } from "node:crypto";
import { prisma } from "./prisma";
import {
  getActiveConsentVersion,
  hasResearchConsent,
  isConsentDecision,
} from "./consent";

const STUDY_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

function generateRandomStudyCode(): string {
  const bytes = randomBytes(6);
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += STUDY_CODE_ALPHABET[bytes[i] % STUDY_CODE_ALPHABET.length];
  }
  return `S-${suffix}`;
}

/**
 * Look up or create a random, non-sequential study code (e.g. "S-7K4M2P") for
 * a student User. Handles unique collisions and concurrent creation races.
 */
export async function getOrCreateStudentStudyCode(
  userId: string,
): Promise<string> {
  const existing = await prisma.studentStudyCode.findUnique({
    where: { userId },
    select: { studyCode: true },
  });
  if (existing) return existing.studyCode;

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateRandomStudyCode();
    try {
      const created = await prisma.studentStudyCode.create({
        data: { userId, studyCode: candidate },
        select: { studyCode: true },
      });
      return created.studyCode;
    } catch {
      const raced = await prisma.studentStudyCode.findUnique({
        where: { userId },
        select: { studyCode: true },
      });
      if (raced) return raced.studyCode;
    }
  }
  throw new Error("Could not allocate a unique student study code.");
}

export interface StudentConsentSnapshot {
  consentStatus: "AGREE" | "DECLINE" | "NONE";
  consentFormVersion: string | null;
  hasActiveAgreement: boolean;
}

/**
 * Read the student's current IRB consent status against the currently active
 * STUDENT form version, using the exact same ordering/tie-breaking semantics
 * as `hasResearchConsent()` in `src/lib/consent.ts`.
 */
export async function getStudentConsentSnapshot(
  studentUserId: string,
): Promise<StudentConsentSnapshot> {
  const active = await getActiveConsentVersion("STUDENT");
  if (!active) {
    return {
      consentStatus: "NONE",
      consentFormVersion: null,
      hasActiveAgreement: false,
    };
  }

  const record = await prisma.consentRecord.findFirst({
    where: { userId: studentUserId, formVersionId: active.id },
    orderBy: [{ signedAt: "desc" }, { id: "desc" }],
    select: { decision: true },
  });

  if (!record || !isConsentDecision(record.decision)) {
    return {
      consentStatus: "NONE",
      consentFormVersion: active.version,
      hasActiveAgreement: false,
    };
  }

  return {
    consentStatus: record.decision,
    consentFormVersion: active.version,
    hasActiveAgreement: record.decision === "AGREE",
  };
}

/**
 * Whether this student is permitted to enter the Wrong Answer Coach under the
 * active consent policy.
 *
 * Defaults to **educational parity** (all enrolled students may use the Coach
 * equally; actual consent is recorded ONLY in admin-only
 * `WrongAnswerCoachResearchMeta` and enforced strictly at export time). This
 * prevents teachers from inferring student research consent from the Coach
 * review queue and avoids giving non-consenting students a bypass around the
 * diagnostic check.
 *
 * Set `COACH_REQUIRE_CONSENT=true` only if an IRB protocol explicitly requires
 * hard write-time gating (in which case teachers must not view named lists).
 */
export async function isCoachConsentEligible(
  studentUserId: string,
): Promise<boolean> {
  if (process.env.COACH_REQUIRE_CONSENT === "true") {
    return hasResearchConsent(studentUserId);
  }
  return true;
}
