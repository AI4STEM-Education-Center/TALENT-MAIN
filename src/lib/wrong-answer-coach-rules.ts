// Pure deterministic rules engine for Wrong Answer Coach.
// Zero DB / LLM / Next imports so every decision path, vote partition,
// validator, intent check, and source hash is exhaustively unit-testable.

import { createHash } from "node:crypto";
import {
  COACH_CHECK2_LOW_CONFIDENCE_THRESHOLD,
  COACH_TUTORING_MAX_WORDS,
  countCoachWords,
  formatStructuredTutoringPlainText,
} from "./wrong-answer-coach-messages";
import type {
  Check2RunSlot,
  CoachFlagCode,
  StructuredTutoringMessage,
} from "./wrong-answer-coach-types";

// ─── 1. Deterministic 14-row Decision Rule (PDF Section 4, Table 3, Fig. 4) ───

export type Check2Outcome =
  | { kind: "misconception"; code: string }
  | { kind: "sound"; code: null }
  | { kind: "neither"; code: null };

export type Check3Outcome =
  { isCorrect: true; label: null } | { isCorrect: false; label: string | null };

export type DiagnosisResult =
  | {
      diagnosis: "MISCONCEPTION";
      misconceptionCode: string;
      tableRow: 1 | 3 | 5 | 6 | 8 | 12;
      reason: string;
    }
  | {
      diagnosis: "SLIP";
      misconceptionCode: null;
      tableRow: 2 | 10;
      reason: string;
    }
  | {
      diagnosis: "KNOWLEDGE_GAP";
      misconceptionCode: null;
      tableRow: 4 | 7 | 9 | 11 | 13 | 14;
      reason: string;
    };

/**
 * Exact 14-row decision rule matching PDF Table 3 & Figure 4.
 * Applied ONLY after all three checks (Check 1, Check 2, Check 3) are complete.
 */
export function evaluateDiagnosis(
  check1Label: string | null,
  check2: Check2Outcome,
  check3: Check3Outcome,
): DiagnosisResult {
  const c1 = check1Label?.trim() || null;
  const c3Label = check3.isCorrect ? null : check3.label?.trim() || null;

  if (c1 !== null) {
    // Branch A: Check 1 chosen option has misconception label M
    if (check2.kind === "misconception" && check2.code === c1) {
      return {
        diagnosis: "MISCONCEPTION",
        misconceptionCode: c1,
        tableRow: 1,
        reason: "Option and explanation agree",
      };
    }

    if (check2.kind === "sound") {
      if (check3.isCorrect) {
        return {
          diagnosis: "SLIP",
          misconceptionCode: null,
          tableRow: 2,
          reason: "Sound reasoning and a correct second answer",
        };
      }
      if (c3Label === c1) {
        return {
          diagnosis: "MISCONCEPTION",
          misconceptionCode: c1,
          tableRow: 3,
          reason: "Option and second answer agree",
        };
      }
      return {
        diagnosis: "KNOWLEDGE_GAP",
        misconceptionCode: null,
        tableRow: 4,
        reason: "Only one piece points to M; no evidence of a slip",
      };
    }

    if (check2.kind === "misconception") {
      // Shows X (where X !== M)
      const x = check2.code;
      if (c3Label === c1) {
        return {
          diagnosis: "MISCONCEPTION",
          misconceptionCode: c1,
          tableRow: 5,
          reason: "Option and second answer agree",
        };
      }
      if (c3Label === x) {
        return {
          diagnosis: "MISCONCEPTION",
          misconceptionCode: x,
          tableRow: 6,
          reason: "Explanation and second answer agree",
        };
      }
      return {
        diagnosis: "KNOWLEDGE_GAP",
        misconceptionCode: null,
        tableRow: 7,
        reason: "No two pieces agree",
      };
    }

    // Check 2 === "neither"
    if (c3Label === c1) {
      return {
        diagnosis: "MISCONCEPTION",
        misconceptionCode: c1,
        tableRow: 8,
        reason: "Option and second answer agree",
      };
    }
    return {
      diagnosis: "KNOWLEDGE_GAP",
      misconceptionCode: null,
      tableRow: 9,
      reason: "Only one piece points to M",
    };
  }

  // Branch B: Check 1 chosen option has NO label
  if (check2.kind === "sound") {
    if (check3.isCorrect) {
      return {
        diagnosis: "SLIP",
        misconceptionCode: null,
        tableRow: 10,
        reason: "Sound reasoning and a correct second answer",
      };
    }
    return {
      diagnosis: "KNOWLEDGE_GAP",
      misconceptionCode: null,
      tableRow: 11,
      reason: "No misconception evidence, and the second answer is wrong",
    };
  }

  if (check2.kind === "misconception") {
    const x = check2.code;
    if (c3Label === x) {
      return {
        diagnosis: "MISCONCEPTION",
        misconceptionCode: x,
        tableRow: 12,
        reason: "Explanation and second answer agree",
      };
    }
    return {
      diagnosis: "KNOWLEDGE_GAP",
      misconceptionCode: null,
      tableRow: 13,
      reason: "Only one piece points to X",
    };
  }

  // Check 2 === "neither"
  return {
    diagnosis: "KNOWLEDGE_GAP",
    misconceptionCode: null,
    tableRow: 14,
    reason: "At most one piece of evidence, and no evidence of a slip",
  };
}

/**
 * Independent 3-step ordered count-based rule from PDF Section 4, exported for
 * exhaustive cross-checking against the 14-row tree in unit tests.
 */
export function evaluateDiagnosisByCountRule(
  check1Label: string | null,
  check2: Check2Outcome,
  check3: Check3Outcome,
): {
  diagnosis: "MISCONCEPTION" | "SLIP" | "KNOWLEDGE_GAP";
  misconceptionCode: string | null;
} {
  const counts = new Map<string, number>();
  const add = (code: string | null) => {
    if (!code) return;
    counts.set(code, (counts.get(code) ?? 0) + 1);
  };
  add(check1Label?.trim() || null);
  add(check2.kind === "misconception" ? check2.code : null);
  add(check3.isCorrect ? null : check3.label?.trim() || null);

  for (const [code, count] of counts) {
    if (count >= 2) {
      return { diagnosis: "MISCONCEPTION", misconceptionCode: code };
    }
  }
  if (check2.kind === "sound" && check3.isCorrect) {
    return { diagnosis: "SLIP", misconceptionCode: null };
  }
  return { diagnosis: "KNOWLEDGE_GAP", misconceptionCode: null };
}

// ─── 2. Check 2 Decisions API Choice Mapping & 5-Run Aggregation ──────────────

export function mapDecisionChoiceToCheck2(
  choice: string,
  allowedCodes: readonly string[],
): {
  valid: boolean;
  parsedKind: "misconception" | "sound" | "neither";
  misconceptionCode: string | null;
  normalizedVoteKey: string;
} {
  const trimmed = choice.trim();
  if (trimmed === "sound") {
    return {
      valid: true,
      parsedKind: "sound",
      misconceptionCode: null,
      normalizedVoteKey: "sound",
    };
  }
  if (trimmed === "neither") {
    return {
      valid: true,
      parsedKind: "neither",
      misconceptionCode: null,
      normalizedVoteKey: "neither",
    };
  }
  if (allowedCodes.includes(trimmed)) {
    return {
      valid: true,
      parsedKind: "misconception",
      misconceptionCode: trimmed,
      normalizedVoteKey: `misconception:${trimmed}`,
    };
  }
  return {
    valid: false,
    parsedKind: "neither",
    misconceptionCode: null,
    normalizedVoteKey: "neither",
  };
}

export interface Check2AggregationResult {
  outcome: Check2Outcome;
  topVoteCount: number;
  histogram: Record<string, number>;
  wasTie: boolean;
  meanConfidence: number | null;
  flags: CoachFlagCode[];
}

export function aggregateCheck2Runs(
  runs: readonly Check2RunSlot[],
  options: { requireStrictMajority?: boolean } = {},
): Check2AggregationResult {
  if (runs.length !== 5) {
    throw new Error(`Expected exactly 5 Check 2 runs, received ${runs.length}`);
  }

  const histogram: Record<string, number> = {};
  const flags = new Set<CoachFlagCode>();
  const confidences: number[] = [];

  for (const run of runs) {
    histogram[run.normalizedVoteKey] =
      (histogram[run.normalizedVoteKey] ?? 0) + 1;
    if (!run.valid) {
      flags.add("CHECK2_PARSE_FAILURE");
    } else if (
      typeof run.confidence === "number" &&
      Number.isFinite(run.confidence)
    ) {
      confidences.push(run.confidence);
    }
  }

  const sorted = Object.entries(histogram).sort((a, b) => b[1] - a[1]);
  const [topKey, topCount] = sorted[0];
  const secondCount = sorted[1]?.[1] ?? 0;

  const meanConfidence =
    confidences.length > 0
      ? Number(
          (
            confidences.reduce((sum, c) => sum + c, 0) / confidences.length
          ).toFixed(4),
        )
      : null;

  if (
    meanConfidence !== null &&
    meanConfidence < COACH_CHECK2_LOW_CONFIDENCE_THRESHOLD
  ) {
    flags.add("CHECK2_LOW_CONFIDENCE");
  }

  const isExactTie = secondCount === topCount;
  const failsStrictMajority =
    options.requireStrictMajority === true && topCount < 3;

  if (isExactTie || failsStrictMajority) {
    flags.add("CHECK2_DISAGREEMENT");
    flags.add("CHECK2_TIE");
    return {
      outcome: { kind: "neither", code: null },
      topVoteCount: topCount,
      histogram,
      wasTie: true,
      meanConfidence,
      flags: [...flags],
    };
  }

  if (topCount < 5) {
    flags.add("CHECK2_DISAGREEMENT");
  }

  let outcome: Check2Outcome;
  if (topKey === "sound") {
    outcome = { kind: "sound", code: null };
  } else if (topKey.startsWith("misconception:")) {
    outcome = {
      kind: "misconception",
      code: topKey.slice("misconception:".length),
    };
  } else {
    outcome = { kind: "neither", code: null };
  }

  return {
    outcome,
    topVoteCount: topCount,
    histogram,
    wasTie: false,
    meanConfidence,
    flags: [...flags],
  };
}

// ─── 3. Task B Tutoring Validation (Correctness by Construction) ──────────────

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export interface TutoringValidationResult {
  valid: boolean;
  reasons: string[];
  wordCount: number;
  structured: StructuredTutoringMessage;
  plainText: string;
}

/**
 * Validate a Task B tutoring body combined with the server-owned correct-answer
 * declaration. Enforces:
 * - Non-empty body
 * - Combined word count <= maxWords (default 150)
 * - Body does not claim any distractor option is correct or invent option letters
 * - Body does not leak internal protocol identifiers ("Row 3", "Check 2", etc.)
 */
export function validateTutoringMessage(input: {
  explanationBody: string;
  correctOptionText: string;
  distractorTexts: readonly string[];
  maxWords?: number;
}): TutoringValidationResult {
  const maxWords = input.maxWords ?? COACH_TUTORING_MAX_WORDS;
  const reasons: string[] = [];
  const trimmedBody = input.explanationBody.trim();

  const bodyParagraphs = trimmedBody
    ? trimmedBody
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  const structured: StructuredTutoringMessage = {
    correctAnswerText: input.correctOptionText,
    bodyParagraphs,
    usedFallback: false,
  };
  const plainText = formatStructuredTutoringPlainText(structured);
  const wordCount = countCoachWords(plainText);

  if (!trimmedBody) {
    reasons.push("Tutoring explanation body is empty.");
  }

  if (wordCount > maxWords) {
    reasons.push(
      `Combined tutoring message has ${wordCount} words, exceeding the ${maxWords}-word limit.`,
    );
  }

  // Reject invented option-letter answer claims (original quiz has no letters).
  const inventedLetterClaim =
    /\b(?:(?:the\s+)?(?:correct|right)\s+(?:answer|option|choice)\s+is\s+(?:option\s+|choice\s+)?[A-F]\b|(?:option|choice)\s+[A-F]\s+is\s+(?:the\s+)?(?:correct|right)\b|(?:choose|select|pick)\s+(?:option\s+|choice\s+)?[A-F]\b|\b[A-F]\s+is\s+(?:the\s+)?(?:correct|right)\s+(?:answer|option|choice)\b)/i;
  if (inventedLetterClaim.test(trimmedBody)) {
    reasons.push(
      "Do not refer to choices by letter (e.g. 'Option B'); refer to the physics idea or option text directly.",
    );
  }

  // Reject affirmative claims that any distractor text is correct (evaluated per
  // clause so a negation in one sentence cannot mask an affirmative claim in another).
  const clauses = trimmedBody
    .split(/[.!?;\n]+/)
    .map((c) => normalizeForMatch(c))
    .filter(Boolean);
  const normCorrect = normalizeForMatch(input.correctOptionText);
  for (const distractor of input.distractorTexts) {
    const normDistractor = normalizeForMatch(distractor);
    if (!normDistractor || normDistractor === normCorrect) continue;
    const escaped = escapeRegExp(normDistractor);
    const affirmativeBefore = new RegExp(
      `(?:(?:correct|right)\\s+(?:answer|option|choice)\\s+(?:is|would be)\\s+|(?:choose|select|pick)\\s+(?:the\\s+(?:answer|option|choice)\\s+)?)["'\`]?${escaped}["'\`]?(?:[.,;!?\\s]|$)`,
      "i",
    );
    const negatedBefore = new RegExp(
      `(?:not|never|don't|do\\s+not|shouldn't|should\\s+not)\\s+(?:choose|select|pick)\\s+(?:the\\s+(?:answer|option|choice)\\s+)?["'\`]?${escaped}["'\`]?(?:[.,;!?\\s]|$)`,
      "i",
    );
    const affirmativeAfter = new RegExp(
      `["'\`]?${escaped}["'\`]?\\s+is\\s+(?:the\\s+)?(?:correct|right)(?:\\s+(?:answer|option|choice))?(?:[.,;!?\\s]|$)`,
      "i",
    );
    const negatedAfter = new RegExp(
      `["'\`]?${escaped}["'\`]?\\s+is\\s+not\\s+(?:the\\s+)?(?:correct|right)`,
      "i",
    );
    const contradicted = clauses.some(
      (clause) =>
        (affirmativeBefore.test(clause) && !negatedBefore.test(clause)) ||
        (affirmativeAfter.test(clause) && !negatedAfter.test(clause)),
    );
    if (contradicted) {
      reasons.push(
        `Tutoring message appears to state that a wrong option ("${distractor}") is correct.`,
      );
      break;
    }
  }

  // Reject raw internal research jargon.
  if (
    /\b(?:table\s*3|row\s*\d{1,2}|check\s*[123]|held-?out\s+question)\b/i.test(
      trimmedBody,
    )
  ) {
    reasons.push(
      "Tutoring message must not reference internal study steps or table rows.",
    );
  }

  return {
    valid: reasons.length === 0,
    reasons,
    wordCount,
    structured,
    plainText,
  };
}

// ─── 4. Pre-Diagnosis Intent & Crisis Detection (Deterministic) ───────────────

const CRISIS_PATTERNS: readonly RegExp[] = [
  /\b(?:kill\s+myself|end\s+my\s+life|want\s+to\s+die|suicid(?:e|al)|self[- ]?harm|hurt\s+myself|cutting\s+myself)\b/i,
  /\b(?:panic\s+attack|mental\s+breakdown|having\s+a\s+crisis|need\s+(?:mental\s+health|counseling|therapy|crisis)\s+help)\b/i,
  /\b(?:i\s+(?:am|'m)\s+(?:being\s+)?abused|unsafe\s+at\s+home|assaulted\s+me)\b/i,
];

const ANSWER_REQUEST_PATTERNS: readonly RegExp[] = [
  /\b(?:what(?:'s|\s+is)\s+the\s+(?:right|correct)\s+(?:answer|option|choice))\b/i,
  /\b(?:just\s+)?(?:tell|give|show)\s+me\s+(?:the\s+)?(?:right|correct\s+)?(?:answer|solution|option|choice)\b/i,
  /\b(?:which\s+(?:one|option|choice)\s+is\s+(?:right|correct))\b/i,
  /\b(?:can\s+you\s+(?:just\s+)?(?:tell|give)\s+me\s+the\s+answer)\b/i,
  /^\s*(?:answer|solution|correct\s+answer)\s*\??\s*$/i,
  /^\s*(?:is\s+it\s+[A-F]|[A-F]\s*\?)\s*$/i,
];

const PHYSICS_REASONING_SIGNAL =
  /\b(?:force|gravity|velocity|speed|accelerat|mass|weight|momentum|energy|friction|newton|inertia|vector|direction|upward|downward|net|work|power|charge|current|voltage|field|wave|circuit|pressure|torque|because|since|therefore|so\s+the|equals|=|\d+\s*(?:m\/s|n|kg|j|w|v|a|hz|s))\b/i;

export function matchesLocalCrisisPattern(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return CRISIS_PATTERNS.some((re) => re.test(trimmed));
}

export function isAnswerRequest(
  text: string,
  allowWithReasoning = false,
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const matched = ANSWER_REQUEST_PATTERNS.some((re) => re.test(trimmed));
  if (!matched) return false;
  if (allowWithReasoning) return true;
  // On Step 4, if the student wrote a substantive physics explanation AND ended
  // with "what is the right answer?", treat it as an explanation rather than refusing.
  const stripped = ANSWER_REQUEST_PATTERNS.reduce(
    (acc, re) => acc.replace(re, " "),
    trimmed,
  ).trim();
  if (stripped.length >= 15 && PHYSICS_REASONING_SIGNAL.test(stripped)) {
    return false;
  }
  return true;
}

// ─── 5. Content-Only Question Fingerprint (NEVER Includes Option.id) ──────────

export interface HashableQuestionInput {
  text: string;
  answerMode?: string | null;
  figureStorageKey?: string | null;
  figureAlt?: string | null;
  options: Array<{
    text: string;
    isCorrect: boolean;
    imageStorageKey?: string | null;
    imageAlt?: string | null;
  }>;
}

function normStr(value: string | null | undefined): string {
  return (value ?? "").replace(/\r\n/g, "\n").trim();
}

/**
 * Deterministic, content-only SHA-256 fingerprint shared identically across:
 * - Live Question rows
 * - ExamResult.reviewSnapshot questions
 * - QuestionCoachMetadata.sourceHash
 * - QuizPracticeVersion.sourceSnapshot items
 *
 * Option.id is deliberately excluded so deepCopyQuiz and harmless DB ordering
 * preserve hashes while ANY edit to question text, answer key, answerMode,
 * options, or figures changes the hash.
 */
export function computeQuestionSourceHash(
  input: HashableQuestionInput,
): string {
  const mode = normStr(input.answerMode) || "SINGLE_SELECT";
  const canonicalOptions = input.options
    .map((o) => ({
      isCorrect: Boolean(o.isCorrect),
      text: normStr(o.text),
      imageStorageKey: normStr(o.imageStorageKey),
      imageAlt: normStr(o.imageAlt),
    }))
    .sort((a, b) => {
      if (a.isCorrect !== b.isCorrect) return a.isCorrect ? 1 : -1;
      if (a.text !== b.text) return a.text.localeCompare(b.text);
      if (a.imageStorageKey !== b.imageStorageKey)
        return a.imageStorageKey.localeCompare(b.imageStorageKey);
      return a.imageAlt.localeCompare(b.imageAlt);
    });

  const figKey = normStr(input.figureStorageKey);
  const payload = JSON.stringify({
    v: 1,
    text: normStr(input.text),
    answerMode: mode,
    figureStorageKey: figKey,
    // Ignore orphaned figureAlt when no figure is attached so variant snapshots
    // and ExamResult snapshots produce identical hashes for text-only questions.
    figureAlt: figKey ? normStr(input.figureAlt) : "",
    options: canonicalOptions,
  });

  return createHash("sha256").update(payload).digest("hex");
}

// ─── 6. Shared v1 Structural Question Eligibility Check ───────────────────────

export const COACH_MIN_OPTIONS = 2;
export const COACH_MAX_OPTIONS = 6;

export function isSupportedCoachQuestionShape(input: {
  answerMode?: string | null;
  figureStorageKey?: string | null;
  options: Array<{
    text: string;
    isCorrect: boolean;
    imageStorageKey?: string | null;
  }>;
}): { ok: true } | { ok: false; reason: string } {
  const mode = input.answerMode || "SINGLE_SELECT";
  if (mode !== "SINGLE_SELECT") {
    return { ok: false, reason: "Only SINGLE_SELECT questions are supported." };
  }
  if (input.figureStorageKey) {
    return {
      ok: false,
      reason: "Figure-dependent questions are excluded in v1.",
    };
  }
  if (
    input.options.length < COACH_MIN_OPTIONS ||
    input.options.length > COACH_MAX_OPTIONS
  ) {
    return {
      ok: false,
      reason: `Question must have between ${COACH_MIN_OPTIONS} and ${COACH_MAX_OPTIONS} options.`,
    };
  }
  if (input.options.some((o) => Boolean(o.imageStorageKey))) {
    return { ok: false, reason: "Image answer choices are excluded in v1." };
  }
  if (input.options.some((o) => !o.text.trim())) {
    return {
      ok: false,
      reason: "All answer options must have non-empty text.",
    };
  }
  const correctCount = input.options.filter((o) => o.isCorrect).length;
  if (correctCount !== 1) {
    return {
      ok: false,
      reason: "Question must have exactly one correct option.",
    };
  }
  const distinctTexts = new Set(
    input.options.map((o) => normalizeForMatch(o.text)),
  );
  if (distinctTexts.size !== input.options.length) {
    return { ok: false, reason: "Option texts must be distinct." };
  }
  return { ok: true };
}
