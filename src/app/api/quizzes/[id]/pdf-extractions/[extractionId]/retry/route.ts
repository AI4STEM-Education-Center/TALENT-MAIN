import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import { enqueueQuizExtraction } from "@/lib/queue";

export const runtime = "nodejs";

// POST: re-run extraction for a FAILED row. The PDF + page PNGs are still in S3
// (a FAILED extraction is never cleaned up until discarded), so we only need to
// reset the status and re-enqueue. Same enqueue-failure handling as complete.
export async function POST(
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

  if (extraction.status !== "FAILED") {
    return NextResponse.json({ error: "Only a failed extraction can be retried" }, { status: 400 });
  }

  await prisma.quizPdfExtraction.update({
    where: { id: extraction.id },
    data: { status: "EXTRACTING", errorMessage: null },
  });

  try {
    enqueueQuizExtraction(extraction.id);
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : "Failed to enqueue extraction";
    await prisma.quizPdfExtraction
      .update({ where: { id: extraction.id }, data: { status: "FAILED", errorMessage } })
      .catch(() => {});
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }

  return NextResponse.json({ id: extraction.id, status: "EXTRACTING" }, { status: 202 });
}
