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
/**
 * Schema passed to structured-output generation calls: allows `questions: []`
 * with an optional `refusalReason` when the source question is flawed or cannot
 * be safely varied, so the model can follow the refusal instruction without
 * failing JSON schema validation before `validateVariant` inspects it.
 */
export const variantGenerationSchema = z.object({
  questions: z.array(variantQuestionSchema).max(40),
  refusalReason: z.string().max(1000).nullable().optional(),
});
export type VariantQuestion = z.infer<typeof variantQuestionSchema>;

export const questionRevisionSchema = z.object({
  sourceQuestionId: z.string().min(1).max(200),
  reason: z.string().trim().min(3).max(2000),
});
export const questionRevisionListSchema = z
  .array(questionRevisionSchema)
  .min(1)
  .max(40);
export type QuestionRevision = z.infer<typeof questionRevisionSchema>;

export const variantMixSchema = z.enum(["4-0", "2-2", "0-4"]);
export type VariantMix = z.infer<typeof variantMixSchema>;
export const MIX_COUNTS: Record<
  VariantMix,
  { numbers: number; context: number }
> = {
  "4-0": { numbers: 4, context: 0 },
  "2-2": { numbers: 2, context: 2 },
  "0-4": { numbers: 0, context: 4 },
};

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
  const raw = value as { questions?: unknown[]; refusalReason?: string | null };
  if (
    raw &&
    typeof raw === "object" &&
    Array.isArray(raw.questions) &&
    raw.questions.length === 0
  ) {
    throw new Error(
      raw.refusalReason?.trim()
        ? `Source question cannot be varied safely: ${raw.refusalReason.trim()}`
        : "Model refused to vary flawed or unsupported source questions.",
    );
  }
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

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
  "at",
  "for",
  "is",
  "are",
  "was",
  "were",
  "be",
  "by",
  "with",
  "from",
  "that",
  "this",
  "which",
  "what",
  "when",
  "where",
  "if",
  "then",
  "and",
  "or",
  "as",
  "it",
  "its",
]);

function contentTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\$[^$]*\$/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
}

function normalizeChoiceText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * True when a single-select question has no digits anywhere in its stem or
 * choices (purely conceptual / qualitative).
 */
export function isConceptualQuestion(source: {
  text: string;
  answerMode: string;
  options: { text: string }[];
}): boolean {
  if (source.answerMode === "NUMERIC") return false;
  if (/\d/.test(source.text)) return false;
  return source.options.every((o) => !/\d/.test(o.text));
}

/**
 * Rejects decorative numbers injected into a purely conceptual question when
 * the answer choices remain purely qualitative (numbers do not affect the answer).
 */
export function checkConceptualNumberMisuse(
  source: {
    text: string;
    answerMode: string;
    options: { text: string }[];
  },
  candidate: VariantQuestion,
): string | null {
  if (!isConceptualQuestion(source)) return null;
  const stemHasDigits = /\d/.test(candidate.text);
  const choicesHaveDigits = candidate.options.some((o) => /\d/.test(o.text));
  if (stemHasDigits && !choicesHaveDigits) {
    return `Question ${source.text.slice(0, 60)}: source is purely conceptual; do not inject unused decorative numbers into the stem. Vary the physical condition, direction, or comparison instead.`;
  }
  return null;
}

/**
 * Enforces genuine stem and answer-choice rewriting in CONTEXT ("Full question
 * rewrite") mode so students cannot match memorized correct-choice wording.
 */
export function checkContextRewriteDistinctness(
  source: {
    text: string;
    answerMode: string;
    options: { text: string; isCorrect: boolean }[];
  },
  candidate: VariantQuestion,
): string | null {
  const srcTokens = new Set(contentTokens(source.text));
  const candTokens = new Set(contentTokens(candidate.text));
  if (srcTokens.size >= 6 && candTokens.size >= 6) {
    let intersection = 0;
    for (const token of candTokens) {
      if (srcTokens.has(token)) intersection++;
    }
    const union = srcTokens.size + candTokens.size - intersection;
    const jaccard = union > 0 ? intersection / union : 0;
    if (jaccard > 0.75) {
      return `Full rewrite (CONTEXT) stem is too close to the original wording (${Math.round(jaccard * 100)}% overlap). Use a genuinely new scenario and sentence structure.`;
    }
  }

  if (candidate.answerMode === "SINGLE_SELECT") {
    const srcCorrect = source.options.find((o) => o.isCorrect);
    const candCorrect = candidate.options.find((o) => o.isCorrect);
    if (srcCorrect && candCorrect) {
      const srcWords = contentTokens(srcCorrect.text);
      const hasLetters = /[a-zA-Z]{3,}/.test(srcCorrect.text);
      // Multi-word prose options (>= 3 content words) must be reworded in a full rewrite
      // rather than copied verbatim from the source answer key.
      if (
        hasLetters &&
        srcWords.length >= 3 &&
        normalizeChoiceText(srcCorrect.text) ===
          normalizeChoiceText(candCorrect.text)
      ) {
        return `Full rewrite (CONTEXT) copied the original correct answer choice verbatim ("${candCorrect.text.slice(0, 80)}"). Rewrite all prose answer choices to match the new scenario so memorized option text cannot be matched.`;
      }
    }
  }
  return null;
}

/**
 * Verifies that a numeric candidate's worked solution actually mentions a value
 * consistent with `answerNumeric` when numbers appear in the solution.
 */
export function checkWorkedSolutionConsistency(
  candidate: VariantQuestion,
): string | null {
  if (candidate.answerMode !== "NUMERIC" || candidate.answerNumeric === null) {
    return null;
  }
  const matches = candidate.solution.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi);
  if (!matches || matches.length === 0) return null;
  const tol = numericTolerance(
    candidate.answerNumeric,
    candidate.answerTolerance,
  );
  const parsed = matches.map(Number).filter(Number.isFinite);
  if (parsed.length === 0) return null;
  const agrees = parsed.some(
    (n) => Math.abs(n - candidate.answerNumeric!) <= tol,
  );
  if (!agrees) {
    return `Worked solution never arrives at answerNumeric (${candidate.answerNumeric}). Recompute the answer key and worked solution consistently.`;
  }
  return null;
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

export type VerificationReview = z.infer<
  typeof verificationSchema
>["reviews"][number];

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
