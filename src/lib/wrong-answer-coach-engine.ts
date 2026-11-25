// Core server-side orchestration for the Wrong Answer Coach diagnostic state
// machine. Owns eligibility, session creation/resume, Check 1 lookup, 5-run
// OpenAI Decisions API Check 2 classification with partial-failure recovery,
// Check 3 + deterministic 14-row diagnosis, Held-Out question, Task B tutoring
// with unified retry/fallback, crash-safe processingToken locking, and
// student-safe zero-leakage DTO projection.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { prisma } from "./prisma";
import { canAttemptAgain } from "./quiz-availability";
import { parseReviewSnapshot, type SnapshotQuestion } from "./exam-results";
import { shuffleAnswerChoices } from "./quiz-shuffle";
import { createDecisions, DecisionsApiError } from "./ai-decisions";
import {
  createOpenAIClient,
  resolveProvider,
  thinkingParams,
} from "./ai-provider";
import {
  streamJsonCompletion,
  streamOptionsFor,
  transportFor,
} from "./ai-streaming";
import { checkContentSafety, moderateText } from "./guardrails";
import {
  getGuardrailSettings,
  moderationEnabledFor,
  policyFor,
} from "./guardrail-settings";
import { getActiveMisconceptions } from "./misconception-labeling";
import {
  buildTutoringFallbackMessage,
  COACH_FIXED_MESSAGES,
  COACH_PROTOCOL_REVISION,
  COACH_TUTORING_MAX_WORDS,
  countCoachWords,
} from "./wrong-answer-coach-messages";
import {
  aggregateCheck2Runs,
  computeQuestionSourceHash,
  evaluateDiagnosis,
  isAnswerRequest,
  isSupportedCoachQuestionShape,
  mapDecisionChoiceToCheck2,
  matchesLocalCrisisPattern,
  validateTutoringMessage,
} from "./wrong-answer-coach-rules";
import {
  buildCheck2DecisionsRequest,
  buildTutorPromptMessages,
  CHECK2_PROMPT_TEMPLATE_HASH,
  CHECK2_PROMPT_VERSION,
  TUTOR_JSON_SCHEMA,
  TUTOR_PROMPT_VERSION,
} from "./wrong-answer-coach-prompts";
import {
  getOrCreateStudentStudyCode,
  getStudentConsentSnapshot,
  isCoachConsentEligible,
} from "./wrong-answer-coach-study";
import type { VariantQuestion } from "./quiz-variants";
import type {
  Check2RunSlot,
  CoachEligibilityItem,
  CoachFlagCode,
  CoachFrozenSessionSnapshot,
  CoachMaterialSnippet,
  CoachMisconceptionEntry,
  CoachOptionLabel,
  CoachSessionState,
  CoachVariantQuestionSnapshot,
  OpaqueMcqTokenEntry,
  StructuredTutoringMessage,
  StudentAnsweredMcqView,
  StudentCoachOptionView,
  StudentCoachSessionView,
  TutoringAttemptRecord,
} from "./wrong-answer-coach-types";
import { errorMessage } from "./errors";
import { logSystemEvent } from "./system-log";

const LEASE_TTL_MS = 5 * 60_000; // 5 minutes, aligned between respond & sweeper
const ABANDON_TIMEOUT_MS = 24 * 60 * 60_000; // 24 hours
const TUTOR_TIMEOUT_MS = 30_000;
const MAX_SNIPPET_TOTAL_CHARS = 1_500;
const LETTERS = ["A", "B", "C", "D", "E", "F"] as const;

export class CoachHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "CoachHttpError";
    this.status = status;
  }
}

// ─── Retake Lock Check (Mirrors student-quiz-results.ts) ──────────────────────

export async function isQuizRetakeStillPossible(
  studentId: string,
  classId: string,
  quizId: string,
): Promise<boolean> {
  if (process.env.COACH_ALLOW_DURING_OPEN_RETAKES === "true") {
    return false;
  }
  const [classQuiz, completedAttempts, inProgress] = await Promise.all([
    prisma.classQuiz.findUnique({
      where: { classId_quizId: { classId, quizId } },
      select: {
        published: true,
        availableFrom: true,
        availableUntil: true,
        maxAttempts: true,
      },
    }),
    prisma.quizAttempt.count({
      where: { studentId, classId, quizId, completedAt: { not: null } },
    }),
    prisma.quizAttempt.count({
      where: { studentId, classId, quizId, completedAt: null },
    }),
  ]);
  if (!classQuiz) return false;
  if (!classQuiz.published) return true;
  return canAttemptAgain(
    {
      availableFrom: classQuiz.availableFrom,
      availableUntil: classQuiz.availableUntil,
      maxAttempts: classQuiz.maxAttempts,
    },
    { completedAttempts, hasAttemptInProgress: inProgress > 0 },
  );
}

// ─── Variant & Metadata Resolution Helpers ────────────────────────────────────

function extractVariantQuestionForSource(
  version: {
    id: string;
    questions: string;
    sourceSnapshot: string;
    coachLabeledAt: Date | null;
  },
  sourceQuestionId: string,
  expectedSourceHash: string,
): CoachVariantQuestionSnapshot | null {
  if (!version.coachLabeledAt) return null;
  try {
    const sources = JSON.parse(version.sourceSnapshot) as VariantQuestion[];
    const matchedSource = sources.find(
      (s) =>
        s.id === sourceQuestionId || s.sourceQuestionId === sourceQuestionId,
    );
    if (!matchedSource) return null;
    const variantSourceHash = computeQuestionSourceHash({
      text: matchedSource.text,
      answerMode: matchedSource.answerMode,
      options: matchedSource.options,
    });
    if (variantSourceHash !== expectedSourceHash) return null;

    const vQuestions = JSON.parse(version.questions) as VariantQuestion[];
    const vq = vQuestions.find((q) => q.sourceQuestionId === sourceQuestionId);
    if (!vq) return null;

    const shape = isSupportedCoachQuestionShape({
      answerMode: vq.answerMode,
      options: vq.options,
    });
    if (!shape.ok) return null;

    return {
      id: vq.id,
      sourceQuestionId: vq.sourceQuestionId,
      text: vq.text,
      options: [...vq.options]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((o) => ({
          id: o.id,
          text: o.text,
          isCorrect: o.isCorrect,
          misconceptionCode: o.isCorrect ? null : (o.misconceptionCode ?? null),
        })),
    };
  } catch {
    return null;
  }
}

function resolveSingleWrongSelection(q: SnapshotQuestion): {
  optionId: string | null;
  optionText: string;
} | null {
  if (q.isCorrect) return null;
  const selected = q.options.filter((o) => o.selected);
  if (selected.length !== 1) return null;
  const chosen = selected[0];
  if (chosen.isCorrect) return null;
  if (!chosen.text.trim()) return null;
  return {
    optionId: chosen.optionId ?? null,
    optionText: chosen.text,
  };
}

function parseFlags(raw: string): CoachFlagCode[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CoachFlagCode[]) : [];
  } catch {
    return [];
  }
}

function mergeFlags(
  existingRaw: string,
  additions: readonly CoachFlagCode[],
): { flagsJson: string; hasFlags: boolean; addedNew: boolean } {
  const existing = parseFlags(existingRaw);
  const set = new Set<CoachFlagCode>(existing);
  const beforeSize = set.size;
  for (const f of additions) set.add(f);
  const next = [...set];
  return {
    flagsJson: JSON.stringify(next),
    hasFlags: next.length > 0,
    addedNew: next.length > beforeSize,
  };
}

function mintOpaqueMcqTokens(
  variantQuestion: CoachVariantQuestionSnapshot,
  seed: string,
): OpaqueMcqTokenEntry[] {
  const ordered = shuffleAnswerChoices(
    [...variantQuestion.options].sort((a, b) => a.id.localeCompare(b.id)),
    seed,
  );
  return ordered.map((opt, idx) => ({
    optionToken: `t_${randomBytes(8).toString("hex")}`,
    variantOptionId: opt.id,
    label: LETTERS[idx] ?? String(idx + 1),
    text: opt.text,
  }));
}

async function loadFrozenClassCourseSnippets(
  classId: string,
): Promise<CoachMaterialSnippet[]> {
  const links = await prisma.materialClass.findMany({
    where: {
      classId,
      material: { processingStatus: "SUCCESS" },
    },
    include: {
      material: {
        select: {
          id: true,
          title: true,
          originalName: true,
          batchDescription: true,
          pages: {
            where: { needed: true },
            orderBy: { pageNumber: "asc" },
            take: 3,
            select: {
              pageNumber: true,
              keyConcept: true,
              description: true,
            },
          },
        },
      },
    },
    take: 2,
  });

  const snippets: CoachMaterialSnippet[] = [];
  let totalChars = 0;

  for (const link of links) {
    const mat = link.material;
    const title = mat.title?.trim() || mat.originalName;
    if (mat.pages.length > 0) {
      for (const page of mat.pages) {
        const text = [page.keyConcept, page.description]
          .filter(Boolean)
          .join(": ")
          .trim()
          .slice(0, 450);
        if (!text) continue;
        if (totalChars + text.length > MAX_SNIPPET_TOTAL_CHARS) break;
        totalChars += text.length;
        snippets.push({
          materialId: mat.id,
          title,
          pageNumber: page.pageNumber,
          text,
          sha256: createHash("sha256").update(text).digest("hex").slice(0, 16),
        });
      }
    } else if (mat.batchDescription?.trim()) {
      const text = mat.batchDescription.trim().slice(0, 450);
      if (totalChars + text.length <= MAX_SNIPPET_TOTAL_CHARS) {
        totalChars += text.length;
        snippets.push({
          materialId: mat.id,
          title,
          pageNumber: null,
          text,
          sha256: createHash("sha256").update(text).digest("hex").slice(0, 16),
        });
      }
    }
  }

  return snippets;
}

// ─── Student-Safe Projection (Strict Zero-Leakage Firewall Before Step 10) ────

function buildAnsweredVariantMcq(input: {
  step: "second_question" | "held_out_question";
  variant: CoachVariantQuestionSnapshot;
  tokensJson: string | null;
  selectedKey: string | null;
  selectedText: string | null;
  isCorrect: boolean | null;
  revealCorrectness: boolean;
}): StudentAnsweredMcqView | null {
  if (!input.tokensJson || (!input.selectedKey && !input.selectedText)) {
    return null;
  }
  let tokens: OpaqueMcqTokenEntry[];
  try {
    tokens = JSON.parse(input.tokensJson) as OpaqueMcqTokenEntry[];
  } catch {
    return null;
  }
  if (!Array.isArray(tokens) || tokens.length === 0) return null;

  const optById = new Map(input.variant.options.map((o) => [o.id, o]));
  const options: StudentCoachOptionView[] = tokens.map((t) => {
    const matched = optById.get(t.variantOptionId);
    const isChosen = input.selectedKey
      ? t.variantOptionId === input.selectedKey || t.label === input.selectedKey
      : Boolean(input.selectedText && t.text === input.selectedText);
    return {
      label: t.label,
      text: t.text,
      isChosen,
      ...(input.revealCorrectness && matched
        ? { isCorrect: matched.isCorrect }
        : {}),
    };
  });

  return {
    step: input.step,
    text: input.variant.text,
    options,
    ...(input.revealCorrectness && input.isCorrect !== null
      ? { isCorrect: input.isCorrect }
      : {}),
  };
}

function toStudentSessionView(session: {
  id: string;
  attemptId: string;
  questionId: string;
  questionIndex: number;
  state: string;
  chosenOptionId?: string | null;
  chosenOptionText: string;
  questionSnapshotJson: string;
  secondQuestionTokensJson: string | null;
  check3SelectedKey?: string | null;
  check3SelectedText?: string | null;
  check3IsCorrect?: boolean | null;
  heldOutQuestionTokensJson: string | null;
  heldOutSelectedKey?: string | null;
  heldOutSelectedText?: string | null;
  heldOutIsCorrect?: boolean | null;
  tutoringStructuredJson: string | null;
  messages: Array<{
    seq: number;
    role: string;
    kind: string;
    content: string;
    createdAt: Date;
  }>;
}): StudentCoachSessionView {
  const snapshot = JSON.parse(
    session.questionSnapshotJson,
  ) as CoachFrozenSessionSnapshot;
  const state = session.state as CoachSessionState;
  const isCompleted = state === "COMPLETED";

  let parsedTutoring: StructuredTutoringMessage | null = null;
  if (isCompleted && session.tutoringStructuredJson) {
    try {
      parsedTutoring = JSON.parse(
        session.tutoringStructuredJson,
      ) as StructuredTutoringMessage;
    } catch {
      parsedTutoring = null;
    }
  }

  let activeMcq: StudentCoachSessionView["activeMcq"] = null;
  if (
    state === "AWAITING_SECOND_QUESTION" &&
    session.secondQuestionTokensJson
  ) {
    const tokens = JSON.parse(
      session.secondQuestionTokensJson,
    ) as OpaqueMcqTokenEntry[];
    activeMcq = {
      step: "second_question",
      text: snapshot.secondQuestion.text,
      options: tokens.map((t) => ({
        optionToken: t.optionToken,
        label: t.label,
        text: t.text,
      })),
    };
  } else if (
    state === "AWAITING_HELDOUT_QUESTION" &&
    session.heldOutQuestionTokensJson
  ) {
    const tokens = JSON.parse(
      session.heldOutQuestionTokensJson,
    ) as OpaqueMcqTokenEntry[];
    activeMcq = {
      step: "held_out_question",
      text: snapshot.heldOutQuestion.text,
      options: tokens.map((t) => ({
        optionToken: t.optionToken,
        label: t.label,
        text: t.text,
      })),
    };
  }

  const originalOptions: StudentCoachOptionView[] = (
    snapshot.originalQuestion.options ?? []
  ).map((opt, idx) => {
    const isChosen = session.chosenOptionId
      ? opt.optionId === session.chosenOptionId
      : opt.optionText.trim() === session.chosenOptionText.trim();
    return {
      label: LETTERS[idx] ?? String(idx + 1),
      text: opt.optionText,
      isChosen,
      // FIREWALL: isCorrect is NEVER included before state === COMPLETED!
      ...(isCompleted ? { isCorrect: opt.isCorrect } : {}),
    };
  });

  const answeredMcqs: StudentAnsweredMcqView[] = [];
  const check3Answered = buildAnsweredVariantMcq({
    step: "second_question",
    variant: snapshot.secondQuestion,
    tokensJson: session.secondQuestionTokensJson,
    selectedKey: session.check3SelectedKey ?? null,
    selectedText: session.check3SelectedText ?? null,
    isCorrect: session.check3IsCorrect ?? null,
    revealCorrectness: isCompleted,
  });
  if (check3Answered) answeredMcqs.push(check3Answered);

  const heldOutAnswered = buildAnsweredVariantMcq({
    step: "held_out_question",
    variant: snapshot.heldOutQuestion,
    tokensJson: session.heldOutQuestionTokensJson,
    selectedKey: session.heldOutSelectedKey ?? null,
    selectedText: session.heldOutSelectedText ?? null,
    isCorrect: session.heldOutIsCorrect ?? null,
    revealCorrectness: isCompleted,
  });
  if (heldOutAnswered) answeredMcqs.push(heldOutAnswered);

  return {
    sessionId: session.id,
    attemptId: session.attemptId,
    questionId: session.questionId,
    questionNumber: session.questionIndex + 1,
    state,
    originalQuestion: {
      text: snapshot.originalQuestion.text,
      chosenOptionText: session.chosenOptionText,
      options: originalOptions,
      // FIREWALL: correctOptionText is NEVER included before state === COMPLETED!
      ...(isCompleted
        ? { correctOptionText: snapshot.originalQuestion.correctOptionText }
        : {}),
    },
    messages: session.messages.map((m) => ({
      seq: m.seq,
      role: m.role as "system" | "student" | "assistant",
      kind: m.kind,
      content: m.content,
      ...(isCompleted &&
      (m.kind === "TUTORING_MESSAGE" || m.kind === "TUTORING_FALLBACK")
        ? { structuredTutoring: parsedTutoring }
        : {}),
      createdAt: m.createdAt.toISOString(),
    })),
    answeredMcqs,
    activeMcq,
  };
}

// ─── 1. Eligibility & Disclosure Check ────────────────────────────────────────

export async function getCoachEligibilityForAttempt(input: {
  attemptId: string;
  studentId: string;
  studentUserId: string;
}): Promise<CoachEligibilityItem[]> {
  const examResult = await prisma.examResult.findUnique({
    where: { quizAttemptId: input.attemptId },
  });
  if (!examResult || examResult.studentId !== input.studentId) {
    return [];
  }

  const snapshot = parseReviewSnapshot(examResult.reviewSnapshot);
  const missed = snapshot.questions
    .map((q, index) => ({ q, index }))
    .filter(({ q }) => !q.isCorrect && Boolean(q.questionId));
  if (missed.length === 0) return [];

  const missedIds = missed.map(({ q }) => q.questionId!);

  const [existingSessions, retakeable, consentOk, metadataRows, coachVariants] =
    await Promise.all([
      prisma.wrongAnswerCoachSession.findMany({
        where: { attemptId: input.attemptId, studentId: input.studentId },
        select: { id: true, questionId: true, state: true },
      }),
      isQuizRetakeStillPossible(
        input.studentId,
        examResult.classId,
        examResult.quizId,
      ),
      isCoachConsentEligible(input.studentUserId),
      prisma.questionCoachMetadata.findMany({
        where: { questionId: { in: missedIds }, status: "READY" },
      }),
      prisma.quizPracticeVersion.findMany({
        where: {
          quizId: examResult.quizId,
          status: "PUBLISHED",
          coachRole: { in: ["COACH_CHECK3", "COACH_HELDOUT"] },
          coachLabeledAt: { not: null },
        },
        select: {
          id: true,
          coachRole: true,
          questions: true,
          sourceSnapshot: true,
          coachLabeledAt: true,
        },
      }),
    ]);

  const sessionByQ = new Map(existingSessions.map((s) => [s.questionId, s]));
  const metaByQ = new Map(metadataRows.map((m) => [m.questionId, m]));
  const check3Version =
    coachVariants.find((v) => v.coachRole === "COACH_CHECK3") ?? null;
  const heldOutVersion =
    coachVariants.find((v) => v.coachRole === "COACH_HELDOUT") ?? null;

  return missed.map(({ q, index }) => {
    const questionId = q.questionId!;
    const questionNumber = index + 1;
    const existing = sessionByQ.get(questionId);
    if (existing) {
      const sessionStatus =
        existing.state === "COMPLETED"
          ? "COMPLETED"
          : existing.state === "INCOMPLETE"
            ? "INCOMPLETE"
            : "IN_PROGRESS";
      return {
        questionId,
        questionNumber,
        eligible: true,
        sessionId: existing.id,
        sessionStatus,
      };
    }

    if (retakeable || !consentOk || !check3Version || !heldOutVersion) {
      return {
        questionId,
        questionNumber,
        eligible: false,
        sessionId: null,
        sessionStatus: "NOT_STARTED",
      };
    }

    const shape = isSupportedCoachQuestionShape({
      answerMode: q.answerMode ?? "SINGLE_SELECT",
      figureStorageKey: q.figureStorageKey,
      options: q.options,
    });
    const wrongSelection = resolveSingleWrongSelection(q);
    if (!shape.ok || !wrongSelection) {
      return {
        questionId,
        questionNumber,
        eligible: false,
        sessionId: null,
        sessionStatus: "NOT_STARTED",
      };
    }

    const snapshotHash = computeQuestionSourceHash({
      text: q.text,
      answerMode: q.answerMode ?? "SINGLE_SELECT",
      figureStorageKey: q.figureStorageKey,
      figureAlt: q.figureAlt,
      options: q.options,
    });
    const meta = metaByQ.get(questionId);
    if (!meta || meta.sourceHash !== snapshotHash) {
      return {
        questionId,
        questionNumber,
        eligible: false,
        sessionId: null,
        sessionStatus: "NOT_STARTED",
      };
    }

    const secondQ = extractVariantQuestionForSource(
      check3Version,
      questionId,
      snapshotHash,
    );
    const heldOutQ = extractVariantQuestionForSource(
      heldOutVersion,
      questionId,
      snapshotHash,
    );
    const eligible = Boolean(secondQ && heldOutQ);

    return {
      questionId,
      questionNumber,
      eligible,
      sessionId: null,
      sessionStatus: "NOT_STARTED",
    };
  });
}

/**
 * Returns the set of questionIds on an attempt whose answer keys MUST stay
 * withheld from the general student assistant because the student has an
 * eligible Wrong Answer Coach question that has not yet completed Step 10.
 *
 * Releases the answer key once the session reaches COMPLETED or INCOMPLETE so
 * a student who ended or timed out of Coach is never permanently locked out.
 */
export async function getCoachAnswerKeyWithheldQuestionIds(input: {
  attemptId: string;
  studentId: string;
  studentUserId: string;
}): Promise<Set<string>> {
  const items = await getCoachEligibilityForAttempt(input);
  const withheld = new Set<string>();
  for (const item of items) {
    if (
      item.eligible &&
      item.sessionStatus !== "COMPLETED" &&
      item.sessionStatus !== "INCOMPLETE"
    ) {
      withheld.add(item.questionId);
    }
  }
  return withheld;
}

/**
 * Cross-attempt Step 10 firewall: checks BOTH the requested attempt AND the
 * student's latest attempt on the same (classId, quizId) so an earlier attempt
 * where the student answered question Q correctly cannot leak Q's answer key
 * while a later final attempt has an unfinished Wrong Answer Coach session for Q.
 * Also withholds Coach-shaped missed questions while Coach variants are assigned
 * and still finishing auto-labeling, preventing pre-labeling answer leakage.
 */
export async function getCoachWithheldQuestionsForStudentQuiz(input: {
  attemptId: string;
  studentId: string;
  studentUserId: string;
  classId: string;
  quizId: string;
}): Promise<{ questionIds: Set<string>; normalizedTexts: Set<string> }> {
  const questionIds = new Set<string>();
  const normalizedTexts = new Set<string>();

  const [results, coachVariantsCount] = await Promise.all([
    prisma.examResult.findMany({
      where: {
        studentId: input.studentId,
        classId: input.classId,
        quizId: input.quizId,
      },
      orderBy: { completedAt: "desc" },
      take: 5,
      select: { quizAttemptId: true, reviewSnapshot: true },
    }),
    prisma.quizPracticeVersion.count({
      where: {
        quizId: input.quizId,
        status: "PUBLISHED",
        coachRole: { in: ["COACH_CHECK3", "COACH_HELDOUT"] },
      },
    }),
  ]);

  if (coachVariantsCount < 2) {
    return { questionIds, normalizedTexts };
  }

  // Always inspect the requested attempt AND the latest attempt for this quiz.
  const attemptIdsToCheck = new Set<string>([input.attemptId]);
  if (results[0]) attemptIdsToCheck.add(results[0].quizAttemptId);

  const consentOk = await isCoachConsentEligible(input.studentUserId);
  if (!consentOk) {
    return { questionIds, normalizedTexts };
  }

  const sessions = await prisma.wrongAnswerCoachSession.findMany({
    where: {
      attemptId: { in: [...attemptIdsToCheck] },
      studentId: input.studentId,
    },
    select: { attemptId: true, questionId: true, state: true },
  });
  const sessionByKey = new Map(
    sessions.map((s) => [`${s.attemptId}:${s.questionId}`, s.state]),
  );

  for (const res of results) {
    if (!attemptIdsToCheck.has(res.quizAttemptId)) continue;
    const snap = parseReviewSnapshot(res.reviewSnapshot);
    for (const q of snap.questions) {
      if (q.isCorrect || !q.questionId) continue;
      const shape = isSupportedCoachQuestionShape({
        answerMode: q.answerMode ?? "SINGLE_SELECT",
        figureStorageKey: q.figureStorageKey,
        options: q.options,
      });
      if (!shape.ok || !resolveSingleWrongSelection(q)) continue;
      const state = sessionByKey.get(`${res.quizAttemptId}:${q.questionId}`);
      if (state === "COMPLETED" || state === "INCOMPLETE") continue;
      questionIds.add(q.questionId);
      const norm = q.text.trim().toLowerCase().replace(/\s+/g, " ");
      if (norm) normalizedTexts.add(norm);
    }
  }

  return { questionIds, normalizedTexts };
}

// ─── 2. Start or Resume Session (Steps 1–3) ───────────────────────────────────

export async function startOrResumeCoachSession(input: {
  attemptId: string;
  questionId: string;
  studentId: string;
  studentUserId: string;
}): Promise<StudentCoachSessionView> {
  // 1. Check existing session first (resumes active; returns terminal read-only).
  const existing = await prisma.wrongAnswerCoachSession.findUnique({
    where: {
      attemptId_questionId: {
        attemptId: input.attemptId,
        questionId: input.questionId,
      },
    },
    include: { messages: { orderBy: { seq: "asc" } } },
  });
  if (existing) {
    if (existing.studentUserId !== input.studentUserId) {
      throw new CoachHttpError(404, "Session not found.");
    }
    // Re-check retake gate & consent when resuming an active (non-terminal) session
    // so reopening retakes mid-session can never turn Coach into an answer-key oracle.
    if (existing.state !== "COMPLETED" && existing.state !== "INCOMPLETE") {
      const [retakeable, consentOk] = await Promise.all([
        isQuizRetakeStillPossible(
          existing.studentId,
          existing.classId,
          existing.quizId,
        ),
        isCoachConsentEligible(input.studentUserId),
      ]);
      if (retakeable) {
        throw new CoachHttpError(
          409,
          "A new quiz attempt is currently open for this quiz. Complete your quiz attempts before continuing this chat.",
        );
      }
      if (!consentOk) {
        throw new CoachHttpError(
          403,
          "Wrong Answer Coach is not available for this quiz right now.",
        );
      }
    }
    return toStudentSessionView(existing);
  }

  // 2. Verify ExamResult ownership.
  const examResult = await prisma.examResult.findUnique({
    where: { quizAttemptId: input.attemptId },
  });
  if (!examResult || examResult.studentId !== input.studentId) {
    throw new CoachHttpError(
      409,
      "Quiz results are not ready yet. Please try again in a moment.",
    );
  }

  // 3. Enforce retake lock + IRB consent gate (neutral 403/409).
  const [retakeable, consentOk] = await Promise.all([
    isQuizRetakeStillPossible(
      input.studentId,
      examResult.classId,
      examResult.quizId,
    ),
    isCoachConsentEligible(input.studentUserId),
  ]);
  if (retakeable || !consentOk) {
    throw new CoachHttpError(
      403,
      "Wrong Answer Coach is not available for this quiz right now.",
    );
  }

  // 4. Locate question inside durable ExamResult snapshot.
  const snapshot = parseReviewSnapshot(examResult.reviewSnapshot);
  const questionIndex = snapshot.questions.findIndex(
    (q) => q.questionId === input.questionId,
  );
  if (questionIndex < 0) {
    throw new CoachHttpError(404, "Question not found in attempt.");
  }
  const snapQuestion = snapshot.questions[questionIndex];
  const shape = isSupportedCoachQuestionShape({
    answerMode: snapQuestion.answerMode ?? "SINGLE_SELECT",
    figureStorageKey: snapQuestion.figureStorageKey,
    options: snapQuestion.options,
  });
  const wrongSelection = resolveSingleWrongSelection(snapQuestion);
  if (!shape.ok || !wrongSelection) {
    throw new CoachHttpError(
      400,
      "This question is not eligible for Wrong Answer Coach.",
    );
  }
  const correctSnapOpt = snapQuestion.options.find((o) => o.isCorrect);
  if (!correctSnapOpt) {
    throw new CoachHttpError(400, "Question answer key is incomplete.");
  }

  const snapshotHash = computeQuestionSourceHash({
    text: snapQuestion.text,
    answerMode: snapQuestion.answerMode ?? "SINGLE_SELECT",
    figureStorageKey: snapQuestion.figureStorageKey,
    figureAlt: snapQuestion.figureAlt,
    options: snapQuestion.options,
  });

  // 5. Load QuestionCoachMetadata + assigned COACH_CHECK3 & COACH_HELDOUT variants.
  const [
    meta,
    coachVariants,
    activeCatalog,
    priorCount,
    courseSnippets,
    studyCode,
    consentSnap,
  ] = await Promise.all([
    prisma.questionCoachMetadata.findUnique({
      where: { questionId: input.questionId },
    }),
    prisma.quizPracticeVersion.findMany({
      where: {
        quizId: examResult.quizId,
        status: "PUBLISHED",
        coachRole: { in: ["COACH_CHECK3", "COACH_HELDOUT"] },
        coachLabeledAt: { not: null },
      },
    }),
    getActiveMisconceptions(),
    prisma.wrongAnswerCoachSession.count({
      where: {
        studentId: input.studentId,
        questionId: input.questionId,
        state: "COMPLETED",
      },
    }),
    loadFrozenClassCourseSnippets(examResult.classId),
    getOrCreateStudentStudyCode(input.studentUserId),
    getStudentConsentSnapshot(input.studentUserId),
  ]);

  if (!meta || meta.status !== "READY" || meta.sourceHash !== snapshotHash) {
    throw new CoachHttpError(
      409,
      "This question is not ready for Wrong Answer Coach.",
    );
  }

  const check3Version = coachVariants.find(
    (v) => v.coachRole === "COACH_CHECK3",
  );
  const heldOutVersion = coachVariants.find(
    (v) => v.coachRole === "COACH_HELDOUT",
  );
  if (!check3Version || !heldOutVersion) {
    throw new CoachHttpError(
      409,
      "Alternative questions for Wrong Answer Coach are not configured yet.",
    );
  }

  const secondQuestion = extractVariantQuestionForSource(
    check3Version,
    input.questionId,
    snapshotHash,
  );
  const heldOutQuestion = extractVariantQuestionForSource(
    heldOutVersion,
    input.questionId,
    snapshotHash,
  );
  if (!secondQuestion || !heldOutQuestion) {
    throw new CoachHttpError(
      409,
      "Alternative questions do not match this question version.",
    );
  }

  // 6. Resolve Check 1 label from QuestionCoachMetadata (optionId -> unambiguous text fallback).
  let optionLabels: CoachOptionLabel[] = [];
  try {
    optionLabels = JSON.parse(meta.optionLabelsJson) as CoachOptionLabel[];
  } catch {
    optionLabels = [];
  }

  const initialFlags: CoachFlagCode[] = [];
  if (priorCount > 0) initialFlags.push("REPEAT_EXPOSURE");

  let matchedLabelEntry: CoachOptionLabel | undefined;
  if (wrongSelection.optionId) {
    matchedLabelEntry = optionLabels.find(
      (l) => l.optionId === wrongSelection.optionId && !l.isCorrect,
    );
  }
  if (!matchedLabelEntry) {
    const textMatches = optionLabels.filter(
      (l) =>
        !l.isCorrect &&
        l.optionText.trim().toLowerCase() ===
          wrongSelection.optionText.trim().toLowerCase(),
    );
    if (textMatches.length === 1) {
      matchedLabelEntry = textMatches[0];
    }
  }
  if (!matchedLabelEntry) {
    initialFlags.push("MISSING_OPTION_LABEL");
  }
  const check1Label = matchedLabelEntry?.misconceptionCode ?? null;

  // 7. Build complete frozen relevant misconceptions set:
  //    labels(original) ∪ labels(secondQuestion) ∪ labels(heldOutQuestion) ∪ meta extras
  //    so Check 2 can ALWAYS reach Rows 6 and 12 and never breaks on later deprecation!
  const codeSet = new Set<string>();
  const addCode = (c: string | null | undefined) => {
    if (c && c.trim()) codeSet.add(c.trim());
  };
  for (const l of optionLabels) addCode(l.misconceptionCode);
  for (const o of secondQuestion.options) addCode(o.misconceptionCode);
  for (const o of heldOutQuestion.options) addCode(o.misconceptionCode);
  try {
    const metaExtra = JSON.parse(meta.relevantMisconceptionsJson) as string[];
    for (const c of metaExtra) addCode(c);
  } catch {
    // ignore
  }

  // Include deprecated catalog statements if referenced by frozen option labels
  // so decision-table rows (e.g. Rows 1, 6, 12) remain reachable even if a
  // misconception was deprecated between labeling and session start.
  const missingCodes = [...codeSet].filter(
    (code) => !activeCatalog.some((m) => m.misconceptionId === code),
  );
  const deprecatedRows =
    missingCodes.length > 0
      ? await prisma.misconception.findMany({
          where: { misconceptionId: { in: missingCodes } },
          select: { misconceptionId: true, statement: true },
        })
      : [];

  const catalogById = new Map<string, string>([
    ...activeCatalog.map((m) => [m.misconceptionId, m.statement] as const),
    ...deprecatedRows.map((m) => [m.misconceptionId, m.statement] as const),
  ]);
  const relevantMisconceptions: CoachMisconceptionEntry[] = [...codeSet]
    .sort()
    .flatMap((code) => {
      const statement = catalogById.get(code);
      return statement ? [{ code, statement }] : [];
    });

  let keyPoints: string[] = [];
  try {
    const parsed = JSON.parse(meta.keyPointsJson);
    if (Array.isArray(parsed)) {
      keyPoints = parsed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    keyPoints = [];
  }

  // Preserve the exact option order shown to the student on this attempt so
  // choice letters (A/B/C...) match the quiz they just took.
  const labelById = new Map(optionLabels.map((l) => [l.optionId, l]));
  const orderedOriginalOptions: CoachOptionLabel[] = snapQuestion.options.map(
    (snapOpt, idx) => {
      const byId = snapOpt.optionId
        ? labelById.get(snapOpt.optionId)
        : undefined;
      const matched =
        byId ??
        optionLabels.find(
          (l) =>
            l.optionText.trim().toLowerCase() ===
            snapOpt.text.trim().toLowerCase(),
        );
      return (
        matched ?? {
          optionId: snapOpt.optionId ?? `opt_${idx}`,
          optionText: snapOpt.text,
          isCorrect: snapOpt.isCorrect,
          misconceptionCode: null,
          confidence: null,
        }
      );
    },
  );

  const frozenSnapshot: CoachFrozenSessionSnapshot = {
    protocolRevision: COACH_PROTOCOL_REVISION,
    sourceHash: snapshotHash,
    originalQuestion: {
      questionId: input.questionId,
      text: snapQuestion.text,
      options:
        orderedOriginalOptions.length > 0
          ? orderedOriginalOptions
          : optionLabels,
      correctOptionId: correctSnapOpt.optionId ?? "",
      correctOptionText: correctSnapOpt.text,
    },
    keyPoints,
    relevantMisconceptions,
    secondQuestion,
    heldOutQuestion,
    courseSnippets,
  };

  // 8. Create session + Step 3 opening prompt + admin-only ResearchMeta atomically;
  //    catch Prisma P2002 create race and return existing session cleanly.
  try {
    const created = await prisma.$transaction(async (tx) => {
      // Revalidate inside the write transaction that both Coach versions are
      // still live and labeled so a concurrent role swap cannot leave a new
      // session pointing at a version demoted to Practice.
      const liveCoachCount = await tx.quizPracticeVersion.count({
        where: {
          quizId: examResult.quizId,
          status: "PUBLISHED",
          coachLabeledAt: { not: null },
          OR: [
            { id: check3Version.id, coachRole: "COACH_CHECK3" },
            { id: heldOutVersion.id, coachRole: "COACH_HELDOUT" },
          ],
        },
      });
      if (liveCoachCount !== 2) {
        throw new CoachHttpError(
          409,
          "Alternative questions for Wrong Answer Coach were updated. Please try again.",
        );
      }
      const session = await tx.wrongAnswerCoachSession.create({
        data: {
          attemptId: input.attemptId,
          examResultId: examResult.id,
          studentId: input.studentId,
          studentUserId: input.studentUserId,
          classId: examResult.classId,
          quizId: examResult.quizId,
          questionId: input.questionId,
          questionIndex,
          check3VersionId: check3Version.id,
          heldOutVersionId: heldOutVersion.id,
          priorSessionCountForQuestion: priorCount,
          questionSnapshotJson: JSON.stringify(frozenSnapshot),
          chosenOptionId: wrongSelection.optionId,
          chosenOptionText: wrongSelection.optionText,
          state: "AWAITING_EXPLANATION",
          nextMessageSeq: 1,
          check1Label,
          flagsJson: JSON.stringify(initialFlags),
          hasFlags: initialFlags.length > 0,
          reviewStatus: initialFlags.length > 0 ? "PENDING" : "NONE",
          courseSnippetsUsedJson: JSON.stringify(courseSnippets),
          messages: {
            create: {
              seq: 0,
              role: "system",
              kind: "OPENING_PROMPT",
              content: COACH_FIXED_MESSAGES.openingPrompt,
            },
          },
          researchMeta: {
            create: {
              studentStudyCode: studyCode,
              consentStatus: consentSnap.consentStatus,
              consentFormVersion: consentSnap.consentFormVersion,
              protocolRevision: COACH_PROTOCOL_REVISION,
            },
          },
        },
        include: { messages: { orderBy: { seq: "asc" } } },
      });
      return session;
    });
    return toStudentSessionView(created);
  } catch (err) {
    const isUniqueConflict =
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "P2002";
    if (isUniqueConflict) {
      const raced = await prisma.wrongAnswerCoachSession.findUnique({
        where: {
          attemptId_questionId: {
            attemptId: input.attemptId,
            questionId: input.questionId,
          },
        },
        include: { messages: { orderBy: { seq: "asc" } } },
      });
      if (raced && raced.studentUserId === input.studentUserId) {
        return toStudentSessionView(raced);
      }
    }
    throw err;
  }
}

export async function getStudentCoachSession(
  sessionId: string,
  studentUserId: string,
): Promise<StudentCoachSessionView> {
  const session = await prisma.wrongAnswerCoachSession.findUnique({
    where: { id: sessionId },
    include: { messages: { orderBy: { seq: "asc" } } },
  });
  if (!session || session.studentUserId !== studentUserId) {
    throw new CoachHttpError(404, "Session not found.");
  }
  return toStudentSessionView(session);
}

// ─── 3. Check 2: 5-Run OpenAI Decisions API Execution ─────────────────────────

async function runSingleCheck2Slot(
  runIndex: number,
  provider: NonNullable<Awaited<ReturnType<typeof resolveProvider>>>,
  snapshot: CoachFrozenSessionSnapshot,
  explanationText: string,
): Promise<Check2RunSlot> {
  const allowedCodes = snapshot.relevantMisconceptions.map((m) => m.code);
  const reqPayload = buildCheck2DecisionsRequest(provider.model, {
    questionText: snapshot.originalQuestion.text,
    options: snapshot.originalQuestion.options.map((o) => o.optionText),
    correctOptionText: snapshot.originalQuestion.correctOptionText,
    keyPoints: snapshot.keyPoints,
    relevantMisconceptions: snapshot.relevantMisconceptions,
    studentExplanation: explanationText,
  });

  const slotStart = Date.now();
  const callOnce = async () => {
    try {
      return await createDecisions(provider, reqPayload);
    } catch (err) {
      // Single transient backoff retry on 429 / 5xx / timeout.
      if (err instanceof DecisionsApiError && err.transient) {
        await new Promise((r) => setTimeout(r, 400));
        return await createDecisions(provider, reqPayload);
      }
      throw err;
    }
  };

  let firstRes: Awaited<ReturnType<typeof createDecisions>> | null = null;
  let firstInvalidPayloadErr: string | null = null;
  try {
    firstRes = await callOnce();
  } catch (err) {
    if (
      err instanceof DecisionsApiError &&
      err.code === "INVALID_RESPONSE_PAYLOAD"
    ) {
      // HTTP 200 returned malformed/non-schema payload -> treat like invalid choice
      // (retry once, then settle as valid:false -> neither + CHECK2_PARSE_FAILURE).
      firstInvalidPayloadErr = errorMessage(err);
    } else {
      // Unrecovered transport/provider failure — do NOT silently become "neither"!
      return {
        runIndex,
        settled: false,
        valid: false,
        retried: false,
        choice: null,
        parsedKind: "neither",
        misconceptionCode: null,
        normalizedVoteKey: "neither",
        probabilities: [],
        confidence: null,
        evidence: null,
        rawResponse: null,
        error: errorMessage(err),
        model: provider.model,
        latencyMs: Math.max(0, Date.now() - slotStart),
      };
    }
  }

  const firstAns = firstRes?.answers.find(
    (a) => a.name === "check2_classification" && a.type === "choice",
  );
  const firstChoice = firstAns?.type === "choice" ? firstAns.choice : "";
  const firstMapped = firstRes
    ? mapDecisionChoiceToCheck2(firstChoice, allowedCodes)
    : null;

  if (firstRes && firstMapped?.valid && firstAns?.type === "choice") {
    return {
      runIndex,
      settled: true,
      valid: true,
      retried: false,
      choice: firstChoice,
      parsedKind: firstMapped.parsedKind,
      misconceptionCode: firstMapped.misconceptionCode,
      normalizedVoteKey: firstMapped.normalizedVoteKey,
      probabilities: firstAns.probabilities,
      confidence: firstAns.confidence,
      evidence: null,
      rawResponse: JSON.stringify(firstRes.raw),
      model: firstRes.model,
      latencyMs: firstRes.latencyMs,
    };
  }

  // Format/choice invalid -> retry THIS slot ONCE (PDF Table 5 Row 4).
  let retryRes: Awaited<ReturnType<typeof createDecisions>> | null = null;
  let retryInvalidPayloadErr: string | null = null;
  try {
    retryRes = await callOnce();
  } catch (err) {
    if (
      err instanceof DecisionsApiError &&
      err.code === "INVALID_RESPONSE_PAYLOAD"
    ) {
      retryInvalidPayloadErr = errorMessage(err);
    } else {
      return {
        runIndex,
        settled: false,
        valid: false,
        retried: true,
        choice: null,
        parsedKind: "neither",
        misconceptionCode: null,
        normalizedVoteKey: "neither",
        probabilities: [],
        confidence: null,
        evidence: null,
        rawResponse: firstRes
          ? JSON.stringify(firstRes.raw)
          : firstInvalidPayloadErr,
        error: errorMessage(err),
        model: provider.model,
        latencyMs: Math.max(0, Date.now() - slotStart),
      };
    }
  }

  const retryAns = retryRes?.answers.find(
    (a) => a.name === "check2_classification" && a.type === "choice",
  );
  const retryChoice = retryAns?.type === "choice" ? retryAns.choice : "";
  const retryMapped = retryRes
    ? mapDecisionChoiceToCheck2(retryChoice, allowedCodes)
    : {
        valid: false,
        parsedKind: "neither" as const,
        misconceptionCode: null,
        normalizedVoteKey: "neither",
      };

  return {
    runIndex,
    settled: true,
    valid: retryMapped.valid,
    retried: true,
    choice: retryChoice || null,
    parsedKind: retryMapped.parsedKind,
    misconceptionCode: retryMapped.misconceptionCode,
    normalizedVoteKey: retryMapped.normalizedVoteKey,
    probabilities: retryAns?.type === "choice" ? retryAns.probabilities : [],
    confidence: retryAns?.type === "choice" ? retryAns.confidence : null,
    evidence: null,
    rawResponse: firstRes
      ? JSON.stringify(firstRes.raw)
      : firstInvalidPayloadErr,
    retryRawResponse: retryRes
      ? JSON.stringify(retryRes.raw)
      : retryInvalidPayloadErr,
    model: retryRes?.model ?? provider.model,
    latencyMs: Math.max(0, Date.now() - slotStart),
  };
}

async function executeCheck2AndAdvance(input: {
  sessionId: string;
  studentUserId: string;
  processingToken: string;
  explanationText: string;
  snapshot: CoachFrozenSessionSnapshot;
  existingSlots: Check2RunSlot[];
}): Promise<StudentCoachSessionView> {
  const provider = await resolveProvider("wrong_answer_coach_classify");
  if (!provider) {
    await prisma.wrongAnswerCoachSession.updateMany({
      where: { id: input.sessionId, processingToken: input.processingToken },
      data: {
        state: "CLASSIFYING_FAILED",
        processingStep: null,
        processingToken: null,
        processingStartedAt: null,
        lastActivityAt: new Date(),
      },
    });
    throw new CoachHttpError(
      503,
      "The explanation classifier is temporarily unavailable. Please try again.",
    );
  }

  const startedAt = Date.now();
  const slotBuffer: Array<Check2RunSlot | null> = [0, 1, 2, 3, 4].map(
    (idx) =>
      input.existingSlots.find((s) => s.runIndex === idx && s.settled) ?? null,
  );
  // Serialize incremental DB checkpoints so finished votes survive a mid-batch crash.
  let persistChain = Promise.resolve();
  const checkpointSlot = (slot: Check2RunSlot) => {
    slotBuffer[slot.runIndex] = slot;
    if (!slot.settled) return;
    const snapshotJson = JSON.stringify(
      slotBuffer.filter((s): s is Check2RunSlot => s !== null),
    );
    persistChain = persistChain
      .then(async () => {
        await prisma.wrongAnswerCoachSession.updateMany({
          where: {
            id: input.sessionId,
            processingToken: input.processingToken,
          },
          data: { check2RunsJson: snapshotJson },
        });
      })
      .catch(() => {});
  };

  // Run only unsettled slots (all 5 on first run; subset on partial-failure retry).
  const settledResults = await Promise.allSettled(
    [0, 1, 2, 3, 4].map(async (runIndex) => {
      const prior = slotBuffer[runIndex];
      if (prior) return prior;
      const slot = await runSingleCheck2Slot(
        runIndex,
        provider,
        input.snapshot,
        input.explanationText,
      );
      checkpointSlot(slot);
      return slot;
    }),
  );
  await persistChain;

  const slots: Check2RunSlot[] = settledResults.map((res, runIndex) => {
    if (res.status === "fulfilled") return res.value;
    return {
      runIndex,
      settled: false,
      valid: false,
      retried: false,
      choice: null,
      parsedKind: "neither",
      misconceptionCode: null,
      normalizedVoteKey: "neither",
      probabilities: [],
      confidence: null,
      evidence: null,
      rawResponse: null,
      error: errorMessage(res.reason),
      model: provider.model,
      latencyMs: 0,
    };
  });

  const allSettled = slots.every((s) => s.settled);
  const totalMs = Math.max(0, Date.now() - startedAt);

  if (!allSettled) {
    await prisma.wrongAnswerCoachSession.updateMany({
      where: { id: input.sessionId, processingToken: input.processingToken },
      data: {
        state: "CLASSIFYING_FAILED",
        check2RunsJson: JSON.stringify(slots),
        classifierModel: provider.model,
        classifierProvider: provider.providerType,
        classifierApiSurface: "decisions",
        classifierPromptVersion: `${CHECK2_PROMPT_VERSION}#${CHECK2_PROMPT_TEMPLATE_HASH}`,
        processingStep: null,
        processingToken: null,
        processingStartedAt: null,
        lastActivityAt: new Date(),
      },
    });
    throw new CoachHttpError(
      503,
      "We hit a temporary issue while analyzing your explanation. Click Try again to continue.",
    );
  }

  const agg = aggregateCheck2Runs(slots);
  const tokens = mintOpaqueMcqTokens(
    input.snapshot.secondQuestion,
    `${input.sessionId}:second`,
  );

  // Commit Check 2 outcome + Step 6 prompt atomically, fenced by processingToken!
  const updated = await prisma.$transaction(async (tx) => {
    const current = await tx.wrongAnswerCoachSession.findUnique({
      where: { id: input.sessionId },
    });
    if (!current || current.processingToken !== input.processingToken) {
      return null; // Lease expired / stolen — discard late result!
    }
    const merged = mergeFlags(current.flagsJson, agg.flags);
    const seq = current.nextMessageSeq;

    await tx.wrongAnswerCoachMessage.create({
      data: {
        sessionId: current.id,
        seq,
        role: "system",
        kind: "SECOND_QUESTION_PROMPT",
        content: COACH_FIXED_MESSAGES.beforeSecondQuestion,
        metadata: JSON.stringify({
          text: input.snapshot.secondQuestion.text,
          options: tokens.map((t) => ({ label: t.label, text: t.text })),
        }),
      },
    });

    const nextReviewStatus =
      merged.hasFlags && (current.reviewStatus === "NONE" || merged.addedNew)
        ? "PENDING"
        : current.reviewStatus;

    return tx.wrongAnswerCoachSession.update({
      where: { id: current.id },
      data: {
        state: "AWAITING_SECOND_QUESTION",
        nextMessageSeq: seq + 1,
        check2RunsJson: JSON.stringify(slots),
        check2ResultKind: agg.outcome.kind,
        check2MisconceptionCode: agg.outcome.code,
        check2TopVoteCount: agg.topVoteCount,
        check2VoteHistogramJson: JSON.stringify(agg.histogram),
        check2MeanConfidence: agg.meanConfidence,
        check2WasTie: agg.wasTie,
        secondQuestionTokensJson: JSON.stringify(tokens),
        classifierModel: provider.model,
        classifierProvider: provider.providerType,
        classifierApiSurface: "decisions",
        classifierPromptVersion: `${CHECK2_PROMPT_VERSION}#${CHECK2_PROMPT_TEMPLATE_HASH}`,
        classifierRequestParamsJson: JSON.stringify({
          endpoint: "/v1/decisions",
          model: provider.model,
          runs: 5,
        }),
        classifierTotalMs: totalMs,
        flagsJson: merged.flagsJson,
        hasFlags: merged.hasFlags,
        reviewStatus: nextReviewStatus,
        processingStep: null,
        processingToken: null,
        processingStartedAt: null,
        lastActivityAt: new Date(),
      },
      include: { messages: { orderBy: { seq: "asc" } } },
    });
  });

  if (!updated) {
    return getStudentCoachSession(input.sessionId, input.studentUserId);
  }
  return toStudentSessionView(updated);
}

// ─── 4. Task B: Tutoring Generation with Unified 1-Retry + Fallback ──────────

async function runTaskBAndComplete(input: {
  sessionId: string;
  studentUserId: string;
  processingToken: string;
}): Promise<StudentCoachSessionView> {
  const row = await prisma.wrongAnswerCoachSession.findUnique({
    where: { id: input.sessionId },
  });
  if (!row || row.processingToken !== input.processingToken) {
    return getStudentCoachSession(input.sessionId, input.studentUserId);
  }

  const snapshot = JSON.parse(
    row.questionSnapshotJson,
  ) as CoachFrozenSessionSnapshot;
  const diagnosis = (row.diagnosis ?? "KNOWLEDGE_GAP") as
    "SLIP" | "KNOWLEDGE_GAP" | "MISCONCEPTION";
  const misconception =
    diagnosis === "MISCONCEPTION" && row.diagnosisMisconceptionCode
      ? (snapshot.relevantMisconceptions.find(
          (m) => m.code === row.diagnosisMisconceptionCode,
        ) ?? {
          code: row.diagnosisMisconceptionCode,
          statement: row.diagnosisMisconceptionCode,
        })
      : null;

  const correctOptionText = snapshot.originalQuestion.correctOptionText;
  const distractorTexts = snapshot.originalQuestion.options
    .filter((o) => !o.isCorrect)
    .map((o) => o.optionText);
  const declarationWords = countCoachWords(
    `The correct answer is: ${correctOptionText}.`,
  );
  const maxBodyWords = Math.max(1, COACH_TUTORING_MAX_WORDS - declarationWords);

  let provider: Awaited<ReturnType<typeof resolveProvider>> = null;
  let client: Awaited<ReturnType<typeof createOpenAIClient>> | null = null;
  let setupError: string | null = null;
  try {
    provider = await resolveProvider("wrong_answer_coach_tutor");
    if (provider) {
      client = await createOpenAIClient(provider);
    }
  } catch (err) {
    setupError = errorMessage(err);
  }

  const attempts: TutoringAttemptRecord[] = [];
  let finalStructured: StructuredTutoringMessage | null = null;
  let finalPlainText: string | null = null;
  let usedFallback = false;
  let providerErrorOccurred = false;
  let totalTokens = 0;
  let totalMs = 0;

  if (!provider || !client || setupError) {
    providerErrorOccurred = true;
    attempts.push({
      attempt: 1,
      rawText: null,
      parsedBody: null,
      valid: false,
      failureReasons: [],
      providerError:
        setupError ||
        "No active provider assigned to wrong_answer_coach_tutor.",
      model: provider?.model ?? null,
      latencyMs: 0,
    });
  } else {
    const transport = transportFor(provider);
    const baseMessages = buildTutorPromptMessages({
      diagnosis,
      misconception,
      questionText: snapshot.originalQuestion.text,
      correctOptionText,
      chosenOptionText: row.chosenOptionText,
      keyPoints: snapshot.keyPoints,
      studentExplanation: row.explanationText ?? "",
      courseSnippets: snapshot.courseSnippets,
      maxBodyWords,
    });

    let lastFailureFeedback = "";
    for (let attemptNum = 1; attemptNum <= 2; attemptNum++) {
      const attemptStart = Date.now();
      const messages =
        attemptNum === 1
          ? baseMessages
          : [
              ...baseMessages,
              {
                role: "user" as const,
                content: `Your previous draft failed validation: ${lastFailureFeedback}. Rewrite explanation_body cleanly within ${maxBodyWords} words, never naming option letters or calling any wrong option correct.`,
              },
            ];

      const abortController = new AbortController();
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      try {
        const res = await Promise.race([
          streamJsonCompletion<{ explanation_body: string }>(
            client,
            {
              model: provider.model,
              messages,
              ...thinkingParams(provider),
            },
            TUTOR_JSON_SCHEMA,
            streamOptionsFor(transport, {
              requestOptions: {
                maxRetries: 0,
                signal: abortController.signal,
              },
            }),
          ),
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => {
              abortController.abort();
              reject(new Error("Tutor generation timed out."));
            }, TUTOR_TIMEOUT_MS);
          }),
        ]);

        const latencyMs = Math.max(0, Date.now() - attemptStart);
        totalMs += latencyMs;
        totalTokens += res.metrics.completionTokens;

        const body =
          typeof res.value?.explanation_body === "string"
            ? res.value.explanation_body
            : "";
        const validation = validateTutoringMessage({
          explanationBody: body,
          correctOptionText,
          distractorTexts,
        });

        attempts.push({
          attempt: attemptNum,
          rawText: res.text,
          parsedBody: body,
          valid: validation.valid,
          failureReasons: validation.reasons,
          model: provider.model,
          latencyMs,
        });

        if (validation.valid) {
          finalStructured = validation.structured;
          finalPlainText = validation.plainText;
          break;
        }
        lastFailureFeedback = validation.reasons.join(" ");
      } catch (err) {
        const latencyMs = Math.max(0, Date.now() - attemptStart);
        totalMs += latencyMs;
        providerErrorOccurred = true;
        const msg = errorMessage(err);
        attempts.push({
          attempt: attemptNum,
          rawText: null,
          parsedBody: null,
          valid: false,
          failureReasons: [],
          providerError: msg,
          model: provider.model,
          latencyMs,
        });
        lastFailureFeedback = msg;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
    }
  }

  const addedFlags: CoachFlagCode[] = [];
  if (!finalStructured || !finalPlainText) {
    usedFallback = true;
    const fb = buildTutoringFallbackMessage({
      correctAnswerText: correctOptionText,
      keyPoints: snapshot.keyPoints,
    });
    finalStructured = fb.structured;
    finalPlainText = fb.plainText;
    addedFlags.push("TUTORING_FALLBACK");
    if (providerErrorOccurred) addedFlags.push("TUTORING_PROVIDER_ERROR");
  }

  const now = new Date();
  const completed = await prisma.$transaction(async (tx) => {
    const current = await tx.wrongAnswerCoachSession.findUnique({
      where: { id: input.sessionId },
    });
    if (!current || current.processingToken !== input.processingToken) {
      return null; // Lease stolen — discard late write!
    }
    const merged = mergeFlags(current.flagsJson, addedFlags);
    const seq = current.nextMessageSeq;

    await tx.wrongAnswerCoachMessage.create({
      data: {
        sessionId: current.id,
        seq,
        role: "assistant",
        kind: usedFallback ? "TUTORING_FALLBACK" : "TUTORING_MESSAGE",
        content: finalPlainText!,
      },
    });

    const nextReviewStatus =
      merged.hasFlags && (current.reviewStatus === "NONE" || merged.addedNew)
        ? "PENDING"
        : current.reviewStatus;

    return tx.wrongAnswerCoachSession.update({
      where: { id: current.id },
      data: {
        state: "COMPLETED",
        endedReason: "COMPLETED",
        nextMessageSeq: seq + 1,
        completedAt: now,
        tutoringMessage: finalPlainText,
        tutoringStructuredJson: JSON.stringify(finalStructured),
        tutoringAttemptsJson: JSON.stringify(attempts),
        tutoringUsedFallback: usedFallback,
        tutoringGeneratedAt: now,
        tutoringDeliveredAt: now,
        tutorModel: provider?.model ?? null,
        tutorProvider: provider?.providerType ?? null,
        tutorPromptVersion: TUTOR_PROMPT_VERSION,
        tutorRequestParamsJson: provider
          ? JSON.stringify({
              model: provider.model,
              thinkingLevel: provider.thinkingLevel,
              maxWords: COACH_TUTORING_MAX_WORDS,
            })
          : null,
        tutorTokens: totalTokens || null,
        tutorTotalMs: totalMs || null,
        flagsJson: merged.flagsJson,
        hasFlags: merged.hasFlags,
        reviewStatus: nextReviewStatus,
        processingStep: null,
        processingToken: null,
        processingStartedAt: null,
        lastActivityAt: now,
      },
      include: { messages: { orderBy: { seq: "asc" } } },
    });
  });

  if (!completed) {
    return getStudentCoachSession(input.sessionId, input.studentUserId);
  }
  return toStudentSessionView(completed);
}

// ─── 5. Main Turn Handler ─────────────────────────────────────────────────────

export type CoachTurnPayload =
  | { type: "explanation"; text: string }
  | { type: "retry_classification" }
  | { type: "second_question"; optionToken: string }
  | { type: "held_out_question"; optionToken: string }
  | { type: "free_text"; text: string }
  | { type: "leave" };

async function runSafetyPreChecks(
  text: string,
  sessionId: string,
  userId: string,
): Promise<{
  crisis: boolean;
  jailbreakOrOffTopic: boolean;
}> {
  const localCrisis = matchesLocalCrisisPattern(text);
  const settings = await getGuardrailSettings();

  let modCrisis = false;
  if (moderationEnabledFor(settings, "wrong_answer_coach")) {
    const mod = await moderateText(text, {
      surface: "wrong_answer_coach",
      id: sessionId,
      userId,
    });
    if (
      mod.checked &&
      mod.flagged &&
      mod.categories.some(
        (c) =>
          c.startsWith("self-harm") ||
          c.startsWith("violence") ||
          c === "harassment/threatening",
      )
    ) {
      modCrisis = true;
    }
  }

  // Explicit OR semantics: either local crisis match OR moderation flag triggers!
  if (localCrisis || modCrisis) {
    return { crisis: true, jailbreakOrOffTopic: false };
  }

  let jailbreakOrOffTopic = false;
  const policy = policyFor(settings, "wrong_answer_coach");
  const safety = await checkContentSafety(
    text,
    { surface: "wrong_answer_coach", id: sessionId, userId },
    { policy, topicDescription: settings.topicDescription },
  );
  if (safety.checked && safety.result) {
    const jbHit =
      policy.jailbreakMode !== "OFF" &&
      safety.result.jailbreak.detected &&
      safety.result.jailbreak.confidence >= policy.jailbreakThreshold;
    const otHit =
      policy.offTopicMode !== "OFF" &&
      safety.result.offTopic.detected &&
      safety.result.offTopic.confidence >= policy.offTopicThreshold;
    if (jbHit || otHit) jailbreakOrOffTopic = true;
  }

  return { crisis: false, jailbreakOrOffTopic };
}

export async function handleCoachTurn(input: {
  sessionId: string;
  studentUserId: string;
  payload: CoachTurnPayload;
}): Promise<StudentCoachSessionView> {
  const session = await prisma.wrongAnswerCoachSession.findUnique({
    where: { id: input.sessionId },
    include: { messages: { orderBy: { seq: "asc" } } },
  });
  if (!session || session.studentUserId !== input.studentUserId) {
    throw new CoachHttpError(404, "Session not found.");
  }

  if (session.state === "COMPLETED" || session.state === "INCOMPLETE") {
    throw new CoachHttpError(409, "This chat session has already ended.");
  }

  // Re-check retake lock & consent gate on every active turn (except explicit leave)
  // so reopening graded retakes or withdrawing consent stops further collection/disclosure.
  if (input.payload.type !== "leave") {
    const [retakeable, consentOk] = await Promise.all([
      isQuizRetakeStillPossible(
        session.studentId,
        session.classId,
        session.quizId,
      ),
      isCoachConsentEligible(input.studentUserId),
    ]);
    if (retakeable) {
      throw new CoachHttpError(
        409,
        "A new quiz attempt is currently open for this quiz. Complete your quiz attempts before continuing this chat.",
      );
    }
    if (!consentOk) {
      await prisma.wrongAnswerCoachSession.updateMany({
        where: {
          id: session.id,
          state: { notIn: ["COMPLETED", "INCOMPLETE"] },
        },
        data: {
          state: "INCOMPLETE",
          endedReason: "CONSENT_WITHDRAWN",
          processingStep: null,
          processingToken: null,
          processingStartedAt: null,
          lastActivityAt: new Date(),
        },
      });
      throw new CoachHttpError(
        403,
        "Wrong Answer Coach is no longer available for this session.",
      );
    }
  }

  // Active lock check (prevent concurrent mutations while AI work is in flight).
  if (
    session.processingStep &&
    session.processingStartedAt &&
    Date.now() - session.processingStartedAt.getTime() < LEASE_TTL_MS
  ) {
    throw new CoachHttpError(
      409,
      "Still processing your previous response. Please wait a moment.",
    );
  }

  const snapshot = JSON.parse(
    session.questionSnapshotJson,
  ) as CoachFrozenSessionSnapshot;
  const { payload } = input;

  // ── Explicit Leave ("End chat") ──
  if (payload.type === "leave") {
    if (session.state === "GENERATING_TUTORING") {
      throw new CoachHttpError(
        409,
        "Your final explanation is being prepared and will appear in a moment.",
      );
    }
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.wrongAnswerCoachSession.findUnique({
        where: { id: session.id },
      });
      if (
        !current ||
        current.state === "COMPLETED" ||
        current.state === "INCOMPLETE" ||
        current.state === "GENERATING_TUTORING"
      ) {
        return null;
      }
      const merged = mergeFlags(current.flagsJson, ["INCOMPLETE_SESSION"]);
      return tx.wrongAnswerCoachSession.update({
        where: { id: current.id },
        data: {
          state: "INCOMPLETE",
          endedReason: "STUDENT_ENDED",
          flagsJson: merged.flagsJson,
          hasFlags: merged.hasFlags,
          reviewStatus:
            merged.hasFlags &&
            (current.reviewStatus === "NONE" || merged.addedNew)
              ? "PENDING"
              : current.reviewStatus,
          processingStep: null,
          processingToken: null,
          processingStartedAt: null,
          lastActivityAt: new Date(),
        },
        include: { messages: { orderBy: { seq: "asc" } } },
      });
    });
    if (!updated) {
      return getStudentCoachSession(session.id, input.studentUserId);
    }
    return toStudentSessionView(updated);
  }

  // ── Retry Failed Check 2 Classification (On Stored Explanation!) ──
  if (payload.type === "retry_classification") {
    const isStaleCheck2InAwaiting =
      session.state === "AWAITING_EXPLANATION" &&
      session.explanationSubmittedAt !== null &&
      session.explanationText !== null;
    if (
      (session.state !== "CLASSIFYING_FAILED" && !isStaleCheck2InAwaiting) ||
      session.explanationText === null
    ) {
      throw new CoachHttpError(409, "No failed classification to retry.");
    }
    const token = randomUUID();
    const now = new Date();
    const claimed = await prisma.wrongAnswerCoachSession.updateMany({
      where: {
        id: session.id,
        state: { in: ["CLASSIFYING_FAILED", "AWAITING_EXPLANATION"] },
        explanationSubmittedAt: { not: null },
        OR: [
          { processingStep: null },
          { processingStartedAt: { lt: new Date(Date.now() - LEASE_TTL_MS) } },
        ],
      },
      data: {
        state: "CLASSIFYING_FAILED",
        processingStep: "CHECK2",
        processingToken: token,
        processingStartedAt: now,
        lastActivityAt: now,
      },
    });
    if (claimed.count !== 1) {
      throw new CoachHttpError(409, "Classification is already in progress.");
    }
    let existingSlots: Check2RunSlot[] = [];
    if (session.check2RunsJson) {
      try {
        existingSlots = JSON.parse(session.check2RunsJson) as Check2RunSlot[];
      } catch {
        existingSlots = [];
      }
    }
    return executeCheck2AndAdvance({
      sessionId: session.id,
      studentUserId: input.studentUserId,
      processingToken: token,
      explanationText: session.explanationText,
      snapshot,
      existingSlots,
    });
  }

  // ── Free Text During MCQ Steps (Steps 7 & 9 Only) ──
  if (payload.type === "free_text") {
    if (
      session.state !== "AWAITING_SECOND_QUESTION" &&
      session.state !== "AWAITING_HELDOUT_QUESTION"
    ) {
      throw new CoachHttpError(
        400,
        "Please submit your response using the active step input.",
      );
    }
    const text = payload.text.trim();
    if (!text) {
      throw new CoachHttpError(400, "Message cannot be empty.");
    }
    const safety = await runSafetyPreChecks(
      text,
      session.id,
      input.studentUserId,
    );
    let replyKind:
      "SUPPORT_REDIRECT" | "ANSWER_REFUSAL" | "OFF_TOPIC_REDIRECT" =
      "ANSWER_REFUSAL";
    let replyContent: string = COACH_FIXED_MESSAGES.mcqPickChoicePrompt;
    const addFlags: CoachFlagCode[] = [];

    if (safety.crisis) {
      replyKind = "SUPPORT_REDIRECT";
      replyContent = COACH_FIXED_MESSAGES.personalSupportRedirect;
      addFlags.push("PERSONAL_SUPPORT_NEEDED");
    } else if (isAnswerRequest(text, true)) {
      replyKind = "ANSWER_REFUSAL";
      replyContent = COACH_FIXED_MESSAGES.answerRequestRefusal;
    } else if (safety.jailbreakOrOffTopic) {
      replyKind = "OFF_TOPIC_REDIRECT";
      replyContent = COACH_FIXED_MESSAGES.offTopicMcqRedirect;
      addFlags.push("OFF_TOPIC");
    }

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.wrongAnswerCoachSession.findUnique({
        where: { id: session.id },
      });
      if (!current || current.state !== session.state) return null;
      const merged = mergeFlags(current.flagsJson, addFlags);
      const seq = current.nextMessageSeq;
      await tx.wrongAnswerCoachMessage.createMany({
        data: [
          {
            sessionId: current.id,
            seq,
            role: "student",
            kind: "STUDENT_FREE_TEXT",
            content: text,
          },
          {
            sessionId: current.id,
            seq: seq + 1,
            role: "system",
            kind: replyKind,
            content: replyContent,
          },
        ],
      });
      // Repeat crisis messages MUST ALWAYS reopen reviewStatus to PENDING!
      const nextReviewStatus = safety.crisis
        ? "PENDING"
        : merged.hasFlags &&
            (current.reviewStatus === "NONE" || merged.addedNew)
          ? "PENDING"
          : current.reviewStatus;
      return tx.wrongAnswerCoachSession.update({
        where: { id: current.id },
        data: {
          nextMessageSeq: seq + 2,
          flagsJson: merged.flagsJson,
          hasFlags: merged.hasFlags,
          reviewStatus: nextReviewStatus,
          lastActivityAt: new Date(),
        },
        include: { messages: { orderBy: { seq: "asc" } } },
      });
    });
    if (!updated)
      return getStudentCoachSession(session.id, input.studentUserId);
    return toStudentSessionView(updated);
  }

  // ── Step 4: Student Explanation ──
  if (payload.type === "explanation") {
    if (session.state !== "AWAITING_EXPLANATION") {
      throw new CoachHttpError(409, "Explanation was already submitted.");
    }

    const rawText = payload.text;
    const trimmed = rawText.trim();

    // Priority 1: Crisis / personal support (explicit OR semantics)
    if (trimmed.length > 0) {
      const safety = await runSafetyPreChecks(
        trimmed,
        session.id,
        input.studentUserId,
      );
      if (safety.crisis) {
        const updated = await prisma.$transaction(async (tx) => {
          const current = await tx.wrongAnswerCoachSession.findUnique({
            where: { id: session.id },
          });
          if (!current || current.state !== "AWAITING_EXPLANATION") return null;
          const merged = mergeFlags(current.flagsJson, [
            "PERSONAL_SUPPORT_NEEDED",
          ]);
          const seq = current.nextMessageSeq;
          await tx.wrongAnswerCoachMessage.createMany({
            data: [
              {
                sessionId: current.id,
                seq,
                role: "student",
                kind: "STUDENT_FREE_TEXT",
                content: rawText,
              },
              {
                sessionId: current.id,
                seq: seq + 1,
                role: "system",
                kind: "SUPPORT_REDIRECT",
                content: COACH_FIXED_MESSAGES.personalSupportRedirect,
              },
            ],
          });
          return tx.wrongAnswerCoachSession.update({
            where: { id: current.id },
            data: {
              nextMessageSeq: seq + 2,
              flagsJson: merged.flagsJson,
              hasFlags: merged.hasFlags,
              reviewStatus: "PENDING",
              lastActivityAt: new Date(),
            },
            include: { messages: { orderBy: { seq: "asc" } } },
          });
        });
        if (!updated)
          return getStudentCoachSession(session.id, input.studentUserId);
        return toStudentSessionView(updated);
      }

      // Priority 3: Explicit answer-seeking request (does NOT consume explanation turn)
      if (isAnswerRequest(trimmed, false)) {
        const updated = await prisma.$transaction(async (tx) => {
          const current = await tx.wrongAnswerCoachSession.findUnique({
            where: { id: session.id },
          });
          if (!current || current.state !== "AWAITING_EXPLANATION") return null;
          const seq = current.nextMessageSeq;
          await tx.wrongAnswerCoachMessage.createMany({
            data: [
              {
                sessionId: current.id,
                seq,
                role: "student",
                kind: "STUDENT_FREE_TEXT",
                content: rawText,
              },
              {
                sessionId: current.id,
                seq: seq + 1,
                role: "system",
                kind: "ANSWER_REFUSAL",
                content: COACH_FIXED_MESSAGES.answerRequestRefusal,
              },
            ],
          });
          return tx.wrongAnswerCoachSession.update({
            where: { id: current.id },
            data: {
              nextMessageSeq: seq + 2,
              lastActivityAt: new Date(),
            },
            include: { messages: { orderBy: { seq: "asc" } } },
          });
        });
        if (!updated)
          return getStudentCoachSession(session.id, input.studentUserId);
        return toStudentSessionView(updated);
      }

      // Priority 4: Prompt injection / blatantly off-topic -> single-turn rule:
      // save explanation verbatim, send offTopicRedirect, flag OFF_TOPIC,
      // record Check 2 = "neither", advance directly to Step 6!
      if (safety.jailbreakOrOffTopic) {
        const tokens = mintOpaqueMcqTokens(
          snapshot.secondQuestion,
          `${session.id}:second`,
        );
        const now = new Date();
        const updated = await prisma.$transaction(async (tx) => {
          const current = await tx.wrongAnswerCoachSession.findUnique({
            where: { id: session.id },
          });
          if (!current || current.state !== "AWAITING_EXPLANATION") return null;
          const merged = mergeFlags(current.flagsJson, ["OFF_TOPIC"]);
          const seq = current.nextMessageSeq;
          await tx.wrongAnswerCoachMessage.createMany({
            data: [
              {
                sessionId: current.id,
                seq,
                role: "student",
                kind: "STUDENT_EXPLANATION",
                content: rawText,
              },
              {
                sessionId: current.id,
                seq: seq + 1,
                role: "system",
                kind: "OFF_TOPIC_REDIRECT",
                content: COACH_FIXED_MESSAGES.offTopicRedirect,
              },
              {
                sessionId: current.id,
                seq: seq + 2,
                role: "system",
                kind: "SECOND_QUESTION_PROMPT",
                content: COACH_FIXED_MESSAGES.beforeSecondQuestion,
                metadata: JSON.stringify({
                  text: snapshot.secondQuestion.text,
                  options: tokens.map((t) => ({
                    label: t.label,
                    text: t.text,
                  })),
                }),
              },
            ],
          });
          return tx.wrongAnswerCoachSession.update({
            where: { id: current.id },
            data: {
              state: "AWAITING_SECOND_QUESTION",
              nextMessageSeq: seq + 3,
              explanationText: rawText,
              explanationSubmittedAt: now,
              check2ShortCircuitReason: "OFF_TOPIC",
              check2RunsJson: "[]",
              check2ResultKind: "neither",
              check2MisconceptionCode: null,
              check2VoteHistogramJson: "{}",
              secondQuestionTokensJson: JSON.stringify(tokens),
              flagsJson: merged.flagsJson,
              hasFlags: merged.hasFlags,
              reviewStatus: "PENDING",
              lastActivityAt: now,
            },
            include: { messages: { orderBy: { seq: "asc" } } },
          });
        });
        if (!updated)
          return getStudentCoachSession(session.id, input.studentUserId);
        return toStudentSessionView(updated);
      }
    }

    // Priority 2: Pure empty / whitespace-only -> deterministic "neither" -> Step 6!
    if (trimmed.length === 0) {
      const tokens = mintOpaqueMcqTokens(
        snapshot.secondQuestion,
        `${session.id}:second`,
      );
      const now = new Date();
      const updated = await prisma.$transaction(async (tx) => {
        const current = await tx.wrongAnswerCoachSession.findUnique({
          where: { id: session.id },
        });
        if (!current || current.state !== "AWAITING_EXPLANATION") return null;
        const seq = current.nextMessageSeq;
        await tx.wrongAnswerCoachMessage.createMany({
          data: [
            {
              sessionId: current.id,
              seq,
              role: "student",
              kind: "STUDENT_EXPLANATION",
              content: "",
            },
            {
              sessionId: current.id,
              seq: seq + 1,
              role: "system",
              kind: "SECOND_QUESTION_PROMPT",
              content: COACH_FIXED_MESSAGES.beforeSecondQuestion,
              metadata: JSON.stringify({
                text: snapshot.secondQuestion.text,
                options: tokens.map((t) => ({ label: t.label, text: t.text })),
              }),
            },
          ],
        });
        return tx.wrongAnswerCoachSession.update({
          where: { id: current.id },
          data: {
            state: "AWAITING_SECOND_QUESTION",
            nextMessageSeq: seq + 2,
            explanationText: "",
            explanationSubmittedAt: now,
            check2ShortCircuitReason: "EMPTY",
            check2RunsJson: "[]",
            check2ResultKind: "neither",
            check2MisconceptionCode: null,
            check2VoteHistogramJson: "{}",
            secondQuestionTokensJson: JSON.stringify(tokens),
            lastActivityAt: now,
          },
          include: { messages: { orderBy: { seq: "asc" } } },
        });
      });
      if (!updated)
        return getStudentCoachSession(session.id, input.studentUserId);
      return toStudentSessionView(updated);
    }

    // Priority 5: Substantive explanation -> claim lease + save explanation in
    // short TX 1, then run 5× Decisions API calls outside TX!
    const token = randomUUID();
    const now = new Date();
    const claimed = await prisma.$transaction(async (tx) => {
      const lock = await tx.wrongAnswerCoachSession.updateMany({
        where: {
          id: session.id,
          state: "AWAITING_EXPLANATION",
          explanationSubmittedAt: null,
          OR: [
            { processingStep: null },
            {
              processingStartedAt: { lt: new Date(Date.now() - LEASE_TTL_MS) },
            },
          ],
        },
        data: {
          explanationText: rawText,
          explanationSubmittedAt: now,
          processingStep: "CHECK2",
          processingToken: token,
          processingStartedAt: now,
          lastActivityAt: now,
        },
      });
      if (lock.count !== 1) return false;

      const current = await tx.wrongAnswerCoachSession.findUniqueOrThrow({
        where: { id: session.id },
        select: { nextMessageSeq: true },
      });
      await tx.wrongAnswerCoachMessage.create({
        data: {
          sessionId: session.id,
          seq: current.nextMessageSeq,
          role: "student",
          kind: "STUDENT_EXPLANATION",
          content: rawText,
        },
      });
      await tx.wrongAnswerCoachSession.update({
        where: { id: session.id },
        data: { nextMessageSeq: current.nextMessageSeq + 1 },
      });
      return true;
    });

    if (!claimed) {
      throw new CoachHttpError(409, "Explanation was already submitted.");
    }

    return executeCheck2AndAdvance({
      sessionId: session.id,
      studentUserId: input.studentUserId,
      processingToken: token,
      explanationText: rawText,
      snapshot,
      existingSlots: [],
    });
  }

  // ── Step 7 -> Step 8 -> Step 9: Second Question (Check 3) + Diagnosis + Held-Out ──
  if (payload.type === "second_question") {
    if (session.state !== "AWAITING_SECOND_QUESTION") {
      throw new CoachHttpError(
        409,
        "Second question is not active for this session.",
      );
    }
    if (!session.secondQuestionTokensJson) {
      throw new CoachHttpError(500, "Second question options missing.");
    }
    const tokens = JSON.parse(
      session.secondQuestionTokensJson,
    ) as OpaqueMcqTokenEntry[];
    const chosenToken = tokens.find(
      (t) => t.optionToken === payload.optionToken,
    );
    if (!chosenToken) {
      throw new CoachHttpError(400, "Invalid answer option.");
    }
    const variantOpt = snapshot.secondQuestion.options.find(
      (o) => o.id === chosenToken.variantOptionId,
    );
    if (!variantOpt) {
      throw new CoachHttpError(500, "Option mapping corrupted.");
    }

    const check2Outcome =
      session.check2ResultKind === "misconception" &&
      session.check2MisconceptionCode
        ? ({
            kind: "misconception",
            code: session.check2MisconceptionCode,
          } as const)
        : session.check2ResultKind === "sound"
          ? ({ kind: "sound", code: null } as const)
          : ({ kind: "neither", code: null } as const);

    const check3Outcome = variantOpt.isCorrect
      ? ({ isCorrect: true, label: null } as const)
      : ({
          isCorrect: false,
          label: variantOpt.misconceptionCode ?? null,
        } as const);

    const diag = evaluateDiagnosis(
      session.check1Label,
      check2Outcome,
      check3Outcome,
    );
    const heldOutTokens = mintOpaqueMcqTokens(
      snapshot.heldOutQuestion,
      `${session.id}:heldout`,
    );
    const now = new Date();

    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.wrongAnswerCoachSession.updateMany({
        where: {
          id: session.id,
          state: "AWAITING_SECOND_QUESTION",
          check3SubmittedAt: null,
        },
        data: {
          state: "AWAITING_HELDOUT_QUESTION",
          check3SelectedKey: variantOpt.id,
          check3SelectedText: variantOpt.text,
          check3IsCorrect: variantOpt.isCorrect,
          check3Label: check3Outcome.label,
          check3SubmittedAt: now,
          diagnosis: diag.diagnosis,
          diagnosisMisconceptionCode: diag.misconceptionCode,
          decisionTableRow: diag.tableRow,
          diagnosisReason: diag.reason,
          heldOutQuestionTokensJson: JSON.stringify(heldOutTokens),
          lastActivityAt: now,
        },
      });
      if (claimed.count !== 1) return null;

      const current = await tx.wrongAnswerCoachSession.findUniqueOrThrow({
        where: { id: session.id },
        select: { nextMessageSeq: true },
      });
      const seq = current.nextMessageSeq;
      await tx.wrongAnswerCoachMessage.createMany({
        data: [
          {
            sessionId: session.id,
            seq,
            role: "student",
            kind: "SECOND_QUESTION_ANSWER",
            content: `${chosenToken.label}. ${chosenToken.text}`,
            metadata: JSON.stringify({
              label: chosenToken.label,
              variantOptionId: variantOpt.id,
            }),
          },
          {
            sessionId: session.id,
            seq: seq + 1,
            role: "system",
            kind: "HELDOUT_PROMPT",
            content: COACH_FIXED_MESSAGES.beforeHeldOutQuestion,
            metadata: JSON.stringify({
              text: snapshot.heldOutQuestion.text,
              options: heldOutTokens.map((t) => ({
                label: t.label,
                text: t.text,
              })),
            }),
          },
        ],
      });
      return tx.wrongAnswerCoachSession.update({
        where: { id: session.id },
        data: { nextMessageSeq: seq + 2 },
        include: { messages: { orderBy: { seq: "asc" } } },
      });
    });

    if (!updated) {
      return getStudentCoachSession(session.id, input.studentUserId);
    }
    return toStudentSessionView(updated);
  }

  // ── Step 10 -> Step 11 -> Step 12: Held-Out Question -> Task B Tutoring ──
  if (payload.type === "held_out_question") {
    if (
      session.state !== "AWAITING_HELDOUT_QUESTION" &&
      session.state !== "GENERATING_TUTORING"
    ) {
      throw new CoachHttpError(
        409,
        "Held-out question is not active for this session.",
      );
    }
    if (!session.heldOutQuestionTokensJson) {
      throw new CoachHttpError(500, "Held-out question options missing.");
    }
    const tokens = JSON.parse(
      session.heldOutQuestionTokensJson,
    ) as OpaqueMcqTokenEntry[];
    const chosenToken = tokens.find(
      (t) => t.optionToken === payload.optionToken,
    );
    if (!chosenToken) {
      throw new CoachHttpError(400, "Invalid answer option.");
    }
    const variantOpt = snapshot.heldOutQuestion.options.find(
      (o) => o.id === chosenToken.variantOptionId,
    );
    if (!variantOpt) {
      throw new CoachHttpError(500, "Option mapping corrupted.");
    }

    // If heldOutSubmittedAt is ALREADY set (recovery after crash in GENERATING_TUTORING):
    // NEVER allow overwriting with a different option! Only re-drive Task B if
    // the exact same option token is retried after lease expiry.
    if (session.heldOutSubmittedAt) {
      if (session.heldOutSelectedKey !== variantOpt.id) {
        throw new CoachHttpError(
          409,
          "Your answer to the final question was already recorded.",
        );
      }
      const token = randomUUID();
      const now = new Date();
      const claimed = await prisma.wrongAnswerCoachSession.updateMany({
        where: {
          id: session.id,
          state: "GENERATING_TUTORING",
          OR: [
            { processingStep: null },
            {
              processingStartedAt: { lt: new Date(Date.now() - LEASE_TTL_MS) },
            },
          ],
        },
        data: {
          processingStep: "TUTORING",
          processingToken: token,
          processingStartedAt: now,
          lastActivityAt: now,
        },
      });
      if (claimed.count !== 1) {
        throw new CoachHttpError(
          409,
          "Still preparing your explanation. Please wait.",
        );
      }
      return runTaskBAndComplete({
        sessionId: session.id,
        studentUserId: input.studentUserId,
        processingToken: token,
      });
    }

    const token = randomUUID();
    const now = new Date();
    const claimed = await prisma.$transaction(async (tx) => {
      const lock = await tx.wrongAnswerCoachSession.updateMany({
        where: {
          id: session.id,
          state: "AWAITING_HELDOUT_QUESTION",
          heldOutSubmittedAt: null,
        },
        data: {
          state: "GENERATING_TUTORING",
          heldOutSelectedKey: variantOpt.id,
          heldOutSelectedText: variantOpt.text,
          heldOutIsCorrect: variantOpt.isCorrect,
          heldOutLabel: variantOpt.isCorrect
            ? null
            : (variantOpt.misconceptionCode ?? null),
          heldOutSubmittedAt: now,
          processingStep: "TUTORING",
          processingToken: token,
          processingStartedAt: now,
          lastActivityAt: now,
        },
      });
      if (lock.count !== 1) return false;

      const current = await tx.wrongAnswerCoachSession.findUniqueOrThrow({
        where: { id: session.id },
        select: { nextMessageSeq: true },
      });
      await tx.wrongAnswerCoachMessage.create({
        data: {
          sessionId: session.id,
          seq: current.nextMessageSeq,
          role: "student",
          kind: "HELDOUT_ANSWER",
          content: `${chosenToken.label}. ${chosenToken.text}`,
          metadata: JSON.stringify({
            label: chosenToken.label,
            variantOptionId: variantOpt.id,
          }),
        },
      });
      await tx.wrongAnswerCoachSession.update({
        where: { id: session.id },
        data: { nextMessageSeq: current.nextMessageSeq + 1 },
      });
      return true;
    });

    if (!claimed) {
      throw new CoachHttpError(409, "Held-out answer was already submitted.");
    }

    return runTaskBAndComplete({
      sessionId: session.id,
      studentUserId: input.studentUserId,
      processingToken: token,
    });
  }

  throw new CoachHttpError(400, "Unsupported turn payload.");
}

// ─── 6. Worker Sweeper: Stale Leases & Abandoned Sessions ─────────────────────

export async function sweepCoachSessions(): Promise<{
  recoveredTutoring: number;
  recoveredCheck2: number;
  markedIncomplete: number;
}> {
  const leaseCutoff = new Date(Date.now() - LEASE_TTL_MS);
  const abandonCutoff = new Date(Date.now() - ABANDON_TIMEOUT_MS);

  // 1. Recover stale GENERATING_TUTORING sessions with deterministic fallback (NEVER INCOMPLETE!).
  const staleTutoring = await prisma.wrongAnswerCoachSession.findMany({
    where: {
      state: "GENERATING_TUTORING",
      OR: [
        { processingStartedAt: { lt: leaseCutoff } },
        { processingStep: null },
      ],
    },
    take: 20,
  });

  let recoveredTutoring = 0;
  for (const s of staleTutoring) {
    const token = randomUUID();
    const now = new Date();
    const claimed = await prisma.wrongAnswerCoachSession.updateMany({
      where: {
        id: s.id,
        state: "GENERATING_TUTORING",
        OR: [
          { processingStartedAt: { lt: leaseCutoff } },
          { processingStep: null },
        ],
      },
      data: {
        processingStep: "TUTORING",
        processingToken: token,
        processingStartedAt: now,
      },
    });
    if (claimed.count !== 1) continue;

    try {
      const snapshot = JSON.parse(
        s.questionSnapshotJson,
      ) as CoachFrozenSessionSnapshot;
      const fb = buildTutoringFallbackMessage({
        correctAnswerText: snapshot.originalQuestion.correctOptionText,
        keyPoints: snapshot.keyPoints,
      });
      await prisma.$transaction(async (tx) => {
        const current = await tx.wrongAnswerCoachSession.findUnique({
          where: { id: s.id },
        });
        if (!current || current.processingToken !== token) return;
        const merged = mergeFlags(current.flagsJson, [
          "TUTORING_FALLBACK",
          "TUTORING_PROVIDER_ERROR",
        ]);
        const seq = current.nextMessageSeq;
        await tx.wrongAnswerCoachMessage.create({
          data: {
            sessionId: current.id,
            seq,
            role: "assistant",
            kind: "TUTORING_FALLBACK",
            content: fb.plainText,
          },
        });
        await tx.wrongAnswerCoachSession.update({
          where: { id: current.id },
          data: {
            state: "COMPLETED",
            endedReason: "COMPLETED",
            nextMessageSeq: seq + 1,
            completedAt: now,
            tutoringMessage: fb.plainText,
            tutoringStructuredJson: JSON.stringify(fb.structured),
            tutoringUsedFallback: true,
            tutoringGeneratedAt: now,
            tutoringDeliveredAt: now,
            flagsJson: merged.flagsJson,
            hasFlags: merged.hasFlags,
            reviewStatus: "PENDING",
            processingStep: null,
            processingToken: null,
            processingStartedAt: null,
            lastActivityAt: now,
          },
        });
      });
      recoveredTutoring += 1;
    } catch (err) {
      await logSystemEvent({
        category: "WORKER",
        type: "COACH_SWEEP_TUTORING_FAILED",
        severity: "WARNING",
        message: `Failed to recover stale tutoring session ${s.id}: ${errorMessage(err)}`,
      });
    }
  }

  // 2. Recover stale CHECK2 locks -> CLASSIFYING_FAILED so student can retry stored explanation.
  const recoveredCheck2Res = await prisma.wrongAnswerCoachSession.updateMany({
    where: {
      processingStep: "CHECK2",
      processingStartedAt: { lt: leaseCutoff },
      state: { in: ["AWAITING_EXPLANATION", "CLASSIFYING_FAILED"] },
    },
    data: {
      state: "CLASSIFYING_FAILED",
      processingStep: null,
      processingToken: null,
      processingStartedAt: null,
    },
  });

  // 3. Mark abandoned pre-Step-10 sessions INCOMPLETE (preserving diagnosis = null if Check 3 missing).
  const abandoned = await prisma.wrongAnswerCoachSession.findMany({
    where: {
      state: {
        in: [
          "AWAITING_EXPLANATION",
          "CLASSIFYING_FAILED",
          "AWAITING_SECOND_QUESTION",
          "AWAITING_HELDOUT_QUESTION",
        ],
      },
      processingStep: null,
      lastActivityAt: { lt: abandonCutoff },
    },
    take: 50,
    select: { id: true, flagsJson: true, reviewStatus: true },
  });

  let markedIncomplete = 0;
  for (const row of abandoned) {
    const didMark = await prisma.$transaction(async (tx) => {
      const current = await tx.wrongAnswerCoachSession.findUnique({
        where: { id: row.id },
        select: {
          id: true,
          state: true,
          processingStep: true,
          lastActivityAt: true,
          flagsJson: true,
          reviewStatus: true,
        },
      });
      if (
        !current ||
        current.processingStep !== null ||
        current.lastActivityAt >= abandonCutoff ||
        current.state === "COMPLETED" ||
        current.state === "INCOMPLETE" ||
        current.state === "GENERATING_TUTORING"
      ) {
        return false;
      }
      const merged = mergeFlags(current.flagsJson, ["INCOMPLETE_SESSION"]);
      // Preserve an existing REVIEWED status if a teacher already reviewed this session.
      const nextReviewStatus =
        current.reviewStatus === "NONE" && merged.hasFlags
          ? "PENDING"
          : current.reviewStatus;
      await tx.wrongAnswerCoachSession.update({
        where: { id: current.id },
        data: {
          state: "INCOMPLETE",
          endedReason: "ABANDONED",
          flagsJson: merged.flagsJson,
          hasFlags: merged.hasFlags,
          reviewStatus: nextReviewStatus,
        },
      });
      return true;
    });
    if (didMark) markedIncomplete += 1;
  }

  return {
    recoveredTutoring,
    recoveredCheck2: recoveredCheck2Res.count,
    markedIncomplete,
  };
}
