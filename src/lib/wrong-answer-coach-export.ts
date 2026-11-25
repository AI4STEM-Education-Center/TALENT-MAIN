// Admin-only de-identified IRB research export for Wrong Answer Coach.
// Enforces:
// - Consenting students ONLY (WrongAnswerCoachResearchMeta.consentStatus === "AGREE"
//   AND live hasResearchConsent verification by default).
// - Explicit Table 6 allowlist projection (never raw Prisma rows).
// - HMAC-SHA256 pseudonymized cohort/session/attempt/class/quiz/question IDs.
// - Automated PII redaction pass on free text (emails, student IDs, enrolled
//   roster names), plus explicit opt-in raw mode for IRB-authorized human coders.
// - RFC 4180 + spreadsheet-formula-safe CSV serialization.

import { createHmac } from "node:crypto";
import { prisma } from "./prisma";
import { hasResearchConsent } from "./consent";
import type { Check2RunSlot, CoachFlagCode } from "./wrong-answer-coach-types";

function getPseudonymSecret(): string {
  const secret =
    process.env.COACH_EXPORT_HMAC_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET;
  if (secret && secret.trim()) {
    return secret;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "COACH_EXPORT_HMAC_SECRET (or AUTH_SECRET) must be configured in production for research exports.",
    );
  }
  return "talent-coach-dev-test-only-key";
}

export function pseudonymizeId(namespace: string, rawId: string): string {
  const digest = createHmac("sha256", getPseudonymSecret())
    .update(`${namespace}:${rawId}`)
    .digest("hex")
    .slice(0, 16);
  return `${namespace}_${digest}`;
}

const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const LONG_ID_RE = /\b\d{8,10}\b/g; // e.g. 9-digit university IDs
const DASHED_ID_RE = /\b\d{3}-\d{3}-\d{3}\b/g; // dashed 9-digit university IDs
const PHONE_RE = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Redact emails, numeric/dashed student IDs, phone numbers, and known student
 * names from free-text research fields.
 */
export function redactFreeText(
  text: string | null | undefined,
  knownNames: readonly string[] = [],
): string | null {
  if (text == null) return null;
  let out = text
    .replace(EMAIL_RE, "[REDACTED_EMAIL]")
    .replace(PHONE_RE, "[REDACTED_PHONE]")
    .replace(DASHED_ID_RE, "[REDACTED_ID]")
    .replace(LONG_ID_RE, "[REDACTED_ID]");

  for (const name of knownNames) {
    const clean = name.trim();
    if (clean.length < 3) continue;
    const re = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegex(clean)}(?![\\p{L}\\p{N}])`,
      "giu",
    );
    out = out.replace(re, "[REDACTED_NAME]");
  }
  return out;
}

/**
 * RFC 4180 CSV cell escaping with spreadsheet-formula neutralization
 * (prefixes leading =, +, -, @, tab, CR, LF on strings with a single quote).
 */
export function formatCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  let str =
    typeof value === "string"
      ? value
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (/^[\t\r\n]*[=+\-@]|^[\t\r\n]/.test(str)) {
    str = `'${str}`;
  }
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export interface CoachExportRecord {
  sessionId: string;
  attemptId: string;
  classId: string;
  quizId: string;
  questionId: string;
  questionNumber: number;
  studentStudyCode: string;
  consentStatus: "AGREE";
  consentFormVersion: string | null;
  protocolRevision: string;
  containsUnredactedFreeText: boolean;
  priorSessionCountForQuestion: number;
  state: string;
  endedReason: string | null;
  startedAt: string;
  completedAt: string | null;
  chosenOptionText: string;
  check1Label: string | null;
  explanationText: string | null;
  check2ShortCircuitReason: string | null;
  check2Runs: Array<{
    runIndex: number;
    valid: boolean;
    retried: boolean;
    choice: string | null;
    parsedKind: string;
    misconceptionCode: string | null;
    confidence: number | null;
    probabilities: Array<{ value: string; probability: number }>;
    latencyMs: number;
  }>;
  check2ResultKind: string | null;
  check2MisconceptionCode: string | null;
  check2TopVoteCount: number | null;
  check2VoteHistogram: Record<string, number>;
  check2MeanConfidence: number | null;
  check2WasTie: boolean;
  check3SelectedText: string | null;
  check3IsCorrect: boolean | null;
  check3Label: string | null;
  diagnosis: string | null;
  diagnosisMisconceptionCode: string | null;
  decisionTableRow: number | null;
  diagnosisReason: string | null;
  heldOutSelectedText: string | null;
  heldOutIsCorrect: boolean | null;
  heldOutLabel: string | null;
  tutoringMessage: string | null;
  tutoringUsedFallback: boolean;
  classifierModel: string | null;
  classifierProvider: string | null;
  classifierApiSurface: string | null;
  classifierPromptVersion: string | null;
  tutorModel: string | null;
  tutorProvider: string | null;
  tutorPromptVersion: string | null;
  flags: CoachFlagCode[];
  reviewStatus: string;
  reviewDecision: string | null;
  reviewOverrideCode: string | null;
  reviewNotes: string | null;
  messages: Array<{
    seq: number;
    role: string;
    kind: string;
    content: string;
    createdAt: string;
  }>;
}

export async function buildCoachResearchExport(filters: {
  classId?: string | null;
  quizId?: string | null;
  from?: Date | null;
  toExclusive?: Date | null;
  includeIncomplete?: boolean;
  redaction?: "redacted" | "raw_irb";
  requireLiveConsent?: boolean;
}): Promise<{
  totalMatchingSessions: number;
  exportedCount: number;
  records: CoachExportRecord[];
}> {
  const where: Record<string, unknown> = {};
  if (filters.classId) where.classId = filters.classId;
  if (filters.quizId) where.quizId = filters.quizId;
  if (filters.from || filters.toExclusive) {
    where.startedAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.toExclusive ? { lt: filters.toExclusive } : {}),
    };
  }
  if (!filters.includeIncomplete) {
    where.state = "COMPLETED";
  }

  const totalMatchingSessions = await prisma.wrongAnswerCoachSession.count({
    where,
  });

  const rows = await prisma.wrongAnswerCoachSession.findMany({
    where: {
      ...where,
      researchMeta: { is: { consentStatus: "AGREE" } },
    },
    include: {
      researchMeta: true,
      messages: { orderBy: { seq: "asc" } },
    },
    orderBy: { startedAt: "asc" },
  });

  // Live consent verification per distinct student user (defaults to true so a
  // student who later declined on an updated form is excluded).
  const requireLive = filters.requireLiveConsent !== false;
  const distinctUserIds = [...new Set(rows.map((r) => r.studentUserId))];
  const liveConsentMap = new Map<string, boolean>();
  if (requireLive) {
    await Promise.all(
      distinctUserIds.map(async (uid) => {
        liveConsentMap.set(uid, await hasResearchConsent(uid));
      }),
    );
  }

  const users = distinctUserIds.length
    ? await prisma.user.findMany({
        where: { id: { in: distinctUserIds } },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const namesByUserId = new Map(
    users.map((u) => [
      u.id,
      [u.firstName, u.lastName, `${u.firstName} ${u.lastName}`].filter(Boolean),
    ]),
  );

  const rawMode = filters.redaction === "raw_irb";
  const records: CoachExportRecord[] = [];

  for (const row of rows) {
    if (!row.researchMeta || row.researchMeta.consentStatus !== "AGREE") {
      continue;
    }
    if (requireLive && !liveConsentMap.get(row.studentUserId)) {
      continue;
    }

    const knownNames = namesByUserId.get(row.studentUserId) ?? [];
    const cleanText = (v: string | null | undefined) =>
      rawMode ? (v ?? null) : redactFreeText(v, knownNames);

    let runs: Check2RunSlot[] = [];
    try {
      runs = row.check2RunsJson
        ? (JSON.parse(row.check2RunsJson) as Check2RunSlot[])
        : [];
    } catch {
      runs = [];
    }

    let histogram: Record<string, number> = {};
    try {
      histogram = row.check2VoteHistogramJson
        ? (JSON.parse(row.check2VoteHistogramJson) as Record<string, number>)
        : {};
    } catch {
      histogram = {};
    }

    let flags: CoachFlagCode[] = [];
    try {
      flags = JSON.parse(row.flagsJson) as CoachFlagCode[];
    } catch {
      flags = [];
    }

    records.push({
      sessionId: pseudonymizeId("ses", row.id),
      attemptId: pseudonymizeId("att", row.attemptId),
      classId: pseudonymizeId("cls", row.classId),
      quizId: pseudonymizeId("quz", row.quizId),
      questionId: pseudonymizeId("qst", row.questionId),
      questionNumber: row.questionIndex + 1,
      studentStudyCode: row.researchMeta.studentStudyCode,
      consentStatus: "AGREE",
      consentFormVersion: row.researchMeta.consentFormVersion,
      protocolRevision: row.researchMeta.protocolRevision,
      containsUnredactedFreeText: rawMode,
      priorSessionCountForQuestion: row.priorSessionCountForQuestion,
      state: row.state,
      endedReason: row.endedReason,
      startedAt: row.startedAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      chosenOptionText: row.chosenOptionText,
      check1Label: row.check1Label,
      explanationText: cleanText(row.explanationText),
      check2ShortCircuitReason: row.check2ShortCircuitReason,
      check2Runs: runs.map((r) => ({
        runIndex: r.runIndex,
        valid: r.valid,
        retried: r.retried,
        choice: r.choice,
        parsedKind: r.parsedKind,
        misconceptionCode: r.misconceptionCode,
        confidence: r.confidence,
        probabilities: r.probabilities,
        latencyMs: r.latencyMs,
      })),
      check2ResultKind: row.check2ResultKind,
      check2MisconceptionCode: row.check2MisconceptionCode,
      check2TopVoteCount: row.check2TopVoteCount,
      check2VoteHistogram: histogram,
      check2MeanConfidence: row.check2MeanConfidence,
      check2WasTie: row.check2WasTie,
      check3SelectedText: row.check3SelectedText,
      check3IsCorrect: row.check3IsCorrect,
      check3Label: row.check3Label,
      diagnosis: row.diagnosis,
      diagnosisMisconceptionCode: row.diagnosisMisconceptionCode,
      decisionTableRow: row.decisionTableRow,
      diagnosisReason: row.diagnosisReason,
      heldOutSelectedText: row.heldOutSelectedText,
      heldOutIsCorrect: row.heldOutIsCorrect,
      heldOutLabel: row.heldOutLabel,
      tutoringMessage: cleanText(row.tutoringMessage),
      tutoringUsedFallback: row.tutoringUsedFallback,
      classifierModel: row.classifierModel,
      classifierProvider: row.classifierProvider,
      classifierApiSurface: row.classifierApiSurface,
      classifierPromptVersion: row.classifierPromptVersion,
      tutorModel: row.tutorModel,
      tutorProvider: row.tutorProvider,
      tutorPromptVersion: row.tutorPromptVersion,
      flags,
      reviewStatus: row.reviewStatus,
      reviewDecision: row.reviewDecision,
      reviewOverrideCode: row.reviewOverrideCode,
      reviewNotes: cleanText(row.reviewNotes),
      messages: row.messages.map((m) => ({
        seq: m.seq,
        role: m.role,
        kind: m.kind,
        // Redact both student and assistant messages (in case the tutor echoed a student identifier).
        content: m.role === "system" ? m.content : (cleanText(m.content) ?? ""),
        createdAt: m.createdAt.toISOString(),
      })),
    });
  }

  return {
    totalMatchingSessions,
    exportedCount: records.length,
    records,
  };
}

export async function getCoachExportSummary(filters: {
  classId?: string | null;
  quizId?: string | null;
  from?: Date | null;
  toExclusive?: Date | null;
  includeIncomplete?: boolean;
}): Promise<{
  totalMatchingSessions: number;
  consentingExportableSessions: number;
}> {
  const where: Record<string, unknown> = {};
  if (filters.classId) where.classId = filters.classId;
  if (filters.quizId) where.quizId = filters.quizId;
  if (filters.from || filters.toExclusive) {
    where.startedAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.toExclusive ? { lt: filters.toExclusive } : {}),
    };
  }
  if (!filters.includeIncomplete) {
    where.state = "COMPLETED";
  }

  const [totalMatchingSessions, candidateRows] = await Promise.all([
    prisma.wrongAnswerCoachSession.count({ where }),
    prisma.wrongAnswerCoachSession.findMany({
      where: {
        ...where,
        researchMeta: { is: { consentStatus: "AGREE" } },
      },
      select: { studentUserId: true },
    }),
  ]);

  const distinctUserIds = [
    ...new Set(candidateRows.map((r) => r.studentUserId)),
  ];
  const liveConsentMap = new Map<string, boolean>();
  await Promise.all(
    distinctUserIds.map(async (uid) => {
      liveConsentMap.set(uid, await hasResearchConsent(uid));
    }),
  );

  const consentingExportableSessions = candidateRows.filter((r) =>
    liveConsentMap.get(r.studentUserId),
  ).length;

  return { totalMatchingSessions, consentingExportableSessions };
}

const CSV_HEADERS = [
  "sessionId",
  "attemptId",
  "classId",
  "quizId",
  "questionId",
  "questionNumber",
  "studentStudyCode",
  "consentStatus",
  "consentFormVersion",
  "protocolRevision",
  "containsUnredactedFreeText",
  "priorSessionCountForQuestion",
  "state",
  "endedReason",
  "startedAt",
  "completedAt",
  "chosenOptionText",
  "check1Label",
  "explanationText",
  "check2ShortCircuitReason",
  "check2ResultKind",
  "check2MisconceptionCode",
  "check2TopVoteCount",
  "check2VoteHistogram",
  "check2MeanConfidence",
  "check2WasTie",
  "check3SelectedText",
  "check3IsCorrect",
  "check3Label",
  "diagnosis",
  "diagnosisMisconceptionCode",
  "decisionTableRow",
  "diagnosisReason",
  "heldOutSelectedText",
  "heldOutIsCorrect",
  "heldOutLabel",
  "tutoringUsedFallback",
  "classifierModel",
  "classifierProvider",
  "classifierApiSurface",
  "classifierPromptVersion",
  "tutorModel",
  "tutorProvider",
  "tutorPromptVersion",
  "flags",
  "reviewStatus",
  "reviewDecision",
  "reviewOverrideCode",
  "reviewNotes",
] as const;

export function serializeCoachExportCsv(records: CoachExportRecord[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const r of records) {
    lines.push(CSV_HEADERS.map((key) => formatCsvCell(r[key])).join(","));
  }
  return lines.join("\n") + "\n";
}
