// Two-step learning-material recommendation workflow, ported from the
// `talent-sample` reference project (recommendation_system/recommender.py +
// schemas.py + config.yml). Given a student's quiz misconception, the workflow:
//   Step 1 — select the most relevant material file from the class catalog.
//   Step 2 — select a focused 3-5 page range within that file.
// Both steps ask the LLM for strict JSON. Everything in this module is pure
// (no Next/DB/LLM imports) so it can be unit-tested like `chat-prompt.ts`.

export type MisconceptionInput = {
  questionText: string;
  wrongAnswer: string;
  correctAnswer?: string | null;
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

export type FileSelection = { material_index: number; reasoning: string };
export type PageSelection = { start_page: number; end_page: number; reasoning: string };

/** Max consecutive pages a single recommendation may span (sample uses 3-5). */
export const MAX_PAGE_SPAN = 5;

/** Top-N key concepts to show per material, matching the sample. */
const MAX_KEY_CONCEPTS = 5;

// Strict JSON schemas for OpenAI structured output (response_format: json_schema).
// Every property is required and additionalProperties is false, as strict mode requires.
export const FILE_SELECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    material_index: {
      type: "integer",
      description: "The 1-based index of the selected material from the provided list",
    },
    reasoning: {
      type: "string",
      description: "1-2 sentences explaining why this material is most relevant",
    },
  },
  required: ["material_index", "reasoning"],
} as const;

export const PAGE_SELECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    start_page: { type: "integer", description: "Starting page number of the recommended range" },
    end_page: { type: "integer", description: "Ending page number of the recommended range" },
    reasoning: {
      type: "string",
      description:
        "1-2 sentences explaining what these pages cover and how they address the misconception",
    },
  },
  required: ["start_page", "end_page", "reasoning"],
} as const;

const FILE_SELECTION_INSTRUCTIONS =
  "You are an educational assistant helping students learn from mistakes. Based on the question " +
  "and incorrect answer provided, analyze the available learning materials and select the MOST " +
  "relevant file that will help the student understand the correct concept. Consider the key " +
  "concepts and descriptions of each material. Return ONLY a JSON object with fields: " +
  "material_index (integer: the index of the chosen material from the list below), reasoning " +
  "(string: 1-2 sentences explaining why this material is most relevant).";

const PAGE_SELECTION_INSTRUCTIONS =
  "You are an educational assistant helping students learn from mistakes. Based on the question " +
  "and incorrect answer provided, and given the available pages from the selected material, " +
  "identify the MOST relevant page range that will help the student understand the correct " +
  "concept. Each page has key concepts and descriptions. Select a focused range of consecutive " +
  "pages (3-5 pages maximum) that directly address the student's knowledge gap. Return ONLY a " +
  "JSON object with fields: start_page (integer), end_page (integer), reasoning (string: 1-2 " +
  "sentences explaining what concepts these pages cover and how they address the misconception).";

function misconceptionLines(input: MisconceptionInput): string[] {
  const lines = [
    `Question: ${input.questionText}`,
    `Student's Wrong Answer: ${input.wrongAnswer}`,
  ];
  if (input.correctAnswer) {
    lines.push(`Correct Answer: ${input.correctAnswer}`);
  }
  return lines;
}

/** Build the step-1 prompt: pick the most relevant material from the catalog. */
export function buildFileSelectionPrompt(
  input: MisconceptionInput,
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
    FILE_SELECTION_INSTRUCTIONS,
    "",
    ...misconceptionLines(input),
    "",
    "Available Materials:",
    materialsList,
    "",
    "Select the most relevant material and return its index.",
  ].join("\n");
}

/** Build the step-2 prompt: pick a focused page range within the selected material. */
export function buildPageSelectionPrompt(
  input: MisconceptionInput,
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
    ...misconceptionLines(input),
    "",
    `Selected Material: ${materialTitle}`,
    "",
    "Available Pages:",
    pagesList,
    "",
    "Select a focused range of consecutive pages (3-5 pages maximum) and return start_page and end_page.",
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
