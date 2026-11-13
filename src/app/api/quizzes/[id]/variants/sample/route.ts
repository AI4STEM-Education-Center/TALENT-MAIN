import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isConceptualQuestion } from "@/lib/quiz-variants";
import { generateQuizVariantSample } from "@/lib/quiz-variants-engine";
import {
  INVALID_KEYS_ERROR,
  managedVariantQuiz,
  sourceFromQuestion,
  sourcesHaveValidKeys,
  variantSupportError,
  type VariantRouteContext,
} from "@/lib/quiz-variant-sources";
import { errorMessage } from "@/lib/errors";

const DEFAULT_OBJECTIVE =
  "Preserve the original learning objective, reasoning steps, units, and difficulty.";

const sampleSchema = z.object({
  questionId: z.string().min(1).max(200).optional(),
  objective: z.string().trim().min(10).max(2000).optional(),
});

/**
 * Synchronous one-question preview for the "Generate versions" modal: one
 * limited-numerical and one full-rewrite alternative of a single question,
 * both independently verified, so the teacher can pick a mix with confidence.
 */
export async function POST(req: NextRequest, context: VariantRouteContext) {
  const quiz = await managedVariantQuiz(context);
  if (!quiz)
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  const body = sampleSchema.safeParse(
    (await req.json().catch(() => null)) ?? {},
  );
  if (!body.success)
    return NextResponse.json(
      {
        error:
          "Provide an optional questionId and an objective of at least 10 characters.",
      },
      { status: 400 },
    );
  const unsupported = variantSupportError(quiz);
  if (unsupported)
    return NextResponse.json({ error: unsupported }, { status: 400 });

  const target = body.data.questionId
    ? quiz.questions.find((q) => q.id === body.data.questionId)
    : (quiz.questions.find((q) => !isConceptualQuestion(q)) ??
      quiz.questions[0]);
  if (!target)
    return NextResponse.json(
      {
        error:
          "That question is no longer part of this quiz. Reload and try again.",
      },
      { status: 404 },
    );
  const objective = body.data.objective ?? DEFAULT_OBJECTIVE;
  const source = sourceFromQuestion(target, objective);
  if (!sourcesHaveValidKeys([source]))
    return NextResponse.json({ error: INVALID_KEYS_ERROR }, { status: 400 });

  try {
    const sample = await generateQuizVariantSample({
      quizId: quiz.id,
      source,
      objective,
    });
    return NextResponse.json(sample);
  } catch (error) {
    const message = errorMessage(error);
    const unconfigured = message.includes("AI Config");
    return NextResponse.json(
      {
        error: unconfigured
          ? message
          : `Could not generate a verified sample: ${message}`.slice(0, 1000),
      },
      { status: unconfigured ? 503 : 502 },
    );
  }
}
