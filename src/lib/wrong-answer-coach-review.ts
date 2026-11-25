// Shared teacher, admin & researcher review service for Wrong Answer Coach.
//
// IRB PRIVACY INVARIANT:
// This module NEVER queries or includes `WrongAnswerCoachResearchMeta`,
// `consentStatus`, `consentFormVersion`, or `studentStudyCode`. Teachers must
// never learn whether an enrolled student consented to research.

import { prisma } from "./prisma";
import { getActiveMisconceptions } from "./misconception-labeling";
import { CHECK2_BUILTIN_CHOICES } from "./wrong-answer-coach-prompts";
import type {
  Check2RunSlot,
  CoachFlagCode,
  CoachFrozenSessionSnapshot,
  CoachReviewDecision,
  CoachVariantQuestionSnapshot,
  OpaqueMcqTokenEntry,
  TutoringAttemptRecord,
} from "./wrong-answer-coach-types";

const LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

export interface Check2ChoiceDefinition {
  value: string;
  label: string;
  description: string;
  kind: "sound" | "neither" | "misconception";
  fromLiveCatalog?: boolean;
}

export interface ReviewOptionView {
  label: string;
  text: string;
  isChosen: boolean;
  isCorrect: boolean;
  misconceptionCode: string | null;
}

function buildReviewVariantOptions(
  variant: CoachVariantQuestionSnapshot | undefined,
  tokensJson: string | null,
  selectedKey: string | null,
  selectedText: string | null,
): ReviewOptionView[] {
  if (!variant) return [];
  const tokens = parseJson<OpaqueMcqTokenEntry[]>(tokensJson, []);
  if (tokens.length > 0) {
    const byId = new Map(variant.options.map((o) => [o.id, o]));
    return tokens.map((t) => {
      const opt = byId.get(t.variantOptionId);
      const isChosen = selectedKey
        ? t.variantOptionId === selectedKey || t.label === selectedKey
        : Boolean(selectedText && t.text === selectedText);
      return {
        label: t.label,
        text: t.text,
        isChosen,
        isCorrect: Boolean(opt?.isCorrect),
        misconceptionCode: opt?.misconceptionCode ?? null,
      };
    });
  }
  return variant.options.map((opt, idx) => ({
    label: LETTERS[idx] ?? String(idx + 1),
    text: opt.text,
    isChosen: Boolean(selectedText && opt.text === selectedText),
    isCorrect: opt.isCorrect,
    misconceptionCode: opt.misconceptionCode ?? null,
  }));
}

export type ReviewActor =
  | { role: "ADMIN"; userId: string; teacherId: null }
  | { role: "RESEARCHER"; userId: string; teacherId: null }
  | { role: "TEACHER"; userId: string; teacherId: string };

export async function getReviewActor(
  userId: string,
  role: string,
): Promise<ReviewActor | null> {
  if (role === "ADMIN") {
    return { role: "ADMIN", userId, teacherId: null };
  }
  if (role === "RESEARCHER") {
    return { role: "RESEARCHER", userId, teacherId: null };
  }
  if (role !== "TEACHER") return null;
  const teacher = await prisma.teacher.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (!teacher) return null;
  return { role: "TEACHER", userId, teacherId: teacher.id };
}

async function allowedClassIds(actor: ReviewActor): Promise<string[] | null> {
  if (actor.role === "ADMIN" || actor.role === "RESEARCHER") return null; // all classes
  const classes = await prisma.class.findMany({
    where: { teacherId: actor.teacherId },
    select: { id: true },
  });
  return classes.map((c) => c.id);
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function listCoachReviewSessions(
  actor: ReviewActor,
  filters: {
    flaggedOnly?: boolean;
    reviewStatus?: string | null;
    classId?: string | null;
    quizId?: string | null;
    diagnosis?: string | null;
    flagType?: string | null;
  } = {},
) {
  const scopedClassIds = await allowedClassIds(actor);
  if (scopedClassIds !== null && scopedClassIds.length === 0) {
    return { sessions: [], classes: [], catalog: [] };
  }
  if (
    scopedClassIds !== null &&
    filters.classId &&
    !scopedClassIds.includes(filters.classId)
  ) {
    return { sessions: [], classes: [], catalog: [] };
  }

  const where: Record<string, unknown> = {};
  if (filters.classId) {
    where.classId = filters.classId;
  } else if (scopedClassIds !== null) {
    where.classId = { in: scopedClassIds };
  }
  if (filters.quizId) where.quizId = filters.quizId;
  if (filters.flaggedOnly !== false) where.hasFlags = true;
  if (filters.reviewStatus && filters.reviewStatus !== "ALL") {
    where.reviewStatus = filters.reviewStatus;
  }
  if (filters.diagnosis && filters.diagnosis !== "ALL") {
    where.diagnosis = filters.diagnosis === "NONE" ? null : filters.diagnosis;
  }
  if (filters.flagType && filters.flagType !== "ALL") {
    where.flagsJson = { contains: `"${filters.flagType}"` };
  }

  // NOTE: `researchMeta` is deliberately NEVER included or selected here!
  const sessionSelect = {
    id: true,
    attemptId: true,
    classId: true,
    quizId: true,
    questionId: true,
    questionIndex: true,
    studentUserId: true,
    state: true,
    endedReason: true,
    startedAt: true,
    completedAt: true,
    check1Label: true,
    check2ResultKind: true,
    check2MisconceptionCode: true,
    check2TopVoteCount: true,
    check2WasTie: true,
    check3IsCorrect: true,
    check3Label: true,
    diagnosis: true,
    diagnosisMisconceptionCode: true,
    decisionTableRow: true,
    heldOutIsCorrect: true,
    tutoringUsedFallback: true,
    flagsJson: true,
    hasFlags: true,
    reviewStatus: true,
    reviewDecision: true,
    reviewOverrideCode: true,
    reviewedAt: true,
  } as const;

  // Query pending PERSONAL_SUPPORT_NEEDED rows FIRST so older unresolved crisis
  // cases can never be starved off the 150-row page by newer non-urgent rows.
  const canHaveUrgentPending =
    (!filters.reviewStatus ||
      filters.reviewStatus === "ALL" ||
      filters.reviewStatus === "PENDING") &&
    (!filters.flagType ||
      filters.flagType === "ALL" ||
      filters.flagType === "PERSONAL_SUPPORT_NEEDED");

  const [urgentRows, regularRows, classRows, catalog] = await Promise.all([
    canHaveUrgentPending
      ? prisma.wrongAnswerCoachSession.findMany({
          where: {
            ...where,
            reviewStatus: "PENDING",
            flagsJson: { contains: '"PERSONAL_SUPPORT_NEEDED"' },
          },
          orderBy: [{ startedAt: "desc" }],
          take: 50,
          select: sessionSelect,
        })
      : Promise.resolve([]),
    prisma.wrongAnswerCoachSession.findMany({
      where,
      orderBy: [{ startedAt: "desc" }],
      take: 150,
      select: sessionSelect,
    }),
    prisma.class.findMany({
      where: scopedClassIds ? { id: { in: scopedClassIds } } : {},
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    getActiveMisconceptions(),
  ]);

  const seenIds = new Set<string>();
  const rows: typeof regularRows = [];
  for (const r of [...urgentRows, ...regularRows]) {
    if (seenIds.has(r.id)) continue;
    seenIds.add(r.id);
    rows.push(r);
    if (rows.length >= 150) break;
  }

  const userIds = [...new Set(rows.map((r) => r.studentUserId))];
  const quizIds = [...new Set(rows.map((r) => r.quizId))];
  const [users, quizzes] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, firstName: true, lastName: true },
        })
      : Promise.resolve([]),
    quizIds.length
      ? prisma.quiz.findMany({
          where: { id: { in: quizIds } },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
  ]);

  const classById = new Map(classRows.map((c) => [c.id, c.name]));
  const userById = new Map(
    users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]),
  );
  const quizById = new Map(quizzes.map((q) => [q.id, q.name]));

  // Pin PERSONAL_SUPPORT_NEEDED pending reviews to top of list!
  const mapped = rows
    .map((r) => {
      const flags = parseJson<CoachFlagCode[]>(r.flagsJson, []);
      return {
        id: r.id,
        classId: r.classId,
        className: classById.get(r.classId) ?? "Unknown class",
        quizId: r.quizId,
        quizName: quizById.get(r.quizId) ?? "Unknown quiz",
        questionNumber: r.questionIndex + 1,
        studentName: userById.get(r.studentUserId) ?? "Former student",
        state: r.state,
        endedReason: r.endedReason,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt?.toISOString() ?? null,
        check1Label: r.check1Label,
        check2ResultKind: r.check2ResultKind,
        check2MisconceptionCode: r.check2MisconceptionCode,
        check2TopVoteCount: r.check2TopVoteCount,
        check2WasTie: r.check2WasTie,
        check3IsCorrect: r.check3IsCorrect,
        check3Label: r.check3Label,
        diagnosis: r.diagnosis,
        diagnosisMisconceptionCode: r.diagnosisMisconceptionCode,
        decisionTableRow: r.decisionTableRow,
        heldOutIsCorrect: r.heldOutIsCorrect,
        tutoringUsedFallback: r.tutoringUsedFallback,
        flags,
        hasUrgentSupport: flags.includes("PERSONAL_SUPPORT_NEEDED"),
        reviewStatus: r.reviewStatus,
        reviewDecision: r.reviewDecision,
        reviewOverrideCode: r.reviewOverrideCode,
        reviewedAt: r.reviewedAt?.toISOString() ?? null,
      };
    })
    .sort((a, b) => {
      const aUrgent =
        a.hasUrgentSupport && a.reviewStatus === "PENDING" ? 1 : 0;
      const bUrgent =
        b.hasUrgentSupport && b.reviewStatus === "PENDING" ? 1 : 0;
      if (aUrgent !== bUrgent) return bUrgent - aUrgent;
      return b.startedAt.localeCompare(a.startedAt);
    });

  return { sessions: mapped, classes: classRows, catalog };
}

export async function getCoachReviewDetail(
  actor: ReviewActor,
  sessionId: string,
) {
  const scopedClassIds = await allowedClassIds(actor);

  // NOTE: `researchMeta` is deliberately NEVER included or selected here!
  const row = await prisma.wrongAnswerCoachSession.findUnique({
    where: { id: sessionId },
    select: {
      id: true,
      attemptId: true,
      classId: true,
      quizId: true,
      questionId: true,
      questionIndex: true,
      studentUserId: true,
      questionSnapshotJson: true,
      chosenOptionId: true,
      chosenOptionText: true,
      state: true,
      endedReason: true,
      startedAt: true,
      completedAt: true,
      check1Label: true,
      explanationText: true,
      check2RunsJson: true,
      check2ShortCircuitReason: true,
      check2ResultKind: true,
      check2MisconceptionCode: true,
      check2TopVoteCount: true,
      check2VoteHistogramJson: true,
      check2MeanConfidence: true,
      check2WasTie: true,
      secondQuestionTokensJson: true,
      check3SelectedKey: true,
      check3SelectedText: true,
      check3IsCorrect: true,
      check3Label: true,
      diagnosis: true,
      diagnosisMisconceptionCode: true,
      decisionTableRow: true,
      diagnosisReason: true,
      heldOutQuestionTokensJson: true,
      heldOutSelectedKey: true,
      heldOutSelectedText: true,
      heldOutIsCorrect: true,
      heldOutLabel: true,
      tutoringMessage: true,
      tutoringAttemptsJson: true,
      tutoringUsedFallback: true,
      classifierModel: true,
      classifierProvider: true,
      classifierApiSurface: true,
      classifierPromptVersion: true,
      tutorModel: true,
      tutorProvider: true,
      tutorPromptVersion: true,
      flagsJson: true,
      hasFlags: true,
      reviewStatus: true,
      reviewDecision: true,
      reviewOverrideCode: true,
      reviewNotes: true,
      reviewedAt: true,
      messages: {
        orderBy: { seq: "asc" },
        select: {
          seq: true,
          role: true,
          kind: true,
          content: true,
          createdAt: true,
        },
      },
    },
  });

  if (!row) return null;
  if (scopedClassIds !== null && !scopedClassIds.includes(row.classId)) {
    return null;
  }

  const [studentUser, classRow, quizRow] = await Promise.all([
    prisma.user.findUnique({
      where: { id: row.studentUserId },
      select: { firstName: true, lastName: true },
    }),
    prisma.class.findUnique({
      where: { id: row.classId },
      select: { name: true },
    }),
    prisma.quiz.findUnique({
      where: { id: row.quizId },
      select: { name: true },
    }),
  ]);

  const snapshot = parseJson<CoachFrozenSessionSnapshot | null>(
    row.questionSnapshotJson,
    null,
  );

  const originalOptions: ReviewOptionView[] = (
    snapshot?.originalQuestion.options ?? []
  ).map((opt, idx) => ({
    label: LETTERS[idx] ?? String(idx + 1),
    text: opt.optionText,
    isChosen: row.chosenOptionId
      ? opt.optionId === row.chosenOptionId
      : opt.optionText.trim() === row.chosenOptionText.trim(),
    isCorrect: opt.isCorrect,
    misconceptionCode: opt.misconceptionCode ?? null,
  }));

  const secondQuestionOptions = buildReviewVariantOptions(
    snapshot?.secondQuestion,
    row.secondQuestionTokensJson,
    row.check3SelectedKey,
    row.check3SelectedText,
  );

  const heldOutQuestionOptions = buildReviewVariantOptions(
    snapshot?.heldOutQuestion,
    row.heldOutQuestionTokensJson,
    row.heldOutSelectedKey,
    row.heldOutSelectedText,
  );

  const check2Runs = parseJson<Check2RunSlot[]>(row.check2RunsJson, []);
  const misconceptionStatements: Record<string, string> = {};
  for (const m of snapshot?.relevantMisconceptions ?? []) {
    misconceptionStatements[m.code] = m.statement;
  }

  const referencedCodes = new Set<string>();
  const addCode = (code: string | null | undefined) => {
    if (!code || code === "sound" || code === "neither") return;
    referencedCodes.add(code);
  };
  addCode(row.check1Label);
  addCode(row.check2MisconceptionCode);
  addCode(row.check3Label);
  addCode(row.heldOutLabel);
  addCode(row.diagnosisMisconceptionCode);
  for (const opt of originalOptions) addCode(opt.misconceptionCode);
  for (const opt of secondQuestionOptions) addCode(opt.misconceptionCode);
  for (const opt of heldOutQuestionOptions) addCode(opt.misconceptionCode);
  for (const run of check2Runs) {
    addCode(run.choice);
    addCode(run.misconceptionCode);
    for (const p of run.probabilities) addCode(p.value);
  }
  const missingCodes = [...referencedCodes].filter(
    (code) => !(code in misconceptionStatements),
  );
  if (missingCodes.length > 0) {
    const fallbackRows = await prisma.misconception.findMany({
      where: { misconceptionId: { in: missingCodes } },
      select: { misconceptionId: true, statement: true },
    });
    for (const m of fallbackRows) {
      misconceptionStatements[m.misconceptionId] = m.statement;
    }
  }

  const seenChoices = new Set<string>();
  const check2ChoiceDefinitions: Check2ChoiceDefinition[] = [];
  for (const builtin of CHECK2_BUILTIN_CHOICES) {
    seenChoices.add(builtin.value);
    check2ChoiceDefinitions.push({
      value: builtin.value,
      label: builtin.label,
      description: builtin.description,
      kind: builtin.value,
    });
  }
  for (const m of snapshot?.relevantMisconceptions ?? []) {
    if (seenChoices.has(m.code)) continue;
    seenChoices.add(m.code);
    check2ChoiceDefinitions.push({
      value: m.code,
      label: `Misconception ${m.code}`,
      description: m.statement,
      kind: "misconception",
    });
  }
  for (const run of check2Runs) {
    for (const val of [run.choice, ...run.probabilities.map((p) => p.value)]) {
      if (!val || seenChoices.has(val)) continue;
      seenChoices.add(val);
      const fromLiveCatalog = val in misconceptionStatements;
      check2ChoiceDefinitions.push({
        value: val,
        label: `Misconception ${val}`,
        description:
          misconceptionStatements[val] ??
          "No catalog description recorded for this misconception code.",
        kind: "misconception",
        ...(fromLiveCatalog ? { fromLiveCatalog: true } : {}),
      });
    }
  }

  return {
    id: row.id,
    classId: row.classId,
    className: classRow?.name ?? "Unknown class",
    quizId: row.quizId,
    quizName: quizRow?.name ?? "Unknown quiz",
    questionNumber: row.questionIndex + 1,
    studentName: studentUser
      ? `${studentUser.firstName} ${studentUser.lastName}`.trim()
      : "Former student",
    originalQuestionText: snapshot?.originalQuestion.text ?? "",
    originalOptions,
    correctOptionText: snapshot?.originalQuestion.correctOptionText ?? "",
    chosenOptionText: row.chosenOptionText,
    state: row.state,
    endedReason: row.endedReason,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    check1Label: row.check1Label,
    explanationText: row.explanationText,
    check2Runs,
    check2ChoiceDefinitions,
    misconceptionStatements,
    check2ShortCircuitReason: row.check2ShortCircuitReason,
    check2ResultKind: row.check2ResultKind,
    check2MisconceptionCode: row.check2MisconceptionCode,
    check2TopVoteCount: row.check2TopVoteCount,
    check2VoteHistogram: parseJson<Record<string, number>>(
      row.check2VoteHistogramJson,
      {},
    ),
    check2MeanConfidence: row.check2MeanConfidence,
    check2WasTie: row.check2WasTie,
    secondQuestionText: snapshot?.secondQuestion.text ?? "",
    secondQuestionOptions,
    check3SelectedText: row.check3SelectedText,
    check3IsCorrect: row.check3IsCorrect,
    check3Label: row.check3Label,
    diagnosis: row.diagnosis,
    diagnosisMisconceptionCode: row.diagnosisMisconceptionCode,
    decisionTableRow: row.decisionTableRow,
    diagnosisReason: row.diagnosisReason,
    heldOutQuestionText: snapshot?.heldOutQuestion.text ?? "",
    heldOutQuestionOptions,
    heldOutSelectedText: row.heldOutSelectedText,
    heldOutIsCorrect: row.heldOutIsCorrect,
    heldOutLabel: row.heldOutLabel,
    tutoringMessage: row.tutoringMessage,
    tutoringAttempts: parseJson<TutoringAttemptRecord[]>(
      row.tutoringAttemptsJson,
      [],
    ),
    tutoringUsedFallback: row.tutoringUsedFallback,
    classifierModel: row.classifierModel,
    classifierProvider: row.classifierProvider,
    classifierApiSurface: row.classifierApiSurface,
    classifierPromptVersion: row.classifierPromptVersion,
    tutorModel: row.tutorModel,
    tutorProvider: row.tutorProvider,
    tutorPromptVersion: row.tutorPromptVersion,
    flags: parseJson<CoachFlagCode[]>(row.flagsJson, []),
    reviewStatus: row.reviewStatus,
    reviewDecision: row.reviewDecision,
    reviewOverrideCode: row.reviewOverrideCode,
    reviewNotes: row.reviewNotes,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    messages: row.messages.map((m) => ({
      ...m,
      createdAt: m.createdAt.toISOString(),
    })),
  };
}

export async function submitCoachReviewDecision(
  actor: ReviewActor,
  sessionId: string,
  input: {
    reviewDecision: CoachReviewDecision;
    reviewOverrideCode?: string | null;
    reviewNotes?: string | null;
  },
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (actor.role === "RESEARCHER") {
    return { ok: false, status: 403, error: "Forbidden." };
  }
  const scopedClassIds = await allowedClassIds(actor);
  const existing = await prisma.wrongAnswerCoachSession.findUnique({
    where: { id: sessionId },
    select: { id: true, classId: true, diagnosis: true },
  });
  if (!existing) {
    return { ok: false, status: 404, error: "Session not found." };
  }
  if (scopedClassIds !== null && !scopedClassIds.includes(existing.classId)) {
    return { ok: false, status: 404, error: "Session not found." };
  }

  // Enforce: incomplete sessions with diagnosis === null cannot be given
  // diagnosis-agreement or diagnosis-override decisions.
  if (
    existing.diagnosis === null &&
    input.reviewDecision !== "ESCALATED_FOLLOWUP" &&
    input.reviewDecision !== "DISMISSED"
  ) {
    return {
      ok: false,
      status: 400,
      error:
        "Sessions without a diagnosis can only be marked Escalated or Dismissed.",
    };
  }

  let overrideCode: string | null = null;
  if (input.reviewDecision === "OVERRIDE_MISCONCEPTION") {
    const code = input.reviewOverrideCode?.trim() || "";
    if (!code) {
      return {
        ok: false,
        status: 400,
        error: "Select a misconception code when overriding to Misconception.",
      };
    }
    const found = await prisma.misconception.findUnique({
      where: { misconceptionId: code },
      select: { misconceptionId: true },
    });
    if (!found) {
      return {
        ok: false,
        status: 400,
        error: `Unknown misconception code: ${code}`,
      };
    }
    overrideCode = found.misconceptionId;
  }

  // Note: deterministic `diagnosis` / `decisionTableRow` columns are NEVER mutated.
  await prisma.wrongAnswerCoachSession.update({
    where: { id: sessionId },
    data: {
      reviewStatus: "REVIEWED",
      reviewDecision: input.reviewDecision,
      reviewOverrideCode: overrideCode,
      reviewNotes: input.reviewNotes?.trim().slice(0, 2_000) || null,
      reviewedByUserId: actor.userId,
      reviewedAt: new Date(),
    },
  });

  return { ok: true };
}
