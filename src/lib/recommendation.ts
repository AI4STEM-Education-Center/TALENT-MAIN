// Two-step HOLISTIC learning-material recommendation workflow. Given the whole
// of a student's quiz attempt (every question + whether it was answered
// correctly, plus aggregate right/wrong counts), the workflow:
//   Step 1 — select AT MOST 3 of the most relevant material files from the
//            class catalog (one structured call).
//   Step 2 — for each selected file, select a focused 0-5 page range within it
//            (one structured call per file; a file may yield no pages).
// Both steps ask the LLM for strict JSON. Crucially, every instruction string
// forbids the model from revealing or quoting any specific question, the
// student's answers, or the correct answers: the reasoning it returns is
// holistic (themes/concepts only). Everything in this module is pure (no
// Next/DB/LLM imports) so it can be unit-tested like `chat-prompt.ts`.

/** One question of the attempt as shown to the model: text + whether right. */
export type AttemptQuestion = {
  questionText: string;
  isCorrect: boolean;
};

/** The whole-attempt picture handed to both recommendation steps. */
export type HolisticAttempt = {
  questions: AttemptQuestion[];
  correctCount: number;
  incorrectCount: number;
};

/** A material as presented to the model in step 1. `index` is 1-based. */
export type CatalogMaterial = {
  index: number;
  title: string;
  description: string;
  keyConcepts: string[];
};

/** A page as presented to the model in step 2. */
export type CatalogPage = {
  pageNumber: number;
  keyConcept: string;
  description: string;
};

export type SelectedMaterial = { material_index: number; reasoning: string };
export type MaterialSelection = { materials: SelectedMaterial[] };
export type PageSelection = {
  has_relevant_pages: boolean;
  start_page: number;
  end_page: number;
  reasoning: string;
};

/** Max consecutive pages a single recommendation may span (soft cap). */
export const MAX_PAGE_SPAN = 5;

/** Max distinct materials the workflow will recommend. */
export const MAX_MATERIALS = 3;

/** Top-N key concepts to show per material. */
const MAX_KEY_CONCEPTS = 5;

// Strict JSON schemas for OpenAI structured output (response_format: json_schema).
// Every property is required and additionalProperties is false, as strict mode requires.
export const MATERIAL_SELECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    materials: {
      type: "array",
      description: "The most relevant materials to recommend (choose at most 3).",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          material_index: {
            type: "integer",
            description: "The 1-based index of a selected material from the provided list",
          },
          reasoning: {
            type: "string",
            description:
              "1-2 sentences on the themes/concepts this material reinforces. Never quote or " +
              "reference a specific question, the student's answers, or the correct answers.",
          },
        },
        required: ["material_index", "reasoning"],
      },
    },
  },
  required: ["materials"],
} as const;

export const PAGE_SELECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    has_relevant_pages: {
      type: "boolean",
      description:
        "True if any pages of this material are worth recommending; false to skip it entirely.",
    },
    start_page: { type: "integer", description: "Starting page number of the recommended range" },
    end_page: { type: "integer", description: "Ending page number of the recommended range" },
    reasoning: {
      type: "string",
      description:
        "1-2 sentences on the themes/concepts these pages cover. Never quote or reference a " +
        "specific question, the student's answers, or the correct answers.",
    },
  },
  required: ["has_relevant_pages", "start_page", "end_page", "reasoning"],
} as const;

const MATERIAL_SELECTION_INSTRUCTIONS =
  "You are an educational assistant helping a student study more effectively. You are given an " +
  "overview of a student's recent quiz attempt — the topics it covered and how many questions " +
  "they got right versus wrong overall — along with the class's learning materials. Choose AT " +
  "MOST 3 materials whose concepts will most help the student strengthen their understanding of " +
  "this quiz's topics. IMPORTANT: your reasoning must be holistic and encouraging — describe the " +
  "themes/concepts each material reinforces. Never reveal, quote, or reference any specific " +
  "question, the student's answers, or the correct answers. Return ONLY a JSON object with a " +
  "`materials` array of { material_index (integer), reasoning (string) } (at most 3 entries).";

const PAGE_SELECTION_INSTRUCTIONS =
  "You are an educational assistant helping a student study more effectively. Given an overview " +
  "of the student's recent quiz attempt (topics covered and overall right/wrong counts) and the " +
  "available pages of one selected material, identify a focused range of consecutive pages (5 " +
  "pages maximum) that best reinforces this quiz's topics. If no pages of this material are " +
  "genuinely relevant, set has_relevant_pages to false. IMPORTANT: your reasoning must be " +
  "holistic — describe the themes/concepts the pages cover. Never reveal, quote, or reference " +
  "any specific question, the student's answers, or the correct answers. Return ONLY a JSON " +
  "object with fields: has_relevant_pages (boolean), start_page (integer), end_page (integer), " +
  "reasoning (string).";

/**
 * Summarize the attempt for the model WITHOUT exposing per-question
 * correctness phrased as a reveal: we list the covered question topics and the
 * overall right/wrong counts only. (The per-question isCorrect flags inform
 * counts; we do not label individual lines right or wrong.)
 */
function attemptLines(attempt: HolisticAttempt): string[] {
  const topics = attempt.questions.map((q, i) => `  ${i + 1}. ${q.questionText}`);
  return [
    `The quiz covered ${attempt.questions.length} question(s) on these topics:`,
    ...topics,
    "",
    `Overall the student answered ${attempt.correctCount} correctly and ${attempt.incorrectCount} incorrectly.`,
  ];
}

/** Build the step-1 prompt: pick at most 3 relevant materials from the catalog. */
export function buildMaterialSelectionPrompt(
  attempt: HolisticAttempt,
  materials: CatalogMaterial[]
): string {
  const materialsList = materials
    .map((material) => {
      const concepts = material.keyConcepts.slice(0, MAX_KEY_CONCEPTS);
      const conceptsStr = concepts.length > 0 ? concepts.join(", ") : "N/A";
      return [
        `[${material.index}] ${material.title}`,
        `Key Concepts: ${conceptsStr}`,
        `Description: ${material.description || "N/A"}`,
      ].join("\n");
    })
    .join("\n\n");

  return [
    MATERIAL_SELECTION_INSTRUCTIONS,
    "",
    ...attemptLines(attempt),
    "",
    "Available Materials:",
    materialsList,
    "",
    "Select at most 3 of the most relevant materials and return their indices.",
  ].join("\n");
}

/** Build the step-2 prompt: pick a focused page range within the selected material. */
export function buildPageSelectionPrompt(
  attempt: HolisticAttempt,
  materialTitle: string,
  pages: CatalogPage[]
): string {
  const pagesList = pages
    .map((page) =>
      [
        `Page ${page.pageNumber}:`,
        `  Key Concept: ${page.keyConcept || "N/A"}`,
        `  Description: ${page.description || "N/A"}`,
      ].join("\n")
    )
    .join("\n");

  return [
    PAGE_SELECTION_INSTRUCTIONS,
    "",
    ...attemptLines(attempt),
    "",
    `Selected Material: ${materialTitle}`,
    "",
    "Available Pages:",
    pagesList,
    "",
    "Select a focused range of consecutive pages (5 pages maximum), or set has_relevant_pages to false.",
  ].join("\n");
}

/** Map a model-chosen index back to the catalog entry, or null if out of range. */
export function resolveSelectedMaterial<T extends { index: number }>(
  index: number,
  materials: T[]
): T | null {
  return materials.find((material) => material.index === index) ?? null;
}

/**
 * De-duplicate + cap the model's chosen material indices to MAX_MATERIALS,
 * preserving first-seen order. Drops indices that don't resolve to a catalog
 * entry. Reports whether the model named more distinct valid materials than the
 * cap allowed.
 */
export function dedupeSelectedMaterials(
  selected: SelectedMaterial[],
  catalog: CatalogMaterial[]
): { kept: SelectedMaterial[]; truncated: boolean } {
  const seen = new Set<number>();
  const valid: SelectedMaterial[] = [];
  for (const sel of selected) {
    if (seen.has(sel.material_index)) continue;
    if (!resolveSelectedMaterial(sel.material_index, catalog)) continue;
    seen.add(sel.material_index);
    valid.push(sel);
  }
  return { kept: valid.slice(0, MAX_MATERIALS), truncated: valid.length > MAX_MATERIALS };
}

/**
 * Constrain a model-chosen page range to what actually exists: clamp into the
 * available page numbers, ensure start <= end, and cap the span at MAX_PAGE_SPAN.
 * Returns null when there are no available pages.
 */
export function clampPageRange(
  start: number,
  end: number,
  availablePageNumbers: number[]
): { start: number; end: number } | null {
  if (availablePageNumbers.length === 0) return null;

  const sorted = availablePageNumbers.toSorted((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  let s = Number.isFinite(start) ? Math.round(start) : min;
  let e = Number.isFinite(end) ? Math.round(end) : s;
  if (s > e) [s, e] = [e, s];

  s = Math.min(Math.max(s, min), max);
  e = Math.min(Math.max(e, min), max);

  if (e - s + 1 > MAX_PAGE_SPAN) {
    e = Math.min(s + MAX_PAGE_SPAN - 1, max);
  }

  return { start: s, end: e };
}
