// Pure prompt & Decisions API request builders for Wrong Answer Coach.
//
// CRITICAL INDEPENDENCE GUARANTEE:
// `Check2PromptInput` deliberately omits `chosenOptionId`, `chosenOptionText`,
// and `check1Label` at the TypeScript type level so Check 2 can NEVER be
// contaminated by Check 1.

import { createHash } from "node:crypto";
import { fenceUntrusted, UNTRUSTED_CONTENT_RULE } from "./guardrail-fence";
import type { DecisionsRequest } from "./ai-decisions";
import type {
  CoachDiagnosisKind,
  CoachMaterialSnippet,
  CoachMisconceptionEntry,
} from "./wrong-answer-coach-types";

export const CHECK2_PROMPT_VERSION = "1.0-decisions";
export const TUTOR_PROMPT_VERSION = "1.0";

const CHECK2_INSTRUCTIONS_TEMPLATE =
  "You are helping a physics instructor classify a student's written explanation of how they answered a multiple-choice physics question. " +
  "Decide which ONE choice best describes ONLY what the student actually wrote: " +
  "(1) a listed misconception code if the explanation explicitly states or clearly relies on that listed misconception; " +
  "(2) 'sound' if the explanation uses the correct physics idea (even if the student made a misreading or calculation slip); " +
  "(3) 'neither' if the explanation is empty, a guess ('I don't know'), off-topic, too vague to judge, or wrong in a way that matches none of the listed misconceptions. " +
  "Judge only what the student wrote; do not guess what they might have meant. If unsure between two choices, pick 'neither'.";

export const CHECK2_PROMPT_TEMPLATE_HASH = createHash("sha256")
  .update(CHECK2_INSTRUCTIONS_TEMPLATE)
  .digest("hex")
  .slice(0, 16);

/**
 * Compile-time Check 1 isolation: this type NEVER accepts the student's chosen
 * option or Check 1 misconception label.
 */
export interface Check2PromptInput {
  questionText: string;
  options: readonly string[]; // Canonical text-sorted list; NO marker for student's choice!
  correctOptionText: string;
  keyPoints: readonly string[];
  relevantMisconceptions: readonly CoachMisconceptionEntry[];
  studentExplanation: string;
}

/**
 * Build a POST /v1/decisions request for one Check 2 classification slot.
 */
export function buildCheck2DecisionsRequest(
  model: string,
  input: Check2PromptInput,
): DecisionsRequest {
  const canonicalOptions = [...input.options].sort((a, b) =>
    a.localeCompare(b),
  );
  const choices = [
    {
      value: "sound",
      description:
        "Explanation uses the correct physics idea (even if a misreading or calculation slip occurred).",
    },
    {
      value: "neither",
      description:
        "Empty, guess ('I don't know'), off-topic, too vague to judge, or matches none of the listed misconceptions.",
    },
    ...input.relevantMisconceptions.map((m) => ({
      value: m.code,
      description: m.statement,
    })),
  ];

  const questionBlock = [
    `Question: ${input.questionText}`,
    "Options (in alphabetical order; do not assume which one the student picked):",
    ...canonicalOptions.map((opt, i) => `  ${i + 1}. ${opt}`),
    `Correct answer: ${input.correctOptionText}`,
    ...(input.keyPoints.length > 0
      ? [
          "Key points of a correct explanation:",
          ...input.keyPoints.map((kp) => `  - ${kp}`),
        ]
      : []),
    ...(input.relevantMisconceptions.length > 0
      ? [
          "Known misconceptions (use exact code when matched):",
          ...input.relevantMisconceptions.map(
            (m) => `  - ${m.code}: ${m.statement}`,
          ),
        ]
      : ["Known misconceptions: (none listed for this question)"]),
  ].join("\n");

  const sharedInput = [
    UNTRUSTED_CONTENT_RULE,
    "",
    fenceUntrusted("quiz context", questionBlock),
    "",
    fenceUntrusted("student explanation", input.studentExplanation),
  ].join("\n");

  return {
    model,
    input: sharedInput,
    questions: [
      {
        name: "check2_classification",
        type: "choice",
        instructions: CHECK2_INSTRUCTIONS_TEMPLATE,
        choices,
      },
    ],
  };
}

// ─── Task B: Diagnosis-Matched Tutoring Prompt ────────────────────────────────

export interface TutorPromptInput {
  diagnosis: CoachDiagnosisKind;
  misconception: CoachMisconceptionEntry | null;
  questionText: string;
  correctOptionText: string;
  chosenOptionText: string;
  keyPoints: readonly string[];
  studentExplanation: string;
  courseSnippets: readonly CoachMaterialSnippet[];
  maxBodyWords: number;
}

export const TUTOR_JSON_SCHEMA = {
  name: "wrong_answer_coach_tutor",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      explanation_body: {
        type: "string",
        description:
          "Concise plain-text physics tutoring explanation (may include $...$ LaTeX, no Markdown headings/bullets, no invented option letters).",
      },
    },
    required: ["explanation_body"],
  },
} as const;

export function buildTutorPromptMessages(
  input: TutorPromptInput,
): Array<{ role: "system" | "user"; content: string }> {
  const diagnosisGuidance =
    input.diagnosis === "SLIP"
      ? "Diagnosis: SLIP. Keep it short. Confirm that the student's underlying reasoning was right, briefly point out where their chosen answer likely went wrong (e.g. a misread detail or quick slip), and reinforce why the correct answer matches their reasoning."
      : input.diagnosis === "MISCONCEPTION" && input.misconception
        ? `Diagnosis: MISCONCEPTION ("${input.misconception.statement}"). Name the student's idea respectfully in plain language (never mention internal codes), show a concrete situation where that idea gives a wrong prediction, briefly acknowledge where that intuition works in everyday life, and then explain the correct physics idea.`
        : "Diagnosis: KNOWLEDGE GAP. Explain the missing physics idea step by step using the key points below, then clearly connect it to the correct answer.";

  const systemPrompt = [
    "You are a helpful physics tutor writing a single concise tutoring message after a student has finished a diagnostic check.",
    diagnosisGuidance,
    `The system already displays "The correct answer is: ${input.correctOptionText}." right above your message.`,
    `Write ONLY the explanation body in plain text (inline $...$ LaTeX is allowed; do NOT use Markdown bold/bullets).`,
    `Keep explanation_body to no more than ${Math.max(25, input.maxBodyWords)} words so the combined message stays within 150 words.`,
    "NEVER refer to choices by letter (such as Option A or Option B) and NEVER state or imply that any wrong option is correct.",
    "NEVER mention internal study steps, table rows, checks, or misconception code IDs.",
    UNTRUSTED_CONTENT_RULE,
    'Return ONLY JSON matching {"explanation_body": "..."}.',
  ].join("\n");

  const contextLines = [
    `Original question: ${input.questionText}`,
    `Student's chosen answer (incorrect): ${input.chosenOptionText}`,
    `Correct answer: ${input.correctOptionText}`,
    ...(input.keyPoints.length > 0
      ? ["Key points to teach from:", ...input.keyPoints.map((kp) => `- ${kp}`)]
      : []),
    ...(input.courseSnippets.length > 0
      ? [
          "Course material excerpts:",
          ...input.courseSnippets.map(
            (s) =>
              `- [${s.title}${s.pageNumber != null ? ` p.${s.pageNumber}` : ""}] ${s.text}`,
          ),
        ]
      : []),
  ].join("\n");

  const userPrompt = [
    fenceUntrusted("question and course material", contextLines),
    "",
    fenceUntrusted(
      "student explanation",
      input.studentExplanation || "(student left explanation blank)",
    ),
  ].join("\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}
