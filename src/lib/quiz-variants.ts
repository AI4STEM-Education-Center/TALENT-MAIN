import { z } from "zod";
import {
  numericTolerance,
  scoreQuiz,
  type SubmittedAnswer,
} from "./quiz-scoring";
import { shuffleAnswerChoices } from "./quiz-shuffle";

export const variantQuestionSchema = z.object({
  id: z.string().min(1).max(200),
  sourceQuestionId: z.string().min(1).max(200),
  text: z.string().trim().min(1).max(12000),
  answerMode: z.enum(["SINGLE_SELECT", "NUMERIC"]),
  answerUnit: z.string().max(200).nullable(),
  answerNumeric: z.number().finite().nullable(),
  answerTolerance: z.number().positive().finite().nullable(),
  options: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        text: z.string().trim().min(1).max(2000),
        isCorrect: z.boolean(),
      }),
    )
    .max(8),
  solution: z.string().trim().min(1).max(12000),
  intentExplanation: z.string().trim().min(1).max(4000),
});
export const variantPayloadSchema = z.object({
  questions: z.array(variantQuestionSchema).min(1).max(40),
});
export type VariantQuestion = z.infer<typeof variantQuestionSchema>;
export const objectiveSchema = z
  .array(
    z.object({
      sourceQuestionId: z.string().min(1),
      objective: z.string().trim().min(10).max(2000),
    }),
  )
  .min(1)
  .max(40);
export type Objective = z.infer<typeof objectiveSchema>[number];

export function validateVariant(
  value: unknown,
  sources: {
    id: string;
    answerMode: string;
    answerUnit?: string | null;
    answerTolerance?: number | null;
  }[],
): VariantQuestion[] {
  const { questions } = variantPayloadSchema.parse(value);
  if (questions.length !== sources.length)
    throw new Error("Every source question needs exactly one alternative.");
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const ids = new Set<string>();
  const seenSources = new Set<string>();
  for (const q of questions) {
    const source = sourceById.get(q.sourceQuestionId);
    if (
      !source ||
      seenSources.has(source.id) ||
      source.answerMode !== q.answerMode
    )
      throw new Error("Question coverage or answer format changed.");
    if (
      ("answerUnit" in source && q.answerUnit !== source.answerUnit) ||
      ("answerTolerance" in source &&
        q.answerTolerance !== source.answerTolerance)
    )
      throw new Error("Units and grading tolerance must remain unchanged.");
    seenSources.add(source.id);
    for (const id of [q.id, ...q.options.map((o) => o.id)]) {
      if (ids.has(id))
        throw new Error("Question and option IDs must be unique.");
      ids.add(id);
    }
    if (q.answerMode === "NUMERIC") {
      if (q.answerNumeric === null || q.options.length)
        throw new Error(
          "Numeric questions need a finite answer and no choices.",
        );
    } else {
      if (
        q.options.length < 2 ||
        q.options.filter((o) => o.isCorrect).length !== 1 ||
        q.answerNumeric !== null ||
        q.answerTolerance !== null
      )
        throw new Error(
          "Single-select questions need exactly one correct choice and no numeric key.",
        );
      if (
        new Set(q.options.map((o) => o.text.toLocaleLowerCase())).size !==
        q.options.length
      )
        throw new Error("Duplicate answer choices.");
    }
  }
  return sources.map((s) =>
    questions.find((q) => q.sourceQuestionId === s.id)!,
  );
}

export function studentVariantQuestions(
  questions: VariantQuestion[],
  attemptId: string,
) {
  // Explicit allowlist: never expose keys, solutions, objectives, or AI reviews.
  return questions.map((q) => ({
    id: q.id,
    text: q.text,
    answerMode: q.answerMode,
    answerUnit: q.answerUnit,
    options: shuffleAnswerChoices(q.options, `${attemptId}:${q.id}`).map(
      (o) => ({ id: o.id, text: o.text }),
    ),
  }));
}

export function scoreVariant(
  questions: VariantQuestion[],
  answers: SubmittedAnswer[],
  attemptId: string,
) {
  const byId = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set<string>();
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (!question || seen.has(answer.questionId))
      throw new Error("Unknown or repeated question.");
    seen.add(answer.questionId);
    const selected =
      answer.selectedOptionIds ??
      (answer.selectedOptionId ? [answer.selectedOptionId] : []);
    if (
      !Array.isArray(selected) ||
      selected.length > 1 ||
      selected.some(
        (id) =>
          typeof id !== "string" || !question.options.some((o) => o.id === id),
      )
    )
      throw new Error("Invalid answer choice.");
  }
  const submitted = new Map(answers.map((a) => [a.questionId, a]));
  return scoreQuiz({
    attemptId,
    questionsById: byId,
    answers: questions.map((q) => submitted.get(q.id) ?? { questionId: q.id }),
    totalQuestions: questions.length,
  });
}

export const verificationSchema = z.object({
  reviews: z
    .array(
      z.object({
        sourceQuestionId: z.string(),
        intentPreserved: z.boolean(),
        unambiguous: z.boolean(),
        answerNumeric: z.number().finite().nullable(),
        correctOptionId: z.string().nullable(),
        explanation: z.string().min(1),
      }),
    )
    .min(1)
    .max(40),
});

export function validateVerification(
  value: unknown,
  questions: VariantQuestion[],
) {
  const { reviews } = verificationSchema.parse(value);
  if (
    reviews.length !== questions.length ||
    new Set(reviews.map((r) => r.sourceQuestionId)).size !== questions.length
  )
    throw new Error("Incomplete independent review.");
  const reviewsBySource = new Map(reviews.map((r) => [r.sourceQuestionId, r]));
  for (const q of questions) {
    const r = reviewsBySource.get(q.sourceQuestionId);
    if (!r || !r.intentPreserved || !r.unambiguous)
      throw new Error(
        `Intent or ambiguity check failed: ${r?.explanation ?? q.sourceQuestionId}`,
      );
    if (
      q.answerMode === "NUMERIC"
        ? r.answerNumeric === null ||
          Math.abs(r.answerNumeric - q.answerNumeric!) >
            numericTolerance(q.answerNumeric!, q.answerTolerance)
        : r.correctOptionId !== q.options.find((o) => o.isCorrect)?.id
    )
      throw new Error(`Independent answer disagrees: ${r.explanation}`);
  }
  return reviews;
}
