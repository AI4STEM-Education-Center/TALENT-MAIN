import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  isConceptualQuestion,
  validateVariant,
  validateVerification,
  type VariantQuestion,
  type VerificationReview,
} from "@/lib/quiz-variants";
import {
  generateQuizVariantSample,
  type VerifiedSamplePair,
} from "@/lib/quiz-variants-engine";
import type { QuizVariantVariation } from "@/lib/quiz-variant-prompts";
import {
  INVALID_KEYS_ERROR,
  managedVariantQuiz,
  sourceFromQuestion,
  sourcesHaveValidKeys,
  variantSupportError,
  type VariantRouteContext,
} from "@/lib/quiz-variant-sources";
import { isSupportedCoachQuestionShape } from "@/lib/wrong-answer-coach-rules";
import { errorMessage } from "@/lib/errors";

const DEFAULT_OBJECTIVE =
  "Preserve the original learning objective, reasoning steps, units, and difficulty.";

const sampleSchema = z.object({
  questionId: z.string().min(1).max(200).optional(),
  objective: z.string().trim().min(10).max(2000).optional(),
  refresh: z.boolean().default(false),
});

function computeSampleSourceHash(source: VariantQuestion): string {
  const payload = JSON.stringify({
    text: source.text.trim(),
    answerMode: source.answerMode,
    answerUnit: source.answerUnit ?? null,
    answerNumeric: source.answerNumeric ?? null,
    answerTolerance: source.answerTolerance ?? null,
    options: source.options
      .map((o) => ({ text: o.text.trim(), isCorrect: o.isCorrect }))
      .sort((a, b) => a.text.localeCompare(b.text)),
  });
  return createHash("sha256").update(payload).digest("hex");
}

function computeObjectiveHash(objective: string): string {
  return createHash("sha256").update(objective.trim()).digest("hex");
}

function parseStoredSample(
  row: { questionJson: string; checkJson: string },
  source: VariantQuestion,
): VerifiedSamplePair | null {
  try {
    const rawQuestion = JSON.parse(row.questionJson) as VariantQuestion;
    const rawCheck = JSON.parse(row.checkJson) as VerificationReview;
    const [question] = validateVariant({ questions: [rawQuestion] }, [source]);
    const [check] = validateVerification({ reviews: [rawCheck] }, [question]);
    return { question, check };
  } catch {
    return null;
  }
}

/**
 * Synchronous one-question preview for the "Generate versions" modal:
 * returns persisted verified calibration samples per style (NUMBERS, CONTEXT,
 * and for Coach-eligible single-select questions also COACH_CHECK3 &
 * COACH_HELDOUT). Cached in DB by (questionId, variation, sourceHash,
 * objectiveHash) so reopening the modal or switching questions renders
 * immediately; only `refresh: true` ("Try another sample") regenerates.
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

  const coachEligible = isSupportedCoachQuestionShape({
    answerMode: target.answerMode,
    figureStorageKey: target.figureStorageKey,
    options: target.options,
  }).ok;
  const requiredVariations: QuizVariantVariation[] = coachEligible
    ? ["NUMBERS", "CONTEXT", "COACH_CHECK3", "COACH_HELDOUT"]
    : ["NUMBERS", "CONTEXT"];
  const sourceHash = computeSampleSourceHash(source);
  const objectiveHash = computeObjectiveHash(objective);

  const storedRows = await prisma.quizVariantCalibrationSample.findMany({
    where: {
      questionId: target.id,
      sourceHash,
      objectiveHash,
      variation: { in: requiredVariations },
    },
  });

  const cachedMap = new Map<
    QuizVariantVariation,
    { pair: VerifiedSamplePair; aiModel: string | null }
  >();
  for (const row of storedRows) {
    const pair = parseStoredSample(row, source);
    if (pair) {
      cachedMap.set(row.variation as QuizVariantVariation, {
        pair,
        aiModel: row.aiModel,
      });
    }
  }

  if (!body.data.refresh && requiredVariations.every((v) => cachedMap.has(v))) {
    const aiModel =
      cachedMap.get("NUMBERS")?.aiModel ??
      cachedMap.get("CONTEXT")?.aiModel ??
      "cached";
    return NextResponse.json({
      sourceQuestionId: source.id,
      numbersSample: cachedMap.get("NUMBERS")!.pair,
      contextSample: cachedMap.get("CONTEXT")!.pair,
      ...(cachedMap.get("COACH_CHECK3")
        ? { coachCheck3Sample: cachedMap.get("COACH_CHECK3")!.pair }
        : {}),
      ...(cachedMap.get("COACH_HELDOUT")
        ? { coachHeldOutSample: cachedMap.get("COACH_HELDOUT")!.pair }
        : {}),
      aiModel,
      cached: true,
    });
  }

  const missingVariations = body.data.refresh
    ? requiredVariations
    : requiredVariations.filter((v) => !cachedMap.has(v));
  // Always avoid previously cached sample texts: during refresh so the new
  // samples differ from what's being replaced, and during partial fills so
  // a newly generated Held-Out sample avoids duplicating a cached Check 3.
  const extraPrevious = [...cachedMap.values()].map(
    (entry) => entry.pair.question,
  );

  try {
    const generated = await generateQuizVariantSample({
      quizId: quiz.id,
      source,
      objective,
      includeCoach: coachEligible,
      variations: missingVariations,
      ...(extraPrevious.length ? { extraPrevious } : {}),
    });

    const freshEntries: Array<[QuizVariantVariation, VerifiedSamplePair]> = [];
    if (generated.numbersSample)
      freshEntries.push(["NUMBERS", generated.numbersSample]);
    if (generated.contextSample)
      freshEntries.push(["CONTEXT", generated.contextSample]);
    if (generated.coachCheck3Sample)
      freshEntries.push(["COACH_CHECK3", generated.coachCheck3Sample]);
    if (generated.coachHeldOutSample)
      freshEntries.push(["COACH_HELDOUT", generated.coachHeldOutSample]);

    const merged = new Map<QuizVariantVariation, VerifiedSamplePair>();
    if (!body.data.refresh) {
      for (const [variation, entry] of cachedMap) {
        merged.set(variation, entry.pair);
      }
    }

    if (body.data.refresh) {
      // Refresh replaces all requested styles atomically in one transaction.
      await prisma.$transaction(async (tx) => {
        for (const [variation, pair] of freshEntries) {
          await tx.quizVariantCalibrationSample.upsert({
            where: {
              questionId_variation_sourceHash_objectiveHash: {
                questionId: target.id,
                variation,
                sourceHash,
                objectiveHash,
              },
            },
            create: {
              quizId: quiz.id,
              questionId: target.id,
              variation,
              sourceHash,
              objectiveHash,
              questionJson: JSON.stringify(pair.question),
              checkJson: JSON.stringify(pair.check),
              aiModel: generated.aiModel,
            },
            update: {
              questionJson: JSON.stringify(pair.question),
              checkJson: JSON.stringify(pair.check),
              aiModel: generated.aiModel,
            },
          });
        }
      });
      for (const [variation, pair] of freshEntries) {
        merged.set(variation, pair);
      }
    } else {
      // Ordinary cache fill: preserve any winning row written by a concurrent
      // request (avoiding P2002 500s or mixed pairwise overwrites).
      for (const [variation, pair] of freshEntries) {
        try {
          await prisma.quizVariantCalibrationSample.create({
            data: {
              quizId: quiz.id,
              questionId: target.id,
              variation,
              sourceHash,
              objectiveHash,
              questionJson: JSON.stringify(pair.question),
              checkJson: JSON.stringify(pair.check),
              aiModel: generated.aiModel,
            },
          });
          merged.set(variation, pair);
        } catch (err) {
          const code =
            err && typeof err === "object" && "code" in err
              ? (err as { code?: unknown }).code
              : null;
          if (code !== "P2002") throw err;
          const winner = await prisma.quizVariantCalibrationSample.findUnique({
            where: {
              questionId_variation_sourceHash_objectiveHash: {
                questionId: target.id,
                variation,
                sourceHash,
                objectiveHash,
              },
            },
          });
          const parsedWinner = winner
            ? parseStoredSample(winner, source)
            : null;
          merged.set(variation, parsedWinner ?? pair);
        }
      }
    }

    return NextResponse.json({
      sourceQuestionId: generated.sourceQuestionId ?? source.id,
      numbersSample: merged.get("NUMBERS") ?? generated.numbersSample,
      contextSample: merged.get("CONTEXT") ?? generated.contextSample,
      ...(merged.get("COACH_CHECK3")
        ? { coachCheck3Sample: merged.get("COACH_CHECK3") }
        : {}),
      ...(merged.get("COACH_HELDOUT")
        ? { coachHeldOutSample: merged.get("COACH_HELDOUT") }
        : {}),
      aiModel: generated.aiModel,
      cached: false,
    });
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
