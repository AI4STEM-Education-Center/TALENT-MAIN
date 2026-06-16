import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import { parseStagedQuestions } from "@/lib/quiz-extraction";
import {
  deleteS3Objects,
  listS3Objects,
  presignGetUrl,
  quizExtractionPrefix,
} from "@/lib/storage";

export const runtime = "nodejs";

function parseWarnings(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((w): w is string => typeof w === "string") : [];
  } catch {
    return [];
  }
}

// GET: poll an extraction's status. Once AWAITING_REVIEW it also returns the
// staged questions and presigned page-image URLs for the review UI.
export async function GET(
  _req: NextRequest,
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

  const base = {
    id: extraction.id,
    status: extraction.status,
    originalName: extraction.originalName,
    totalPages: extraction.totalPages,
    errorMessage: extraction.errorMessage,
    hasAnswerKey: extraction.hasAnswerKey,
    warnings: parseWarnings(extraction.warnings),
    createdAt: extraction.createdAt,
    aiModel: extraction.aiModel,
    aiTtftMs: extraction.aiTtftMs,
    aiTokens: extraction.aiTokens,
  };

  if (extraction.status !== "AWAITING_REVIEW") {
    return NextResponse.json(base);
  }

  const pages = await prisma.quizPdfExtractionPage.findMany({
    where: { extractionId: extraction.id },
    orderBy: { pageNumber: "asc" },
  });

  const pageImages = await Promise.all(
    pages.map(async (page) => ({
      pageNumber: page.pageNumber,
      url: await presignGetUrl(extraction.bucket, page.storageKey),
    }))
  );

  return NextResponse.json({
    ...base,
    questions: parseStagedQuestions(extraction.extractedQuestions),
    pageImages,
  });
}

// DELETE: discard an extraction. Refuses once COMMITTED (its questions are live).
// Otherwise best-effort S3 cleanup, then remove the row (cascades the pages).
export async function DELETE(
  _req: NextRequest,
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

  if (extraction.status === "COMMITTED") {
    return NextResponse.json({ error: "A committed extraction cannot be discarded" }, { status: 409 });
  }

  try {
    const prefix = quizExtractionPrefix(extraction.storageKey);
    const keys = await listS3Objects(extraction.bucket, prefix);
    if (keys.length > 0) {
      await deleteS3Objects(extraction.bucket, keys);
    }
  } catch (e) {
    // Best-effort: orphaned S3 objects are tolerable, a stuck row is not.
    console.error("Failed to clean up extraction S3 objects:", e);
  }

  await prisma.quizPdfExtraction.delete({ where: { id: extraction.id } });

  return NextResponse.json({ ok: true });
}
