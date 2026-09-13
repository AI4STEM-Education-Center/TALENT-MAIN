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

/**
 * A staged answer choice. A choice may be plain text OR an image (a diagram /
 * graph / vector cropped from the source page, just like a question figure).
 * The image-* fields are optional so the many `{ text, isCorrect }` literals
 * across fixtures, the review UI, and partial constructions stay valid; readers
 * must treat them as `isImage === true` / `?? null`. For an image option `text`
 * may be empty.
 */
export type StagedOption = {
  text: string;
  isCorrect: boolean | null;
  isImage?: boolean;
  imageBbox?: FigureBbox | null; // coarse from pass 1, tightened by pass 2; teacher-adjustable
  imagePage?: number | null; // 1-based page the choice image is on
  imageStorageKey?: string | null; // null from extraction; set by the client at commit after cropping/uploading
  imageAlt?: string | null; // short label / caption, used as alt text
};

/** Normalized 0..1 crop region relative to the page image. */
export type FigureBbox = { x: number; y: number; w: number; h: number };

/** One thing pass 2 must localize: a question figure or an image option. */
export type LocalizationTargetKind = "figure" | "option";
export type LocalizationTarget = {
  targetId: string; // deterministic, engine-assigned: "q3.figure" | "q3.opt2"
  kind: LocalizationTargetKind;
  page: number; // 1-based page the target is expected on
  questionIndex: number; // 0-based index into ExtractedQuiz.questions
  optionIndex: number | null; // 0-based; null for kind === "figure"
  coarseBbox: FigureBbox | null; // pass-1 coarse box if any
  hint: string | null; // caption / option text / label to help the model
};

/** A validated pass-2 result: a tight box for one target. */
export type LocalizedBox = { targetId: string; bbox: FigureBbox };

export type StagedQuestionType =
  "MULTIPLE_CHOICE" | "MULTI_SELECT" | "TRUE_FALSE" | "NUMERIC";

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

/** Where the pass-2 answer key came from (mirrors the prompt's source enum). */
export type AnswerKeySource =
  "inline" | "key_block" | "green_mark" | "mixed" | "none";

/** One question's answer as read by the isolated pass-2 answer-key call. */
export type QuestionAnswer = {
  questionIndex: number; // 0-based, echoes the pass-1 order the model was shown
  correctLabels: string[]; // synthetic option letters ("A","B",…); [] for numeric / no key
  numericAnswer: number | null;
  source: AnswerKeySource;
  confidence: number; // clamped 0..1
  conflict: boolean; // inline vs key-block disagreed
  note: string | null;
};

/** The validated result of the pass-2 answer-key call. */
export type AnswerKeyResult = {
  hasAnswerKey: boolean;
  answers: QuestionAnswer[];
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
  options: {
    create: {
      text: string;
      isCorrect: boolean;
      imageStorageKey?: string | null;
      imageBucket?: string | null;
      imageAlt?: string | null;
    }[];
  };
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
            type: {
              type: "string",
              enum: [
                "multiple_choice",
                "multi_select",
                "true_false",
                "numeric",
              ],
            },
            text: { type: "string" },
            points: { type: ["integer", "null"] },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  is_correct: { type: ["boolean", "null"] },
                  is_image: { type: "boolean" },
                  image_bbox: {
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
                  image_page: { type: ["integer", "null"] },
                  image_alt: { type: ["string", "null"] },
                },
                required: [
                  "text",
                  "is_correct",
                  "is_image",
                  "image_bbox",
                  "image_page",
                  "image_alt",
                ],
                additionalProperties: false,
              },
            },
            has_image_options: { type: "boolean" },
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
            "has_image_options",
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

/**
 * OpenAI `response_format.json_schema` payload for the pass-2 localization call.
 * One call per page returns tight boxes for that page's targets, each keyed by a
 * deterministic `target_id` we assign (never trust the model to invent ids).
 * `found:false` lets the model admit it could not locate a target on this page
 * without poisoning the rest.
 */
export const QUIZ_LOCALIZATION_SCHEMA = {
  name: "quiz_localization",
  strict: true,
  schema: {
    type: "object",
    properties: {
      boxes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            target_id: { type: "string" },
            found: { type: "boolean" },
            bbox: {
              type: "object",
              properties: {
                x: { type: "number" },
                y: { type: "number" },
                w: { type: "number" },
                h: { type: "number" },
              },
              required: ["x", "y", "w", "h"],
              additionalProperties: false,
            },
          },
          required: ["target_id", "found", "bbox"],
          additionalProperties: false,
        },
      },
    },
    required: ["boxes"],
    additionalProperties: false,
  },
} as const;

/**
 * OpenAI `response_format.json_schema` payload for the isolated pass-2
 * answer-key call. Snake_case wire format; one entry per question keyed by the
 * `question_index` we showed the model. `correct_labels` are synthetic option
 * letters ("A","B",…) mapped back to option indices deterministically in
 * `applyAnswerKey` (never trust the model to invent option ordering).
 */
export const QUIZ_ANSWER_KEY_SCHEMA = {
  name: "quiz_answer_key",
  strict: true,
  schema: {
    type: "object",
    properties: {
      has_answer_key: { type: "boolean" },
      answers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question_index: { type: "integer" },
            correct_labels: { type: "array", items: { type: "string" } },
            numeric_answer: { type: ["number", "null"] },
            source: {
              type: "string",
              enum: ["inline", "key_block", "green_mark", "mixed", "none"],
            },
            confidence: { type: "number" },
            conflict: { type: "boolean" },
            note: { type: ["string", "null"] },
          },
          required: [
            "question_index",
            "correct_labels",
            "numeric_answer",
            "source",
            "confidence",
            "conflict",
            "note",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["has_answer_key", "answers"],
    additionalProperties: false,
  },
} as const;

// ─── Prompt ───────────────────────────────────────────────────────────────────

/**
 * Build the PASS-1 vision prompt: STRUCTURE ONLY. It identifies questions and
 * their options but deliberately does NOT decide which option is correct — a
 * dedicated second pass (`buildAnswerKeyPrompt`) reads the answer key. Pure
 * function of `totalPages`; the exact text is asserted in tests, so it must be
 * deterministic.
 */
export function buildExtractionPrompt(totalPages: number): string {
  return `You are extracting the STRUCTURE of a quiz from ${totalPages} page image${
    totalPages === 1 ? "" : "s"
  }, in order. The quiz may be a Learning Management System export (e.g. D2L Brightspace "Print Quiz") OR a teacher-authored document / worksheet. A single question may span across a page boundary; stitch it back together.

YOUR JOB IN THIS PASS: transcribe every question and its answer options. Do NOT decide which option is correct and do NOT read the answer key — a separate pass does that. Leave EVERY is_correct null and EVERY numeric_answer null here, even if a correct answer is obviously marked or written on the page. Just capture the structure.

IGNORE everything that is not question content: headers, footers, dates, the course/quiz name, instructor name, URLs, and page numbers. Also ignore UI chrome and scrollbar/slider glyphs (e.g. "◄▬►") under options that overflow their box; never emit those as options or as text.

SHARED / UNIFIED OPTION BANKS — READ CAREFULLY:
- Some quizzes declare ONE set of labeled answer choices a single time (e.g. a header like "Identify the type:" followed by "A. Nominal", "B. Ordinal", "C. Interval", "D. Ratio"), then list many NUMBERED items (1, 2, 3, …) that each pick from that same shared set. This is a matching / classification layout.
- In that case the shared A/B/C/D block is NOT a question. EACH numbered item IS its own separate question. Give every one of those questions the FULL shared option list as its options, copied in label order (A, then B, then C, …), identical across all of them.
- The item's own line is the question stem (e.g. "Marital status", plus any scenario/legend printed beneath it such as "1 = single, 2 = married, 3 = divorced"). Fold that legend into the stem text.
- A trailing letter/answer written on an item's line (e.g. "Marital status: A") is answer-key information — do NOT use it to set is_correct in this pass; the answer-key pass handles it. Do keep the stem clean of that trailing marker.

QUESTION TYPES:
- multiple_choice: one set of options; exactly one is intended to be correct.
- multi_select: like multiple_choice but the format expects more than one correct option. Do NOT guess this from markings (you are not reading answers here); only use it when the item explicitly asks to "select all that apply" or similar.
- true_false: the options are exactly "True" and "False".
- numeric: free-response with NO options; the answer is a bare number (e.g. "3.21"), and the unit is implied by the question stem.

MATH TRANSCRIPTION:
- Transcribe all math faithfully as LaTeX inside ${LATEX_INLINE_DELIMITER} (use ${LATEX_DISPLAY_DELIMITER} for display equations). Examples: $\\mu_s$, $f_s = \\mu_s N$, $\\vec{A} \\cdot \\vec{B}$, $\\hat{x}$, $\\hat{y}$, and proper minus signs ($-3.21$, not a hyphen or a garbled glyph).
- Never transcribe garbled or unrecognizable glyphs literally. If math is illegible, transcribe your best reading and set needs_review=true with a review_note.

OPTIONS:
- Options may be LABELED ("A.", "B)", "1.", "(c)") or unlabeled radio buttons. Put ONLY the choice text in the text field — strip the leading label. The option's POSITION in the list carries its identity (first option = A/1, second = B/2, …), so always list options in the printed order, top to bottom. Options may themselves be math expressions.
- An option can itself be an IMAGE (a graph, diagram, vector picture, plot, or figure) instead of text — this is common in physics/math quizzes where every choice is a different diagram. For such an option set is_image=true, leave text="" (or a tiny caption if printed), give image_page (1-based) and a coarse image_bbox {x, y, w, h} in 0..1 page coordinates around just that one choice image, and a short image_alt describing it (e.g. "graph rising then flat"). A text option keeps is_image=false with image_bbox / image_page / image_alt null.
- Set has_image_options=true when ANY option of the question is an image, otherwise false. Boxes here can be rough; they will be refined in a later pass.

NUMERIC:
- numeric_answer_text and numeric_answer: leave BOTH null in this pass (the answer-key pass fills them).
- numeric_unit: the unit the student is expected to answer in, inferred from the stem (e.g. "m/s", "N", "J"). This is the expected unit for display only.

POINTS:
- If a point value is printed (e.g. a "/1" margin marker), set points to that integer. Otherwise null.

FIGURES:
- Set has_figure=true ONLY when answering the question depends on a diagram, graph, or image. Then provide figure_page (1-based) and figure_bbox, a GENEROUS normalized bounding box {x, y, w, h} in 0..1 page coordinates around the figure, plus a short figure_caption describing it.
- Otherwise has_figure=false and figure_page / figure_bbox / figure_caption all null.

REVIEW:
- Set a per-question confidence in 0..1.
- Set needs_review=true with a short review_note whenever you are uncertain: illegible math, truncated/cut-off text, or whenever a figure is present.

Set has_answer_key=false in this pass (the answer-key pass decides it). Return every question in reading order. Use the exact JSON schema provided.`;
}

/**
 * Build the PASS-2 answer-key vision prompt. Given the same page images plus a
 * compact enumeration of the pass-1 questions (each option pre-labeled A, B,
 * C, … regardless of how it was printed), the model locates the answer key —
 * from ANY source and reconciling across sources — and returns, per question,
 * the correct option letter(s) and/or numeric answer. Pure + deterministic (the
 * text and the question enumeration are asserted in tests).
 */
export function buildAnswerKeyPrompt(
  totalPages: number,
  questions: StagedQuestion[],
): string {
  return `You are reading the ANSWER KEY of a quiz. You are given ${totalPages} page image${
    totalPages === 1 ? "" : "s"
  }, in order, plus the list of questions that were already extracted from them (below). Your ONLY job is to determine the correct answer for each question. Do not re-transcribe the questions.

ANSWER SOURCES — the correct answers may be encoded in ANY of these ways, sometimes several at once:
1. INLINE next to each question: a letter, word, or mark written on the question's own line (e.g. "Marital status: A", a bold/underlined option, a green checkmark or green bold text, a circled letter, an "X" in a box). A letter may be upper- or lower-case ("d" means D).
2. A CONSOLIDATED KEY BLOCK, usually near the end, giving all answers in one place — e.g. a line like "Keys: A B C B D B D D B A", an "Answer Key" section, or a table. The Nth entry corresponds to question N (in the printed question order).
3. GREEN markings (LMS answer-key exports): a green checkmark and/or green bold text on the correct option; a free-response numeric answer printed as a green bold number.

RECONCILING SOURCES:
- If BOTH an inline mark and a consolidated key block exist, they should agree. When they agree, report that answer with high confidence. When they DISAGREE for a question, set conflict=true, pick the source you judge more reliable, and explain in note.
- Map each correct answer to the option LETTER(S) shown in the enumeration below (A = first option, B = second, …). Use correct_labels (a list; one entry for single-answer questions, more for multi-select). For a numeric question, leave correct_labels empty and set numeric_answer instead.
- NEVER solve the question yourself or guess. If no answer key is present for a question anywhere, return an empty correct_labels and numeric_answer=null for it, with source "none".

TOP LEVEL:
- Set has_answer_key=true if ANY answer key information exists anywhere in the document (inline or a key block or green marks); otherwise false. When false, every per-question answer must be empty/null with source "none".

PER QUESTION: return question_index (echo the index shown), correct_labels, numeric_answer, source (one of: inline, key_block, green_mark, mixed, none), confidence 0..1, conflict, and a short note when something is ambiguous or conflicting.

QUESTIONS:
${summarizeQuestionsForAnswerKey(questions)}

Return one entry per question, in the same order. Use the exact JSON schema provided.`;
}

/**
 * Compact, deterministic enumeration of the pass-1 questions for the answer-key
 * prompt. Each option is pre-labeled with a synthetic letter (A, B, C, …) so
 * the model always has a stable label to point at, whether or not the source
 * printed labels. Image options render as "[image: alt]". Numeric questions show
 * "(numeric — provide numeric_answer)". Pure.
 */
export function summarizeQuestionsForAnswerKey(
  questions: StagedQuestion[],
): string {
  return questions
    .map((q, qIndex) => {
      const stem = q.text.replace(/\s+/g, " ").trim();
      if (q.type === "NUMERIC") {
        return `[${qIndex}] ${stem}\n    (numeric — provide numeric_answer, no letters)`;
      }
      const opts = q.options
        .map((o, oIndex) => {
          const label = optionLetter(oIndex);
          const body =
            o.isImage === true
              ? `[image: ${o.imageAlt?.trim() || "figure"}]`
              : o.text.replace(/\s+/g, " ").trim();
          return `      ${label}. ${body}`;
        })
        .join("\n");
      return `[${qIndex}] ${stem}\n${opts}`;
    })
    .join("\n");
}

/** Zero-based option index → its synthetic letter label (0→A, 25→Z, 26→AA, …). */
export function optionLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/** Synthetic option letter → zero-based index (inverse of `optionLetter`). Case-insensitive; null if not a pure A..Z label. */
export function letterToOptionIndex(label: string): number | null {
  const trimmed = label.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(trimmed)) return null;
  let n = 0;
  for (const ch of trimmed) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

/**
 * Build the pass-2 localization prompt for ONE page. Pure + deterministic (the
 * text and target ordering are asserted in tests). Lists every target on this
 * page by its engine-assigned target_id so the result maps back unambiguously.
 */
export function buildLocalizationPrompt(
  pageNumber: number,
  targets: LocalizationTarget[],
): string {
  const lines = targets.map((t) => {
    const what =
      t.kind === "figure"
        ? "the question's figure/diagram"
        : "a single answer-choice image";
    const hint = t.hint ? ` — ${t.hint}` : "";
    return `- ${t.targetId}: ${what}${hint}`;
  });
  return `You are given a SINGLE quiz page image (page ${pageNumber}). Locate each target below and return a TIGHT bounding box for it.

TARGETS (use these exact target_id values, do not invent new ones):
${lines.join("\n")}

RULES:
- Each bbox is {x, y, w, h} in normalized 0..1 page coordinates (x,y = top-left corner; w,h = size), measured against THIS page image only.
- Make each box TIGHT: hug the figure/choice image with only a small margin; do not include the question text, the option's text label, neighbouring choices, or page chrome.
- Answer-choice image boxes must NOT overlap each other — each box surrounds exactly one choice.
- If a target is not actually visible on this page, set found=false for it (its bbox is then ignored).
- Return one entry per target. Use the exact JSON schema provided.`;
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

function validateRawOption(
  raw: unknown,
  qIndex: number,
  oIndex: number,
): StagedOption {
  if (!isRecord(raw)) {
    throw new Error(
      `questions[${qIndex}].options[${oIndex}]: must be an object`,
    );
  }
  if (typeof raw.text !== "string") {
    throw new Error(
      `questions[${qIndex}].options[${oIndex}].text: must be a string`,
    );
  }
  const isCorrect = raw.is_correct;
  if (isCorrect !== true && isCorrect !== false && isCorrect !== null) {
    throw new Error(
      `questions[${qIndex}].options[${oIndex}].is_correct: must be a boolean or null`,
    );
  }
  // Image-option fields are read tolerantly (qti.ts style): a bad shape degrades
  // to text/null rather than failing the whole quiz, and absent keys (old
  // payloads / fixtures) default to a plain text option.
  const isImage = raw.is_image === true;
  const imageBbox = validateBbox(raw.image_bbox); // invalid → null, never throws
  const imagePage =
    typeof raw.image_page === "number" && Number.isFinite(raw.image_page)
      ? Math.round(raw.image_page)
      : null;
  const imageAlt = typeof raw.image_alt === "string" ? raw.image_alt : null;
  return {
    text: raw.text,
    isCorrect,
    isImage,
    imageBbox,
    imagePage,
    imageStorageKey: null,
    imageAlt,
  };
}

function validateRawQuestion(raw: unknown, qIndex: number): StagedQuestion {
  if (!isRecord(raw))
    throw new Error(`questions[${qIndex}]: must be an object`);

  const rawType = raw.type;
  if (typeof rawType !== "string" || !(rawType in RAW_TYPE_MAP)) {
    throw new Error(
      `questions[${qIndex}].type: unexpected value ${JSON.stringify(rawType)}`,
    );
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
  const options = raw.options.map((opt, oIndex) =>
    validateRawOption(opt, qIndex, oIndex),
  );

  if (typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence)) {
    throw new Error(`questions[${qIndex}].confidence: must be a number`);
  }
  const confidence = clamp(raw.confidence, 0, 1);

  let numericAnswer: number | null = null;
  if (raw.numeric_answer !== null && raw.numeric_answer !== undefined) {
    if (
      typeof raw.numeric_answer !== "number" ||
      !Number.isFinite(raw.numeric_answer)
    ) {
      throw new Error(
        `questions[${qIndex}].numeric_answer: must be a number or null`,
      );
    }
    numericAnswer = raw.numeric_answer;
  }

  const numericAnswerText =
    typeof raw.numeric_answer_text === "string"
      ? raw.numeric_answer_text
      : null;
  const numericUnit =
    typeof raw.numeric_unit === "string" ? raw.numeric_unit : null;

  const hasFigure = raw.has_figure === true;
  let figurePage: number | null = null;
  if (raw.figure_page !== null && raw.figure_page !== undefined) {
    if (
      typeof raw.figure_page !== "number" ||
      !Number.isFinite(raw.figure_page)
    ) {
      throw new Error(
        `questions[${qIndex}].figure_page: must be a number or null`,
      );
    }
    figurePage = Math.round(raw.figure_page);
  }
  const figureBbox = validateBbox(raw.figure_bbox); // invalid shape → null, never throw
  const figureCaption =
    typeof raw.figure_caption === "string" ? raw.figure_caption : null;

  const needsReview = raw.needs_review === true;
  const reviewNote =
    typeof raw.review_note === "string" ? raw.review_note : null;

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
  if (!isRecord(input))
    throw new Error("extracted quiz: payload must be an object");

  if (typeof input.has_answer_key !== "boolean") {
    throw new Error("extracted quiz: has_answer_key must be a boolean");
  }
  if (!Array.isArray(input.questions)) {
    throw new Error("extracted quiz: questions must be an array");
  }

  const quizTitle =
    typeof input.quiz_title === "string" && input.quiz_title.trim()
      ? input.quiz_title.trim()
      : null;
  const questions = input.questions.map((q, index) =>
    validateRawQuestion(q, index),
  );

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
  warnings: string[],
): StagedOption[] {
  // Strip artifact-glyph / empty TEXT options. An image option is kept even with
  // empty text — its content is the picture, not a label — and carries all of
  // its image fields through.
  const kept: StagedOption[] = [];
  let stripped = 0;
  for (const opt of options) {
    if (opt.isImage !== true && isJunkOptionText(opt.text)) {
      stripped += 1;
      continue;
    }
    kept.push({ ...opt, text: opt.text.trim() });
  }
  if (stripped > 0) {
    warnings.push(
      `question ${qNumber}: stripped ${stripped} artifact option${stripped === 1 ? "" : "s"}`,
    );
  }

  // Dedupe; keep first, but prefer a copy marked correct. Text options are keyed
  // by their text. Image options are never collapsed (we can't compare picture
  // content, and sibling image choices often share empty text), so each gets a
  // distinct key.
  const byKey = new Map<string, StagedOption>();
  const order: string[] = [];
  let imageSeq = 0;
  for (const opt of kept) {
    const key = opt.isImage === true ? `img:${imageSeq++}` : `txt:${opt.text}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, opt);
      order.push(key);
    } else if (existing.isCorrect !== true && opt.isCorrect === true) {
      byKey.set(key, { ...existing, isCorrect: true });
    }
  }
  if (byKey.size < kept.length) {
    warnings.push(
      `question ${qNumber}: removed duplicate option${kept.length - byKey.size === 1 ? "" : "s"}`,
    );
  }
  return order.map((key) => byKey.get(key)!);
}

// The normalizer is split in two so the pipeline can run answer detection in
// between: `normalizeStructure` does the answer-INDEPENDENT cleanup right after
// pass 1 (its output is what the answer-key pass is shown, so option positions
// are already stable), and `finalizeAnswers` does the answer-DEPENDENT cleanup
// after the answer key has been applied. `normalizeExtractedQuiz` is their
// composition, preserved for callers/tests that hand in answer-bearing input.

// ── Structure-only per-question helpers (no correctness logic) ──

function structureChoiceQuestion(
  q: StagedQuestion,
  qNumber: number,
  warnings: string[],
): StagedQuestion {
  const options = normalizeChoiceOptions(q.options, qNumber, warnings);
  let needsReview = q.needsReview;
  let reviewNote = q.reviewNote;
  if (options.length < 2) {
    needsReview = true;
    reviewNote = appendNote(
      reviewNote,
      "fewer than two options survived cleanup — review.",
    );
  }
  return { ...q, options, needsReview, reviewNote };
}

function structureTrueFalse(q: StagedQuestion): StagedQuestion {
  let trueCorrect: boolean | null = null;
  let falseCorrect: boolean | null = null;
  for (const opt of q.options) {
    const label = opt.text.trim().toLowerCase();
    if (label === "true") trueCorrect = opt.isCorrect;
    else if (label === "false") falseCorrect = opt.isCorrect;
  }
  return {
    ...q,
    options: [
      { text: "True", isCorrect: trueCorrect },
      { text: "False", isCorrect: falseCorrect },
    ],
  };
}

function structureNumeric(
  q: StagedQuestion,
  qNumber: number,
  warnings: string[],
): StagedQuestion {
  if (q.options.length > 0) {
    warnings.push(
      `question ${qNumber}: numeric question had options — cleared`,
    );
  }
  return { ...q, options: [] };
}

/**
 * Answer-INDEPENDENT cleanup, run right after pass 1. Returns a NEW object
 * (never mutates `quiz`): drops empty-text questions, strips artifact options,
 * dedupes, coerces true/false options to exactly [True, False], clears stray
 * options off numeric questions, and forces review on figures / image-choices.
 * Leaves every correctness signal exactly as-is — the answer-key pass sets it.
 */
export function normalizeStructure(quiz: ExtractedQuiz): ExtractedQuiz {
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
        q = structureChoiceQuestion(q, qNumber, warnings);
        break;
      case "TRUE_FALSE":
        q = structureTrueFalse(q);
        break;
      case "NUMERIC":
        q = structureNumeric(q, qNumber, warnings);
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

    // Image answer-choices likewise need their crops confirmed before commit.
    if (q.options.some((o) => o.isImage === true)) {
      q = {
        ...q,
        needsReview: true,
        reviewNote: appendNote(q.reviewNote, "confirm the image-choice crops."),
      };
    }

    questions.push(q);
  });

  return {
    hasAnswerKey: quiz.hasAnswerKey,
    quizTitle: quiz.quizTitle,
    questions,
    warnings,
  };
}

// ── Answer-dependent per-question helpers ──

function finalizeChoiceQuestion(
  q: StagedQuestion,
  hasAnswerKey: boolean,
): StagedQuestion {
  let type = q.type;
  let needsReview = q.needsReview;
  let reviewNote = q.reviewNote;
  const correctCount = q.options.filter((o) => o.isCorrect === true).length;

  // A multiple_choice with >1 marked correct is really a multi-select.
  if (type === "MULTIPLE_CHOICE" && correctCount > 1) {
    type = "MULTI_SELECT";
    needsReview = true;
    reviewNote = appendNote(
      reviewNote,
      "multiple options marked correct — converted to multi-select.",
    );
  }

  if (hasAnswerKey && correctCount === 0) {
    needsReview = true;
    reviewNote = appendNote(
      reviewNote,
      "answer key present but no correct option marked — set it.",
    );
  }

  return { ...q, type, needsReview, reviewNote };
}

function finalizeTrueFalse(q: StagedQuestion): StagedQuestion {
  // Options are already [True, False] from structure; here we only resolve an
  // ambiguous marking (both true) into a review flag.
  let trueCorrect = q.options[0]?.isCorrect ?? null;
  let falseCorrect = q.options[1]?.isCorrect ?? null;
  let needsReview = q.needsReview;
  let reviewNote = q.reviewNote;

  if (trueCorrect === true && falseCorrect === true) {
    trueCorrect = null;
    falseCorrect = null;
    needsReview = true;
    reviewNote = appendNote(
      reviewNote,
      "ambiguous true/false marking — set the correct answer.",
    );
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

function finalizeNumeric(
  q: StagedQuestion,
  hasAnswerKey: boolean,
): StagedQuestion {
  let needsReview = q.needsReview;
  let reviewNote = q.reviewNote;

  let numericAnswer = q.numericAnswer;
  if (numericAnswer === null) {
    const parsed = parseNumericText(q.numericAnswerText);
    if (parsed !== null) numericAnswer = parsed;
  }

  if (hasAnswerKey && numericAnswer === null) {
    needsReview = true;
    reviewNote = appendNote(
      reviewNote,
      "answer key present but no numeric answer parsed — set it.",
    );
  }

  return { ...q, options: [], numericAnswer, needsReview, reviewNote };
}

/**
 * Answer-DEPENDENT cleanup, run after the answer key has been applied. Returns a
 * NEW object (never mutates `quiz`): converts an over-marked multiple_choice to
 * multi-select, flags choice/numeric questions that a present key left
 * unanswered, resolves ambiguous true/false, parses numeric answers, and (when
 * there is no answer key) nulls every correctness signal and marks every
 * question for review.
 */
export function finalizeAnswers(quiz: ExtractedQuiz): ExtractedQuiz {
  const questions = quiz.questions.map((original) => {
    let q: StagedQuestion = {
      ...original,
      options: original.options.map((o) => ({ ...o })),
    };
    switch (q.type) {
      case "MULTIPLE_CHOICE":
      case "MULTI_SELECT":
        q = finalizeChoiceQuestion(q, quiz.hasAnswerKey);
        break;
      case "TRUE_FALSE":
        q = finalizeTrueFalse(q);
        break;
      case "NUMERIC":
        q = finalizeNumeric(q, quiz.hasAnswerKey);
        break;
    }
    return q;
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
        reviewNote: appendNote(
          q.reviewNote,
          "no answer key — set the correct answer",
        ),
      };
    }
  }

  return {
    hasAnswerKey: quiz.hasAnswerKey,
    quizTitle: quiz.quizTitle,
    questions,
    warnings: [...quiz.warnings],
  };
}

/**
 * Full model-distrusting cleanup: structure cleanup followed by answer-dependent
 * cleanup, for callers/tests that already have answer-bearing questions in hand.
 * The engine instead runs the two halves around the isolated answer-key pass.
 */
export function normalizeExtractedQuiz(quiz: ExtractedQuiz): ExtractedQuiz {
  return finalizeAnswers(normalizeStructure(quiz));
}

// ─── Pass-2 answer key: validate raw JSON, apply onto the quiz ─────────────────

const ANSWER_KEY_SOURCES: ReadonlySet<string> = new Set([
  "inline",
  "key_block",
  "green_mark",
  "mixed",
  "none",
]);

function isAnswerKeySource(value: unknown): value is AnswerKeySource {
  return typeof value === "string" && ANSWER_KEY_SOURCES.has(value);
}

/**
 * Structural validation of the RAW answer-key JSON (snake_case) into the typed
 * `AnswerKeyResult`. Throws descriptive Errors (qti.ts style) on gross shape
 * problems; the engine treats a thrown answer-key pass as "no key" and lets the
 * teacher fill answers in review. Per-entry fields degrade tolerantly.
 */
export function validateAnswerKeyResult(input: unknown): AnswerKeyResult {
  if (!isRecord(input))
    throw new Error("answer key: payload must be an object");
  if (typeof input.has_answer_key !== "boolean") {
    throw new Error("answer key: has_answer_key must be a boolean");
  }
  if (!Array.isArray(input.answers)) {
    throw new Error("answer key: answers must be an array");
  }

  const answers: QuestionAnswer[] = input.answers.map((raw, i) => {
    if (!isRecord(raw))
      throw new Error(`answer key: answers[${i}] must be an object`);
    if (
      typeof raw.question_index !== "number" ||
      !Number.isFinite(raw.question_index) ||
      raw.question_index < 0
    ) {
      throw new Error(
        `answer key: answers[${i}].question_index must be a non-negative integer`,
      );
    }
    const correctLabels = Array.isArray(raw.correct_labels)
      ? raw.correct_labels
          .filter((l): l is string => typeof l === "string" && l.trim() !== "")
          .map((l) => l.trim())
      : [];
    const numericAnswer =
      typeof raw.numeric_answer === "number" &&
      Number.isFinite(raw.numeric_answer)
        ? raw.numeric_answer
        : null;
    const source = isAnswerKeySource(raw.source) ? raw.source : "none";
    const confidence =
      typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? clamp(raw.confidence, 0, 1)
        : 0;
    const conflict = raw.conflict === true;
    const note =
      typeof raw.note === "string" && raw.note.trim() ? raw.note.trim() : null;
    return {
      questionIndex: Math.round(raw.question_index),
      correctLabels,
      numericAnswer,
      source,
      confidence,
      conflict,
      note,
    };
  });

  return { hasAnswerKey: input.has_answer_key, answers };
}

/**
 * Merge a pass-2 answer key onto the (structure-normalized) quiz. Pure (returns
 * a NEW quiz). Maps each answer's synthetic option letters back to option
 * indices deterministically and sets is_correct; a numeric answer is copied
 * straight onto the question. A conflicting or unmappable answer forces review;
 * a question with no key entry (or source "none") keeps null correctness so
 * `finalizeAnswers` flags it. The top-level hasAnswerKey comes from the result.
 */
export function applyAnswerKey(
  quiz: ExtractedQuiz,
  result: AnswerKeyResult,
): ExtractedQuiz {
  const byIndex = new Map(result.answers.map((a) => [a.questionIndex, a]));

  const questions = quiz.questions.map((original, index) => {
    const q: StagedQuestion = {
      ...original,
      options: original.options.map((o) => ({ ...o })),
    };
    const answer = byIndex.get(index);

    // No key overall, no entry for this question, or the model found none: leave
    // correctness null so finalizeAnswers can flag it for the teacher.
    if (!result.hasAnswerKey || !answer || answer.source === "none") return q;

    let needsReview = q.needsReview;
    let reviewNote = q.reviewNote;
    if (answer.conflict) {
      needsReview = true;
      reviewNote = appendNote(
        reviewNote,
        "answer sources disagreed — verify the correct answer.",
      );
    }

    if (q.type === "NUMERIC") {
      return {
        ...q,
        numericAnswer: answer.numericAnswer,
        needsReview,
        reviewNote,
      };
    }

    const correctIdx = new Set<number>();
    let badLabel = false;
    for (const label of answer.correctLabels) {
      const idx = letterToOptionIndex(label);
      if (idx === null || idx < 0 || idx >= q.options.length) {
        badLabel = true;
        continue;
      }
      correctIdx.add(idx);
    }
    if (badLabel) {
      needsReview = true;
      reviewNote = appendNote(
        reviewNote,
        "an answer-key letter did not match an option — verify.",
      );
    }

    const options = q.options.map((o, oIndex) => ({
      ...o,
      isCorrect: correctIdx.has(oIndex),
    }));
    return { ...q, options, needsReview, reviewNote };
  });

  return {
    hasAnswerKey: result.hasAnswerKey,
    quizTitle: quiz.quizTitle,
    questions,
    warnings: [...quiz.warnings],
  };
}

// ─── Pass-2 localization: targets, validation, merge ───────────────────────────

/** Deterministic target id; the model is told to echo these verbatim in pass 2. */
export function buildTargetId(
  questionIndex: number,
  kind: LocalizationTargetKind,
  optionIndex: number | null,
): string {
  return kind === "figure"
    ? `q${questionIndex}.figure`
    : `q${questionIndex}.opt${optionIndex}`;
}

/**
 * Walk a (normalized) quiz and collect every figure / image-option that pass 2
 * should localize. Stable order: question order, figure before its options,
 * options in order. The page always resolves to a real page (figure/option page
 * falls back to the question's source page). Pure.
 */
export function collectLocalizationTargets(
  quiz: ExtractedQuiz,
): LocalizationTarget[] {
  const targets: LocalizationTarget[] = [];
  quiz.questions.forEach((q, questionIndex) => {
    if (q.hasFigure) {
      targets.push({
        targetId: buildTargetId(questionIndex, "figure", null),
        kind: "figure",
        page: q.figurePage ?? q.sourcePage,
        questionIndex,
        optionIndex: null,
        coarseBbox: q.figureBbox,
        hint: q.figureCaption,
      });
    }
    q.options.forEach((o, optionIndex) => {
      if (o.isImage !== true) return;
      targets.push({
        targetId: buildTargetId(questionIndex, "option", optionIndex),
        kind: "option",
        page: o.imagePage ?? q.figurePage ?? q.sourcePage,
        questionIndex,
        optionIndex,
        coarseBbox: o.imageBbox ?? null,
        hint: o.imageAlt ?? (o.text || null),
      });
    });
  });
  return targets;
}

/** Does this quiz have anything for pass 2 to localize? */
export function needsLocalization(quiz: ExtractedQuiz): boolean {
  return quiz.questions.some(
    (q) => q.hasFigure || q.options.some((o) => o.isImage === true),
  );
}

/** Group targets by their 1-based page for the per-page pass-2 calls. */
export function groupTargetsByPage(
  targets: LocalizationTarget[],
): Map<number, LocalizationTarget[]> {
  const byPage = new Map<number, LocalizationTarget[]>();
  for (const t of targets) {
    const list = byPage.get(t.page);
    if (list) list.push(t);
    else byPage.set(t.page, [t]);
  }
  return byPage;
}

/**
 * Validate raw pass-2 JSON (snake_case) into typed boxes. Tolerant (qti.ts
 * style): never throws — drops entries with an unknown target_id, found:false,
 * or a malformed bbox, and dedupes by target_id (first wins). `knownTargetIds`
 * is the anti-hallucination guard.
 */
export function validateLocalizationResult(
  input: unknown,
  knownTargetIds: ReadonlySet<string>,
): LocalizedBox[] {
  if (!isRecord(input) || !Array.isArray(input.boxes)) return [];
  const seen = new Set<string>();
  const out: LocalizedBox[] = [];
  for (const raw of input.boxes) {
    if (!isRecord(raw)) continue;
    const targetId = raw.target_id;
    if (
      typeof targetId !== "string" ||
      !knownTargetIds.has(targetId) ||
      seen.has(targetId)
    )
      continue;
    if (raw.found !== true) continue;
    const bbox = validateBbox(raw.bbox);
    if (!bbox) continue;
    seen.add(targetId);
    out.push({ targetId, bbox });
  }
  return out;
}

/**
 * Merge pass-2 boxes back onto the quiz. Pure (returns a NEW quiz, never mutates
 * input). A tight box overrides the coarse one; a target left with neither a
 * tight nor a coarse box is forced needsReview so the teacher draws it by hand.
 */
export function mergeLocalizedBoxes(
  quiz: ExtractedQuiz,
  boxes: LocalizedBox[],
): ExtractedQuiz {
  const byId = new Map(boxes.map((b) => [b.targetId, b.bbox]));

  const questions = quiz.questions.map((q, questionIndex) => {
    let needsReview = q.needsReview;
    let reviewNote = q.reviewNote;

    let figureBbox = q.figureBbox;
    if (q.hasFigure) {
      const tight = byId.get(buildTargetId(questionIndex, "figure", null));
      if (tight) figureBbox = tight;
      else if (!figureBbox) {
        needsReview = true;
        reviewNote = appendNote(
          reviewNote,
          "could not locate the figure — draw the crop.",
        );
      }
    }

    const options = q.options.map((o, optionIndex) => {
      if (o.isImage !== true) return { ...o };
      const tight = byId.get(
        buildTargetId(questionIndex, "option", optionIndex),
      );
      if (tight) return { ...o, imageBbox: tight };
      if (!(o.imageBbox ?? null)) {
        needsReview = true;
        reviewNote = appendNote(
          reviewNote,
          "could not locate an image choice — draw the crop.",
        );
      }
      return { ...o };
    });

    return { ...q, figureBbox, options, needsReview, reviewNote };
  });

  return { ...quiz, questions };
}

// ─── validateCommitQuestions: strict validation of teacher-edited array ────────

function validateCommitOptions(raw: unknown, qIndex: number): StagedOption[] {
  if (!Array.isArray(raw))
    throw new Error(`question ${qIndex + 1}: options must be an array`);
  return raw.map((opt, oIndex) => {
    const where = `question ${qIndex + 1}, option ${oIndex + 1}`;
    if (!isRecord(opt)) throw new Error(`${where}: must be an object`);
    const text = typeof opt.text === "string" ? opt.text.trim() : "";
    const isImage = opt.isImage === true;
    const imageStorageKey =
      typeof opt.imageStorageKey === "string" && opt.imageStorageKey.trim()
        ? opt.imageStorageKey.trim()
        : null;
    // A text option needs text; an image option may have empty text but must
    // carry an uploaded crop key (the client crops + uploads before commit).
    if (!isImage && !text) throw new Error(`${where}: text is required`);
    if (isImage && !imageStorageKey) {
      throw new Error(
        `${where}: image option requires an uploaded image (crop it first)`,
      );
    }
    const isCorrect = opt.isCorrect;
    if (isCorrect !== true && isCorrect !== false && isCorrect !== null) {
      throw new Error(`${where}: isCorrect must be a boolean or null`);
    }
    if (!isImage) return { text, isCorrect };
    const imageAlt = typeof opt.imageAlt === "string" ? opt.imageAlt : null;
    const imagePage =
      typeof opt.imagePage === "number" && Number.isFinite(opt.imagePage)
        ? Math.round(opt.imagePage)
        : null;
    return {
      text,
      isCorrect,
      isImage: true,
      imageBbox: coerceBbox(opt.imageBbox),
      imagePage,
      imageStorageKey,
      imageAlt,
    };
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
  if (!Array.isArray(input))
    throw new Error("commit payload: questions must be an array");

  return input.map((raw, index) => {
    const where = `question ${index + 1}`;
    if (!isRecord(raw)) throw new Error(`${where}: must be an object`);

    const type = raw.type;
    if (
      type !== "MULTIPLE_CHOICE" &&
      type !== "MULTI_SELECT" &&
      type !== "TRUE_FALSE" &&
      type !== "NUMERIC"
    ) {
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
      typeof raw.figureStorageKey === "string" && raw.figureStorageKey.trim()
        ? raw.figureStorageKey.trim()
        : null;
    if (hasFigure && !figureStorageKey) {
      throw new Error(
        `${where}: hasFigure is true but figureStorageKey is missing (upload the crop first)`,
      );
    }

    let numericAnswer: number | null = null;
    if (raw.numericAnswer !== null && raw.numericAnswer !== undefined) {
      if (
        typeof raw.numericAnswer !== "number" ||
        !Number.isFinite(raw.numericAnswer)
      ) {
        throw new Error(
          `${where}: numericAnswer must be a finite number or null`,
        );
      }
      numericAnswer = raw.numericAnswer;
    }

    // Per-type answer-completeness rules.
    if (type === "NUMERIC") {
      if (options.length > 0)
        throw new Error(`${where}: NUMERIC question must have no options`);
      if (numericAnswer === null)
        throw new Error(`${where}: NUMERIC question requires a numericAnswer`);
    } else {
      const hasNull = options.some((o) => o.isCorrect === null);
      if (hasNull)
        throw new Error(
          `${where}: every option must have isCorrect set (no nulls)`,
        );
      const correctCount = options.filter((o) => o.isCorrect === true).length;

      if (type === "TRUE_FALSE") {
        if (options.length !== 2)
          throw new Error(
            `${where}: TRUE_FALSE question must have exactly 2 options`,
          );
        if (correctCount !== 1)
          throw new Error(
            `${where}: TRUE_FALSE question must have exactly one correct option`,
          );
      } else if (type === "MULTIPLE_CHOICE") {
        if (options.length < 2)
          throw new Error(
            `${where}: MULTIPLE_CHOICE question must have at least 2 options`,
          );
        if (correctCount !== 1)
          throw new Error(
            `${where}: MULTIPLE_CHOICE question must have exactly one correct option`,
          );
      } else {
        // MULTI_SELECT
        if (options.length < 2)
          throw new Error(
            `${where}: MULTI_SELECT question must have at least 2 options`,
          );
        if (correctCount < 1)
          throw new Error(
            `${where}: MULTI_SELECT question must have at least one correct option`,
          );
      }

      // True/false options are the literal words "True"/"False" — never images.
      if (type === "TRUE_FALSE" && options.some((o) => o.isImage === true)) {
        throw new Error(`${where}: TRUE_FALSE options cannot be images`);
      }
      // Every option must be distinct, keyed by its text or its image.
      const identities = options.map((o) =>
        o.isImage === true ? `img:${o.imageStorageKey}` : `txt:${o.text}`,
      );
      if (new Set(identities).size !== identities.length) {
        throw new Error(`${where}: options must be distinct`);
      }
    }

    const numericAnswerText =
      typeof raw.numericAnswerText === "string" ? raw.numericAnswerText : null;
    const numericUnit =
      typeof raw.numericUnit === "string" ? raw.numericUnit : null;
    const figurePage =
      typeof raw.figurePage === "number" && Number.isFinite(raw.figurePage)
        ? Math.round(raw.figurePage)
        : null;
    const figureCaption =
      typeof raw.figureCaption === "string" ? raw.figureCaption : null;
    const sourcePage =
      typeof raw.sourcePage === "number" && Number.isFinite(raw.sourcePage)
        ? Math.round(raw.sourcePage)
        : 1;
    const confidence =
      typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? clamp(raw.confidence, 0, 1)
        : 0;
    const reviewNote =
      typeof raw.reviewNote === "string" ? raw.reviewNote : null;

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
 * an image option additionally carries its imageStorageKey / bucket / alt, while
 * a plain text option emits exactly `{ text, isCorrect }`. NUMERIC questions get
 * answerNumeric / answerUnit and an empty options.create. Figure fields are only
 * included when `hasFigure`.
 */
export function mapStagedToQuestionData(
  q: StagedQuestion,
  ctx: {
    quizId: string;
    importId: string;
    createdById: string | null;
    figureBucket: string | null;
  },
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
      create: isNumeric
        ? []
        : q.options.map((o) =>
            o.isImage === true
              ? {
                  text: o.text,
                  isCorrect: o.isCorrect === true,
                  imageStorageKey: o.imageStorageKey ?? null,
                  imageBucket: ctx.figureBucket,
                  imageAlt: o.imageAlt ?? null,
                }
              : { text: o.text, isCorrect: o.isCorrect === true },
          ),
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
