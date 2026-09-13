// Misconception-labeling workflow: given a student's incorrect answers on a
// completed quiz attempt, ask the model to pick 1-3 catalog misconceptions for
// each incorrect answer. Labels are stored with a durable question identifier
// and are exposed only on the teacher attempt-detail surface.
//
// Mirrors the shape of `recommendation.ts`: pure prompt/schema builders + one
// DB helper (`getActiveMisconceptions`), so the prompt/schema/validation logic
// is unit-testable without a DB or network.

import { prisma } from "./prisma";
import type { ReviewSnapshot, SnapshotQuestion } from "./exam-results";

/** One catalog misconception as shown to the model / stored on a result. */
export type MisconceptionCatalogEntry = { misconceptionId: string; statement: string };

/** Evidence for one incorrect answer: question text + student/correct answer text. */
export type IncorrectAnswerEvidence = {
  questionId: string | null;
  questionIndex: number;
  questionText: string;
  studentAnswer: string;
  correctAnswer: string;
};

/** The model's raw structured response. */
export type MisconceptionLabeling = { misconception_ids: string[] };

/** Maximum number of misconceptions attached to one quiz error. */
export const MAX_MISCONCEPTIONS = 3;

// $...$ LaTeX in question/option text is emitted RAW on purpose, matching
// chat-prompt.ts's buildQuizReviewPrompt: the model reads it fine as-is.
const withUnit = (value: string, unit: string | null | undefined): string =>
  unit ? `${value} ${unit}` : value;

const isNumeric = (q: SnapshotQuestion): boolean => q.answerMode === "NUMERIC";

/** Display text for a snapshot option — its alt/caption when the choice is an image. */
const optionDisplayText = (o: SnapshotQuestion["options"][number]): string =>
  o.text || o.imageAlt || (o.imageStorageKey ? "(image choice)" : "");

/**
 * Derive per-incorrect-answer evidence (question text, the student's answer,
 * the correct answer) from a durable review snapshot. This is the same
 * extraction `buildQuizReviewPrompt` (chat-prompt.ts:85-118) performs for the
 * incorrect-answer evidence lines it shows the summary model, kept in sync so
 * both prompts describe a student's errors identically.
 */
export function extractIncorrectAnswerEvidence(snapshot: ReviewSnapshot): IncorrectAnswerEvidence[] {
  return snapshot.questions.flatMap((q, questionIndex) => {
      if (q.isCorrect) return [];
      // NUMERIC questions carry no options; report the submitted number (or "No
      // answer") and the correct number, each with the optional unit.
      if (isNumeric(q)) {
        const studentAnswer =
          q.submittedNumeric != null ? withUnit(String(q.submittedNumeric), q.unit) : "No answer";
        const correctAnswer =
          q.correctNumeric != null ? withUnit(String(q.correctNumeric), q.unit) : "Unknown";
        return [{ questionId: q.questionId ?? null, questionIndex, questionText: q.text, studentAnswer, correctAnswer }];
      }

      const selected = q.options.flatMap((o) => (o.selected ? [optionDisplayText(o)] : []));
      const correct = q.options.flatMap((o) => (o.isCorrect ? [optionDisplayText(o)] : []));

      return [{
        questionId: q.questionId ?? null,
        questionIndex,
        questionText: q.text,
        studentAnswer: selected.length > 0 ? selected.join(" | ") : "No answer selected",
        correctAnswer: correct.length > 0 ? correct.join(" | ") : "Unknown",
      }];
    });
}

const MISCONCEPTION_LABELING_INSTRUCTIONS =
  "You are an educational assistant analyzing a student's quiz errors to identify likely " +
  "misconceptions. You are given evidence from one incorrect answer (the question, " +
  "the student's answer, and the correct answer) and a catalog of known misconceptions. Select " +
  "1 TO 3 catalog misconceptions that most likely explain this error. Only choose " +
  "from the provided catalog — never invent a misconception or return an id that isn't listed. " +
  "Return ONLY a JSON object with a `misconception_ids` array containing 1 to 3 catalog " +
  "misconception id strings.";

/**
 * Build the misconception-labeling prompt: the evidence from every incorrect
 * answer plus the full active misconception catalog. Never asks the model to
 * reveal or restate anything — the response is just a list of catalog ids.
 */
export function buildMisconceptionLabelingPrompt(
  incorrect: IncorrectAnswerEvidence[],
  catalog: MisconceptionCatalogEntry[]
): string {
  const evidenceLines = incorrect.flatMap((answer, index) => [
    `${index + 1}. Question: ${answer.questionText}`,
    `   Student answer: ${answer.studentAnswer}`,
    `   Correct answer: ${answer.correctAnswer}`,
  ]);

  const catalogLines = catalog.map((m) => `- [${m.misconceptionId}] ${m.statement}`);

  return [
    MISCONCEPTION_LABELING_INSTRUCTIONS,
    "",
    "Evidence from incorrect answers:",
    ...evidenceLines,
    "",
    "Misconception catalog:",
    ...catalogLines,
    "",
    "Select 1 to 3 catalog misconception ids that most likely explain this error.",
  ].join("\n");
}

/**
 * Strict JSON schema for the labeling response: an array of 1-3 ids,
 * each constrained to the active catalog via `enum` (mirrors the
 * `MATERIAL_SELECTION_SCHEMA` style in recommendation.ts).
 */
export function buildMisconceptionSchema(ids: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      misconception_ids: {
        type: "array",
        description:
          "One to three catalog misconception ids that most likely explain this quiz error.",
        minItems: 1,
        maxItems: MAX_MISCONCEPTIONS,
        items: { type: "string", enum: ids },
      },
    },
    required: ["misconception_ids"],
  };
}

/**
 * Validate + resolve the model's chosen misconception ids against the active
 * catalog: drop unknown/duplicate ids, cap at MAX_MISCONCEPTIONS, and attach
 * each surviving id's statement from the catalog (never trust model-echoed
 * text). Defense in depth — the schema's `enum` should already constrain this,
 * but structured-output providers can fall back to plain streaming.
 */
export function resolveLabeledMisconceptions(
  ids: string[],
  catalog: MisconceptionCatalogEntry[]
): MisconceptionCatalogEntry[] {
  const byId = new Map(catalog.map((m) => [m.misconceptionId, m]));
  const seen = new Set<string>();
  const resolved: MisconceptionCatalogEntry[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const entry = byId.get(id);
    if (!entry) continue;
    seen.add(id);
    resolved.push(entry);
    if (resolved.length >= MAX_MISCONCEPTIONS) break;
  }
  return resolved;
}

/** Load the active (non-deprecated) misconception catalog, ordered by id. */
export async function getActiveMisconceptions(): Promise<MisconceptionCatalogEntry[]> {
  return prisma.misconception.findMany({
    where: { deprecated: false },
    orderBy: { misconceptionId: "asc" },
    select: { misconceptionId: true, statement: true },
  });
}
