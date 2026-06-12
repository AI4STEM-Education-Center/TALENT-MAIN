import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import {
  buildQuizExtractionFigureKey,
  buildQuizExtractionOptionImageKey,
  presignPutUpload,
} from "@/lib/storage";

export const runtime = "nodejs";

/** Upper bound on a question index, mirroring a sane per-quiz question count. */
const MAX_QUESTION_INDEX = 199;
/** Upper bound on an option index within a question. */
const MAX_OPTION_INDEX = 25;

function isValidIndex(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

// POST: hand back presigned PUT URLs so the review UI can upload cropped figure
// PNGs before commit — both the per-question figure crops AND the per-option
// image-choice crops. Each key is deterministic (and lives under the
// extraction's figures/ prefix) so it is verifiable at commit time.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; extractionId: string }> }
) {
  const [actor, { id: quizId, extractionId }] = await Promise.all([getContentActor(), params]);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz || !canManage(actor, quiz)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  const extraction = await prisma.quizPdfExtraction.findUnique({ where: { id: extractionId } });
  if (!extraction || extraction.quizId !== quizId) {
    return NextResponse.json({ error: "Extraction not found" }, { status: 404 });
  }

  if (extraction.status !== "AWAITING_REVIEW") {
    return NextResponse.json({ error: "Extraction is not awaiting review" }, { status: 400 });
  }

  let body: { questionFigures?: unknown; optionImages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Question-figure crops: an array of question indexes.
  const figureIndexes = new Set<number>();
  if (body.questionFigures !== undefined) {
    if (!Array.isArray(body.questionFigures)) {
      return NextResponse.json({ error: "questionFigures must be an array" }, { status: 400 });
    }
    for (const raw of body.questionFigures) {
      if (!isValidIndex(raw, MAX_QUESTION_INDEX)) {
        return NextResponse.json(
          { error: `questionFigures must be integers in 0..${MAX_QUESTION_INDEX}` },
          { status: 400 }
        );
      }
      figureIndexes.add(raw);
    }
  }

  // Option-image crops: an array of { questionIndex, optionIndex } pairs.
  const optionPairs: { questionIndex: number; optionIndex: number }[] = [];
  const seenOption = new Set<string>();
  if (body.optionImages !== undefined) {
    if (!Array.isArray(body.optionImages)) {
      return NextResponse.json({ error: "optionImages must be an array" }, { status: 400 });
    }
    for (const raw of body.optionImages) {
      const qi = (raw as { questionIndex?: unknown })?.questionIndex;
      const oi = (raw as { optionIndex?: unknown })?.optionIndex;
      if (!isValidIndex(qi, MAX_QUESTION_INDEX) || !isValidIndex(oi, MAX_OPTION_INDEX)) {
        return NextResponse.json(
          { error: `optionImages need questionIndex 0..${MAX_QUESTION_INDEX} and optionIndex 0..${MAX_OPTION_INDEX}` },
          { status: 400 }
        );
      }
      const dedupeKey = `${qi}:${oi}`;
      if (seenOption.has(dedupeKey)) continue;
      seenOption.add(dedupeKey);
      optionPairs.push({ questionIndex: qi, optionIndex: oi });
    }
  }

  if (figureIndexes.size === 0 && optionPairs.length === 0) {
    return NextResponse.json(
      { error: "questionFigures or optionImages is required" },
      { status: 400 }
    );
  }

  try {
    const [questionFigures, optionImages] = await Promise.all([
      Promise.all(
        [...figureIndexes].map(async (questionIndex) => {
          const storageKey = buildQuizExtractionFigureKey(
            extraction.teacherId,
            extraction.quizId,
            extraction.id,
            questionIndex
          );
          const presignedUrl = await presignPutUpload(extraction.bucket, storageKey, "image/png", 0);
          return { questionIndex, presignedUrl, storageKey };
        })
      ),
      Promise.all(
        optionPairs.map(async ({ questionIndex, optionIndex }) => {
          const storageKey = buildQuizExtractionOptionImageKey(
            extraction.teacherId,
            extraction.quizId,
            extraction.id,
            questionIndex,
            optionIndex
          );
          const presignedUrl = await presignPutUpload(extraction.bucket, storageKey, "image/png", 0);
          return { questionIndex, optionIndex, presignedUrl, storageKey };
        })
      ),
    ]);
    return NextResponse.json({ questionFigures, optionImages });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create figure upload URLs" },
      { status: 500 }
    );
  }
}
