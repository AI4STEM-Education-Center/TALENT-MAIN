import { z } from "zod";
import { normalizeNumericValue } from "./quiz-scoring";

const identifier = z.string().trim().min(1).max(200);
const option = z.object({
  id: identifier.optional(),
  // Image choices can have empty text; the route verifies the stored image.
  text: z.string().trim().max(20_000),
  isCorrect: z.boolean(),
});
const fields = z.object({
  text: z.string().trim().min(1).max(50_000),
  difficultyLevel: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]),
  answerMode: z.enum(["SINGLE_SELECT", "MULTI_SELECT", "NUMERIC"]),
  options: z.array(option).max(100),
  answerNumeric: z.union([z.string().max(200), z.number()]).nullable(),
  answerTolerance: z.union([z.string().max(200), z.number()]).nullable(),
  answerUnit: z.string().trim().max(200).nullable(),
});

export const questionCreateSchema = fields.partial().extend({
  quizId: identifier,
  text: fields.shape.text,
});
export const questionUpdateSchema = fields.partial().extend({ id: identifier });
export const questionDeleteSchema = z.object({ id: identifier });

type Choice = z.infer<typeof option> & { imageStorageKey?: string | null };

/** Check the effective mode, even when a PATCH omits the mode itself. */
export function choiceValidationError(
  mode: string,
  options: Choice[],
): string | null {
  if (options.length < 2) return "At least 2 options are required.";
  if (options.some((item) => !item.text && !item.imageStorageKey))
    return "Each option needs text or an existing image.";
  const correct = options.filter((item) => item.isCorrect).length;
  if (correct === 0) return "At least one option must be marked as correct.";
  if (mode === "SINGLE_SELECT" && correct > 1)
    return "Single-select questions can only have one correct option.";
  const ids = options.flatMap((item) => (item.id ? [item.id] : []));
  if (new Set(ids).size !== ids.length) return "Option ids must be unique.";
  return null;
}

export function parseNumericAnswer(input: {
  answerNumeric?: unknown;
  answerTolerance?: unknown;
  answerUnit?: string | null;
}):
  | { error: string }
  | {
      answerNumeric: number;
      answerTolerance: number | null;
      answerUnit: string | null;
    } {
  const answerNumeric = normalizeNumericValue(input.answerNumeric);
  if (answerNumeric === null)
    return { error: "A finite numeric answer is required." } as const;
  const rawTolerance = input.answerTolerance;
  const answerTolerance =
    rawTolerance === undefined || rawTolerance === null || rawTolerance === ""
      ? null
      : normalizeNumericValue(rawTolerance);
  if (
    rawTolerance !== undefined &&
    rawTolerance !== null &&
    rawTolerance !== "" &&
    (answerTolerance === null || answerTolerance <= 0)
  ) {
    return { error: "Tolerance must be a positive number." } as const;
  }
  return {
    answerNumeric,
    answerTolerance,
    answerUnit: input.answerUnit?.trim() || null,
  };
}
