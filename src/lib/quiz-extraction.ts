// Pure quiz-extraction helpers for the PDF quiz-upload feature: the structured
// JSON schema sent to the vision LLM, the (deterministic) extraction prompt,
// structural validation of the raw LLM JSON into typed staged questions,
// model-distrusting normalization, commit-time validation of teacher edits, and
// the mapper to Prisma `question.create` data. Everything here is pure (no DB /
// LLM / S3 / Prisma imports) so it can be unit-tested like `qti.ts` and
// `exam-results.ts`. The impure engine that rasterizes pages and calls the LLM
// lives in a separate module and consumes these helpers.
//
// Validation style follows `qti.ts`: hand-rolled validators that throw
// descriptive Errors (no zod in this repo). The strict JSON schema mirrors
// `vlm-engine.ts`'s TIER1_SCHEMA conventions: every property listed in
// `required`, nullability via type arrays like ["string","null"], and
// `additionalProperties: false` everywhere.

/**
 * LaTeX delimiter convention — the single source of truth for the whole feature.
 * Inline math is wrapped in `$...$`, display math in `$$...$$`.
 */
export const LATEX_INLINE_DELIMITER = "$...$";
export const LATEX_DISPLAY_DELIMITER = "$$...$$";

// ─── Types ──────────────────────────────────────────────────────────────────

export type StagedOption = { text: string; isCorrect: boolean | null };

/** Normalized 0..1 crop region relative to the page image. */
export type FigureBbox = { x: number; y: number; w: number; h: number };

export type StagedQuestionType = "MULTIPLE_CHOICE" | "MULTI_SELECT" | "TRUE_FALSE" | "NUMERIC";

export type StagedQuestion = {
  type: StagedQuestionType;
  text: string; // LaTeX math in $...$
  points: number | null; // integer if present
  options: StagedOption[]; // [] for NUMERIC; exactly True/False for TRUE_FALSE
  numericAnswer: number | null;
  numericAnswerText: string | null; // verbatim from the page, e.g. "3.21"
  numericUnit: string | null; // unit the answer is expected in (display only), may contain LaTeX
  hasFigure: boolean;
  figurePage: number | null; // 1-based
  figureBbox: FigureBbox | null; // AI-suggested crop region, teacher-adjustable later
  figureCaption: string | null;
  figureStorageKey: string | null; // null from extraction; set by the client at commit after cropping/uploading
  sourcePage: number; // 1-based
  confidence: number; // clamped 0..1
  needsReview: boolean;
  reviewNote: string | null;
};

export type ExtractedQuiz = {
  hasAnswerKey: boolean;
  quizTitle: string | null;
  questions: StagedQuestion[];
  warnings: string[];
};

/**
 * Prisma `question.create` data shape, typed structurally so this module stays
 * dependency-free (no `@prisma/client` import).
 */
export type AnswerMode = "SINGLE_SELECT" | "MULTI_SELECT" | "NUMERIC";
export type QuestionCreateData = {
  text: string;
  quizId: string;
  importId: string;
  createdById: string | null;
  points: number | null;
  answerMode: AnswerMode;
  answerNumeric: number | null;
  answerTolerance: number | null;
  answerUnit: string | null;
  options: { create: { text: string; isCorrect: boolean }[] };
  figureStorageKey?: string | null;
  figureBucket?: string | null;
  figureAlt?: string | null;
};

// ─── JSON schema (OpenAI structured output) ───────────────────────────────────

/**
 * OpenAI `response_format.json_schema` payload for the single extraction call.
 * Snake_case keys (the LLM's wire format); strict mode requires every property
 * in `required`, nullability via type arrays, and `additionalProperties: false`.
 */
export const QUIZ_EXTRACTION_SCHEMA = {
  name: "quiz_extraction",
  strict: true,
  schema: {
    type: "object",
    properties: {
      has_answer_key: { type: "boolean" },
      quiz_title: { type: ["string", "null"] },
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            number: { type: ["integer", "null"] },
            page: { type: "integer" },
            type: { type: "string", enum: ["multiple_choice", "multi_select", "true_false", "numeric"] },
            text: { type: "string" },
            points: { type: ["integer", "null"] },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  is_correct: { type: ["boolean", "null"] },
                },
                required: ["text", "is_correct"],
                additionalProperties: false,
              },
            },
            numeric_answer: { type: ["number", "null"] },
            numeric_answer_text: { type: ["string", "null"] },
            numeric_unit: { type: ["string", "null"] },
            has_figure: { type: "boolean" },
            figure_page: { type: ["integer", "null"] },
            figure_bbox: {
              type: ["object", "null"],
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
              },
              required: ["x", "y", "w", "h"],
              additionalProperties: false,
            },
            figure_caption: { type: ["string", "null"] },
            confidence: { type: "number" },
            needs_review: { type: "boolean" },
            review_note: { type: ["string", "null"] },
          },
          required: [
            "number",
            "page",
            "type",
            "text",
            "points",
            "options",
            "numeric_answer",
            "numeric_answer_text",
            "numeric_unit",
            "has_figure",
            "figure_page",
            "figure_bbox",
            "figure_caption",
            "confidence",
            "needs_review",
            "review_note",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["has_answer_key", "quiz_title", "questions"],
    additionalProperties: false,
  },
} as const;

// ─── Prompt ───────────────────────────────────────────────────────────────────

/**
 * Build the vision prompt for the single extraction call. Pure function of
 * `totalPages` — the exact text is asserted in tests, so it must be
 * deterministic.
 */
export function buildExtractionPrompt(totalPages: number): string {
  return `You are extracting quiz questions from a quiz that was printed to PDF from a Learning Management System (D2L Brightspace, "Print Quiz"). You are given ${totalPages} page image${
    totalPages === 1 ? "" : "s"
  }, in order. A single question may span across a page boundary; stitch it back together.

IGNORE everything that is not question content. Print exports contain headers, footers, dates, the course name, URLs, and page numbers — none of that is content. They also contain UI chrome and scrollbar/slider glyphs (e.g. "◄▬►") under options that overflow their box; never emit those as options or as text.

ANSWER KEY:
- This may be an answer-key export or a blank quiz. Correct multiple-choice / true-false options are marked ONLY by a green checkmark and/or green bold text. A free-response numeric answer is printed as a green bold number below the question prompt.
- If, and only if, such green markings exist somewhere in the document, set has_answer_key=true. Then set is_correct=true for the marked option(s) and numeric_answer for the marked numbers.
- If NO green checkmark / green bold marking exists anywhere, set has_answer_key=false and set EVERY is_correct and numeric_answer to null. Never infer, guess, or solve for the correct answer — leave it null.

QUESTION TYPES:
- multiple_choice: one set of unlabeled radio options; exactly one is correct.
- multi_select: like multiple_choice but MORE THAN ONE option is explicitly marked correct. Only use this when multiple options are explicitly marked — never guess.
- true_false: the options are exactly "True" and "False".
- numeric: free-response with NO options; the answer is a bare number (e.g. "3.21"), and the unit is implied by the question stem.

MATH TRANSCRIPTION:
- Transcribe all math faithfully as LaTeX inside ${LATEX_INLINE_DELIMITER} (use ${LATEX_DISPLAY_DELIMITER} for display equations). Examples: $\\mu_s$, $f_s = \\mu_s N$, $\\vec{A} \\cdot \\vec{B}$, $\\hat{x}$, $\\hat{y}$, and proper minus signs ($-3.21$, not a hyphen or a garbled glyph).
- Never transcribe garbled or unrecognizable glyphs literally. If math is illegible, transcribe your best reading and set needs_review=true with a review_note.

OPTIONS:
- Options are unlabeled (no A./B./1)). List them in the visual order they appear, top to bottom. Options may themselves be math expressions.

NUMERIC:
- numeric_answer_text: the answer exactly as printed on the page (verbatim, e.g. "3.21").
- numeric_answer: that value parsed as a JSON number.
- numeric_unit: the unit the student is expected to answer in, inferred from the stem (e.g. "m/s", "N", "J"). This is the expected unit for display only — do NOT append it to numeric_answer.

POINTS:
- If a point value is printed (e.g. a "/1" margin marker), set points to that integer. Otherwise null.

FIGURES:
- Set has_figure=true ONLY when answering the question depends on a diagram, graph, or image. Then provide figure_page (1-based) and figure_bbox, a GENEROUS normalized bounding box {x, y, w, h} in 0..1 page coordinates around the figure, plus a short figure_caption describing it.
- Otherwise has_figure=false and figure_page / figure_bbox / figure_caption all null.

REVIEW:
- Set a per-question confidence in 0..1.
- Set needs_review=true with a short review_note whenever you are uncertain: illegible math, an ambiguous or unclear marking, truncated/cut-off text, or whenever a figure is present.

Return every question in reading order. Use the exact JSON schema provided.`;
}

// ─── Shared validation primitives (qti.ts style) ──────────────────────────────

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

const RAW_TYPE_MAP: Record<string, StagedQuestionType> = {
  multiple_choice: "MULTIPLE_CHOICE",
  multi_select: "MULTI_SELECT",
  true_false: "TRUE_FALSE",
  numeric: "NUMERIC",
};

/** Parse a verbatim numeric string ("3.21", "-3.21", " 12 ") to a finite number, else null. */
function parseNumericText(text: string | null): number | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/** Is a choice option text nothing but symbols / punctuation / whitespace (an artifact glyph)? */
function isJunkOptionText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  // Junk if it contains no letters and no digits (Unicode-aware).
  return !/[\p{L}\p{N}]/u.test(trimmed);
}

// ─── validateExtractedQuiz: raw LLM JSON (snake_case) → typed ExtractedQuiz ─────

function validateBbox(raw: unknown): FigureBbox | null {
  if (!isRecord(raw)) return null;
  const { x, y, w, h } = raw;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h)
  ) {
    return null;
  }
  const cw = clamp(w, Number.MIN_VALUE, 1);
  const ch = clamp(h, Number.MIN_VALUE, 1);
  if (!(cw > 0) || !(ch > 0)) return null;
  return { x: clamp(x, 0, 1), y: clamp(y, 0, 1), w: cw, h: ch };
}

function validateRawOption(raw: unknown, qIndex: number, oIndex: number): StagedOption {
  if (!isRecord(raw)) {
    throw new Error(`questions[${qIndex}].options[${oIndex}]: must be an object`);
  }
  if (typeof raw.text !== "string") {
    throw new Error(`questions[${qIndex}].options[${oIndex}].text: must be a string`);
  }
  const isCorrect = raw.is_correct;
  if (isCorrect !== true && isCorrect !== false && isCorrect !== null) {
    throw new Error(`questions[${qIndex}].options[${oIndex}].is_correct: must be a boolean or null`);
  }
  return { text: raw.text, isCorrect };
}

function validateRawQuestion(raw: unknown, qIndex: number): StagedQuestion {
  if (!isRecord(raw)) throw new Error(`questions[${qIndex}]: must be an object`);

  const rawType = raw.type;
  if (typeof rawType !== "string" || !(rawType in RAW_TYPE_MAP)) {
    throw new Error(`questions[${qIndex}].type: unexpected value ${JSON.stringify(rawType)}`);
  }
  const type = RAW_TYPE_MAP[rawType];

  if (typeof raw.text !== "string") {
    throw new Error(`questions[${qIndex}].text: must be a string`);
  }

  if (typeof raw.page !== "number" || !Number.isFinite(raw.page)) {
    throw new Error(`questions[${qIndex}].page: must be a number`);
  }

  let points: number | null = null;
  if (raw.points !== null && raw.points !== undefined) {
    if (typeof raw.points !== "number" || !Number.isFinite(raw.points)) {
      throw new Error(`questions[${qIndex}].points: must be a number or null`);
    }
    points = Math.round(raw.points);
  }

  if (!Array.isArray(raw.options)) {
    throw new Error(`questions[${qIndex}].options: must be an array`);
  }
  const options = raw.options.map((opt, oIndex) => validateRawOption(opt, qIndex, oIndex));

  if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence)) {
    throw new Error(`questions[${qIndex}].confidence: must be a number`);
  }
  const confidence = clamp(raw.confidence, 0, 1);

  let numericAnswer: number | null = null;
  if (raw.numeric_answer !== null && raw.numeric_answer !== undefined) {
    if (typeof raw.numeric_answer !== "number" || !Number.isFinite(raw.numeric_answer)) {
      throw new Error(`questions[${qIndex}].numeric_answer: must be a number or null`);
    }
    numericAnswer = raw.numeric_answer;
  }

  const numericAnswerText = typeof raw.numeric_answer_text === "string" ? raw.numeric_answer_text : null;
  const numericUnit = typeof raw.numeric_unit === "string" ? raw.numeric_unit : null;

  const hasFigure = raw.has_figure === true;
  let figurePage: number | null = null;
  if (raw.figure_page !== null && raw.figure_page !== undefined) {
    if (typeof raw.figure_page !== "number" || !Number.isFinite(raw.figure_page)) {
      throw new Error(`questions[${qIndex}].figure_page: must be a number or null`);
    }
    figurePage = Math.round(raw.figure_page);
  }
  const figureBbox = validateBbox(raw.figure_bbox); // invalid shape → null, never throw
  const figureCaption = typeof raw.figure_caption === "string" ? raw.figure_caption : null;

  const needsReview = raw.needs_review === true;
  const reviewNote = typeof raw.review_note === "string" ? raw.review_note : null;

  return {
    type,
    text: raw.text,
    points,
    options,
    numericAnswer,
    numericAnswerText,
    numericUnit,
    hasFigure,
    figurePage,
    figureBbox,
    figureCaption,
    figureStorageKey: null, // always null at extraction time
    sourcePage: Math.round(raw.page),
    confidence,
    needsReview,
    reviewNote,
  };
}

/**
 * Structural validation of the RAW LLM JSON (snake_case) into the camelCase
 * `ExtractedQuiz`. Throws descriptive Errors (qti.ts style) on shape problems;
 * clamps confidence into [0,1], rounds points to an integer, and nulls a bad
 * figure_bbox rather than failing the whole quiz.
 */
export function validateExtractedQuiz(input: unknown): ExtractedQuiz {
  if (!isRecord(input)) throw new Error("extracted quiz: payload must be an object");

  if (typeof input.has_answer_key !== "boolean") {
    throw new Error("extracted quiz: has_answer_key must be a boolean");
  }
  if (!Array.isArray(input.questions)) {
    throw new Error("extracted quiz: questions must be an array");
  }

  const quizTitle = typeof input.quiz_title === "string" && input.quiz_title.trim() ? input.quiz_title.trim() : null;
  const questions = input.questions.map((q, index) => validateRawQuestion(q, index));

  const warnings: string[] = [];
  if (Array.isArray(input.warnings)) {
    for (const w of input.warnings) {
      if (typeof w === "string" && w.trim()) warnings.push(w.trim());
    }
  }

  return { hasAnswerKey: input.has_answer_key, quizTitle, questions, warnings };
}

// ─── normalizeExtractedQuiz: model-distrusting cleanup ─────────────────────────

/** Append a sentence to a review note, starting it if there was none. */
function appendNote(existing: string | null, addition: string): string {
  const base = existing?.trim();
  return base ? `${base} ${addition}` : addition;
}

function normalizeChoiceOptions(
  options: StagedOption[],
  qNumber: number,
  warnings: string[]
): StagedOption[] {
  // Strip artifact glyph / empty options.
  const kept: StagedOption[] = [];
  let stripped = 0;
  for (const opt of options) {
    if (isJunkOptionText(opt.text)) {
      stripped += 1;
      continue;
    }
    kept.push({ text: opt.text.trim(), isCorrect: opt.isCorrect });
  }
  if (stripped > 0) {
    warnings.push(`question ${qNumber}: stripped ${stripped} artifact option${stripped === 1 ? "" : "s"}`);
  }

  // Dedupe by trimmed text; keep first, but prefer a copy marked correct.
  const byText = new Map<string, StagedOption>();
  const order: string[] = [];
  for (const opt of kept) {
    const existing = byText.get(opt.text);
    if (!existing) {
      byText.set(opt.text, opt);
      order.push(opt.text);
    } else if (existing.isCorrect !== true && opt.isCorrect === true) {
      byText.set(opt.text, { ...existing, isCorrect: true });
    }
  }
  if (byText.size < kept.length) {
    warnings.push(`question ${qNumber}: removed duplicate option${kept.length - byText.size === 1 ? "" : "s"}`);
  }
  return order.map((text) => byText.get(text)!);
}

function normalizeChoiceQuestion(
  q: StagedQuestion,
  qNumber: number,
  hasAnswerKey: boolean,
  warnings: string[]
): StagedQuestion {
  let options = normalizeChoiceOptions(q.options, qNumber, warnings);
  let type = q.type;
  let needsReview = q.needsReview;
  let reviewNote = q.reviewNote;

  if (options.length < 2) {
    needsReview = true;
    reviewNote = appendNote(reviewNote, "fewer than two options survived cleanup — review.");
  }

  const correctCount = options.filter((o) => o.isCorrect === true).length;

  // A multiple_choice with >1 marked correct is really a multi-select.
  if (type === "MULTIPLE_CHOICE" && correctCount > 1) {
    type = "MULTI_SELECT";
    needsReview = true;
    reviewNote = appendNote(reviewNote, "multiple options marked correct — converted to multi-select.");
  }

  if (hasAnswerKey && correctCount === 0) {
    needsReview = true;
    reviewNote = appendNote(reviewNote, "answer key present but no correct option marked — set it.");
  }

  return { ...q, type, options, needsReview, reviewNote };
}

function normalizeTrueFalse(q: StagedQuestion): StagedQuestion {
  let trueCorrect: boolean | null = null;
  let falseCorrect: boolean | null = null;
  for (const opt of q.options) {
    const label = opt.text.trim().toLowerCase();
    if (label === "true") trueCorrect = opt.isCorrect;
    else if (label === "false") falseCorrect = opt.isCorrect;
  }

  let needsReview = q.needsReview;
  let reviewNote = q.reviewNote;

  // Ambiguous: both marked correct → can't tell which → both null + review.
  if (trueCorrect === true && falseCorrect === true) {
    trueCorrect = null;
    falseCorrect = null;
    needsReview = true;
    reviewNote = appendNote(reviewNote, "ambiguous true/false marking — set the correct answer.");
  }

  return {
    ...q,
    options: [
      { text: "True", isCorrect: trueCorrect },
      { text: "False", isCorrect: falseCorrect },
    ],
    needsReview,
    reviewNote,
  };
}

function normalizeNumeric(
  q: StagedQuestion,
  qNumber: number,
  hasAnswerKey: boolean,
  warnings: string[]
): StagedQuestion {
  let needsReview = q.needsReview;
  let reviewNote = q.reviewNote;

  if (q.options.length > 0) {
    warnings.push(`question ${qNumber}: numeric question had options — cleared`);
  }

  let numericAnswer = q.numericAnswer;
  if (numericAnswer === null) {
    const parsed = parseNumericText(q.numericAnswerText);
    if (parsed !== null) numericAnswer = parsed;
  }

  if (hasAnswerKey && numericAnswer === null) {
    needsReview = true;
    reviewNote = appendNote(reviewNote, "answer key present but no numeric answer parsed — set it.");
  }

  return { ...q, options: [], numericAnswer, needsReview, reviewNote };
}

/**
 * Garbage-cleanup pass that does NOT trust the model. Returns a NEW object
 * (never mutates `quiz`): drops empty-text questions, strips artifact options,
 * dedupes, reconciles type vs. markings, coerces true/false + numeric, forces
 * review on figures, and (when there is no answer key) nulls every correctness
 * signal and marks every question for review.
 */
export function normalizeExtractedQuiz(quiz: ExtractedQuiz): ExtractedQuiz {
  const warnings = [...quiz.warnings];
  const questions: StagedQuestion[] = [];

  quiz.questions.forEach((original, index) => {
    const qNumber = index + 1;

    if (!original.text.trim()) {
      warnings.push(`dropped question ${qNumber}: empty text`);
      return;
    }

    // Work on a shallow copy with a trimmed text and copied option array.
    let q: StagedQuestion = {
      ...original,
      text: original.text.trim(),
      options: original.options.map((o) => ({ ...o })),
    };

    switch (q.type) {
      case "MULTIPLE_CHOICE":
      case "MULTI_SELECT":
        q = normalizeChoiceQuestion(q, qNumber, quiz.hasAnswerKey, warnings);
        break;
      case "TRUE_FALSE":
        q = normalizeTrueFalse(q);
        break;
      case "NUMERIC":
        q = normalizeNumeric(q, qNumber, quiz.hasAnswerKey, warnings);
        break;
    }

    // Any figure-bearing question must be confirmed by a teacher.
    if (q.hasFigure) {
      q = {
        ...q,
        needsReview: true,
        reviewNote: appendNote(q.reviewNote, "confirm the figure crop."),
      };
    }

    questions.push(q);
  });

  // Belt and braces: with no answer key, nothing may carry a correctness signal.
  if (!quiz.hasAnswerKey) {
    for (let i = 0; i < questions.length; i += 1) {
      const q = questions[i];
      questions[i] = {
        ...q,
        options: q.options.map((o) => ({ ...o, isCorrect: null })),
        numericAnswer: null,
        needsReview: true,
        reviewNote: appendNote(q.reviewNote, "no answer key — set the correct answer"),
      };
    }
  }

  return { hasAnswerKey: quiz.hasAnswerKey, quizTitle: quiz.quizTitle, questions, warnings };
}

// ─── validateCommitQuestions: strict validation of teacher-edited array ────────

function validateCommitOptions(raw: unknown, qIndex: number): StagedOption[] {
  if (!Array.isArray(raw)) throw new Error(`question ${qIndex + 1}: options must be an array`);
  return raw.map((opt, oIndex) => {
    if (!isRecord(opt)) throw new Error(`question ${qIndex + 1}, option ${oIndex + 1}: must be an object`);
    const text = typeof opt.text === "string" ? opt.text.trim() : "";
    if (!text) throw new Error(`question ${qIndex + 1}, option ${oIndex + 1}: text is required`);
    const isCorrect = opt.isCorrect;
    if (isCorrect !== true && isCorrect !== false && isCorrect !== null) {
      throw new Error(`question ${qIndex + 1}, option ${oIndex + 1}: isCorrect must be a boolean or null`);
    }
    return { text, isCorrect };
  });
}

function coerceBbox(raw: unknown): FigureBbox | null {
  return validateBbox(raw);
}

/**
 * Strict validation of the teacher-edited array posted at commit (camelCase,
 * the `StagedQuestion` shape). Enforces the structural rules PLUS the
 * commit-time answer-completeness rules. Throws descriptive Errors that include
 * the (1-based) question index.
 */
export function validateCommitQuestions(input: unknown): StagedQuestion[] {
  if (!Array.isArray(input)) throw new Error("commit payload: questions must be an array");

  return input.map((raw, index) => {
    const where = `question ${index + 1}`;
    if (!isRecord(raw)) throw new Error(`${where}: must be an object`);

    const type = raw.type;
    if (type !== "MULTIPLE_CHOICE" && type !== "MULTI_SELECT" && type !== "TRUE_FALSE" && type !== "NUMERIC") {
      throw new Error(`${where}: unexpected type ${JSON.stringify(type)}`);
    }

    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text) throw new Error(`${where}: text is required`);

    let points: number | null = null;
    if (raw.points !== null && raw.points !== undefined) {
      if (typeof raw.points !== "number" || !Number.isFinite(raw.points)) {
        throw new Error(`${where}: points must be a number or null`);
      }
      points = Math.round(raw.points);
    }

    const options = validateCommitOptions(raw.options, index);

    const hasFigure = raw.hasFigure === true;
    const figureStorageKey =
      typeof raw.figureStorageKey === "string" && raw.figureStorageKey.trim() ? raw.figureStorageKey.trim() : null;
    if (hasFigure && !figureStorageKey) {
      throw new Error(`${where}: hasFigure is true but figureStorageKey is missing (upload the crop first)`);
    }

    let numericAnswer: number | null = null;
    if (raw.numericAnswer !== null && raw.numericAnswer !== undefined) {
      if (typeof raw.numericAnswer !== "number" || !Number.isFinite(raw.numericAnswer)) {
        throw new Error(`${where}: numericAnswer must be a finite number or null`);
      }
      numericAnswer = raw.numericAnswer;
    }

    // Per-type answer-completeness rules.
    if (type === "NUMERIC") {
      if (options.length > 0) throw new Error(`${where}: NUMERIC question must have no options`);
      if (numericAnswer === null) throw new Error(`${where}: NUMERIC question requires a numericAnswer`);
    } else {
      const hasNull = options.some((o) => o.isCorrect === null);
      if (hasNull) throw new Error(`${where}: every option must have isCorrect set (no nulls)`);
      const correctCount = options.filter((o) => o.isCorrect === true).length;

      if (type === "TRUE_FALSE") {
        if (options.length !== 2) throw new Error(`${where}: TRUE_FALSE question must have exactly 2 options`);
        if (correctCount !== 1) throw new Error(`${where}: TRUE_FALSE question must have exactly one correct option`);
      } else if (type === "MULTIPLE_CHOICE") {
        if (options.length < 2) throw new Error(`${where}: MULTIPLE_CHOICE question must have at least 2 options`);
        if (correctCount !== 1) throw new Error(`${where}: MULTIPLE_CHOICE question must have exactly one correct option`);
      } else {
        // MULTI_SELECT
        if (options.length < 2) throw new Error(`${where}: MULTI_SELECT question must have at least 2 options`);
        if (correctCount < 1) throw new Error(`${where}: MULTI_SELECT question must have at least one correct option`);
      }
    }

    const numericAnswerText = typeof raw.numericAnswerText === "string" ? raw.numericAnswerText : null;
    const numericUnit = typeof raw.numericUnit === "string" ? raw.numericUnit : null;
    const figurePage =
      typeof raw.figurePage === "number" && Number.isFinite(raw.figurePage) ? Math.round(raw.figurePage) : null;
    const figureCaption = typeof raw.figureCaption === "string" ? raw.figureCaption : null;
    const sourcePage =
      typeof raw.sourcePage === "number" && Number.isFinite(raw.sourcePage) ? Math.round(raw.sourcePage) : 1;
    const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? clamp(raw.confidence, 0, 1) : 0;
    const reviewNote = typeof raw.reviewNote === "string" ? raw.reviewNote : null;

    return {
      type,
      text,
      points,
      options,
      numericAnswer,
      numericAnswerText,
      numericUnit,
      hasFigure,
      figurePage: hasFigure ? figurePage : null,
      figureBbox: hasFigure ? coerceBbox(raw.figureBbox) : null,
      figureCaption: hasFigure ? figureCaption : null,
      figureStorageKey: hasFigure ? figureStorageKey : null,
      sourcePage,
      confidence,
      needsReview: raw.needsReview === true,
      reviewNote,
    };
  });
}

// ─── Mapper to Prisma question.create data ─────────────────────────────────────

function answerModeFor(type: StagedQuestionType): AnswerMode {
  switch (type) {
    case "MULTIPLE_CHOICE":
    case "TRUE_FALSE":
      return "SINGLE_SELECT";
    case "MULTI_SELECT":
      return "MULTI_SELECT";
    case "NUMERIC":
      return "NUMERIC";
  }
}

/**
 * Map a (committed, validated) staged question to the `question.create` data
 * object. Choice options carry through with isCorrect coerced via `=== true`;
 * NUMERIC questions get answerNumeric / answerUnit and an empty options.create.
 * Figure fields are only included when `hasFigure`.
 */
export function mapStagedToQuestionData(
  q: StagedQuestion,
  ctx: { quizId: string; importId: string; createdById: string | null; figureBucket: string | null }
): QuestionCreateData {
  const answerMode = answerModeFor(q.type);
  const isNumeric = q.type === "NUMERIC";

  const data: QuestionCreateData = {
    text: q.text,
    quizId: ctx.quizId,
    importId: ctx.importId,
    createdById: ctx.createdById,
    points: q.points,
    answerMode,
    answerNumeric: isNumeric ? q.numericAnswer : null,
    answerTolerance: null,
    answerUnit: isNumeric ? q.numericUnit : null,
    options: {
      create: isNumeric ? [] : q.options.map((o) => ({ text: o.text, isCorrect: o.isCorrect === true })),
    },
  };

  if (q.hasFigure) {
    data.figureStorageKey = q.figureStorageKey;
    data.figureBucket = ctx.figureBucket;
    data.figureAlt = q.figureCaption;
  }

  return data;
}

// ─── parseStagedQuestions: safe parse of the DB JSON column ─────────────────────

/**
 * Safely parse the staged-questions JSON stored in the DB. A null column or a
 * parse failure yields `[]`; a non-array parse result also yields `[]`.
 */
export function parseStagedQuestions(json: string | null): StagedQuestion[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as StagedQuestion[]) : [];
  } catch {
    return [];
  }
}
