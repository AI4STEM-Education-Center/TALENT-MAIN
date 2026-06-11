import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import { buildQuizExtractionFigureKey, presignPutUpload } from "@/lib/storage";

export const runtime = "nodejs";

/** Upper bound on a question index, mirroring a sane per-quiz question count. */
const MAX_QUESTION_INDEX = 199;

// POST: hand back presigned PUT URLs so the review UI can upload the cropped
// figure PNGs (one per question that has a figure) before commit. Keyed by
// questionIndex so the key is deterministic and verifiable at commit time.
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

  let body: { questionIndexes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.questionIndexes) || body.questionIndexes.length < 1) {
    return NextResponse.json({ error: "questionIndexes array is required" }, { status: 400 });
  }

  const seen = new Set<number>();
  for (const raw of body.questionIndexes) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > MAX_QUESTION_INDEX) {
      return NextResponse.json(
        { error: `questionIndexes must be integers in 0..${MAX_QUESTION_INDEX}` },
        { status: 400 }
      );
    }
    seen.add(raw);
  }

  try {
    const figures = await Promise.all(
      [...seen].map(async (questionIndex) => {
        const storageKey = buildQuizExtractionFigureKey(
          extraction.teacherId,
          extraction.quizId,
          extraction.id,
          questionIndex
        );
        const presignedUrl = await presignPutUpload(extraction.bucket, storageKey, "image/png", 0);
        return { questionIndex, presignedUrl, storageKey };
      })
    );
    return NextResponse.json({ figures });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create figure upload URLs" },
      { status: 500 }
    );
  }
}
