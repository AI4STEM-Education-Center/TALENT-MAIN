import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import {
  buildQuizExtractionPdfKey,
  buildQuizExtractionPageKey,
  getMaxUploadBytes,
  maxDerivedPageBytes,
  getS3Config,
  presignPutUpload,
  sanitizeFilename,
} from "@/lib/storage";

export const runtime = "nodejs";

/** Maximum number of pages accepted in a single quiz-PDF extraction. */
export const MAX_QUIZ_PDF_PAGES = 20;

type InitPage = { pageNumber: number; sizeBytes: number };

// POST: initialize a quiz-PDF extraction. Mirrors the materials presigned-upload
// init: create the row, presign a PUT for the PDF + one per page, and roll the
// row back if any presign fails. Teachers extract into their own quizzes; admins
// extract into global-pool quizzes (teacherId null), same as question-imports.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const [actor, { id: quizId }] = await Promise.all([getContentActor(), params]);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz || !canManage(actor, quiz)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  let bucket: string;
  try {
    bucket = getS3Config().bucket;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "S3 not configured" },
      { status: 500 }
    );
  }

  let body: { originalName?: unknown; sizeBytes?: unknown; pages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const originalName =
    typeof body.originalName === "string" ? sanitizeFilename(body.originalName) : "";
  if (!originalName) {
    return NextResponse.json({ error: "originalName is required" }, { status: 400 });
  }
  if (!originalName.toLowerCase().endsWith(".pdf")) {
    return NextResponse.json({ error: "Only PDF files are supported" }, { status: 400 });
  }

  const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : 0;
  const maxBytes = getMaxUploadBytes();
  if (sizeBytes < 1 || sizeBytes > maxBytes) {
    return NextResponse.json(
      { error: `sizeBytes must be between 1 and ${maxBytes}` },
      { status: 400 }
    );
  }

  if (!Array.isArray(body.pages) || body.pages.length < 1) {
    return NextResponse.json({ error: "pages array is required" }, { status: 400 });
  }
  if (body.pages.length > MAX_QUIZ_PDF_PAGES) {
    return NextResponse.json(
      { error: `A quiz PDF may have at most ${MAX_QUIZ_PDF_PAGES} pages` },
      { status: 400 }
    );
  }

  const pages: InitPage[] = [];
  for (let i = 0; i < body.pages.length; i++) {
    const raw = body.pages[i] as { pageNumber?: unknown; sizeBytes?: unknown } | null;
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ error: `pages[${i}] must be an object` }, { status: 400 });
    }
    const pageNumber = typeof raw.pageNumber === "number" ? raw.pageNumber : NaN;
    // Page numbers must be contiguous starting at 1, in the order posted.
    if (pageNumber !== i + 1) {
      return NextResponse.json(
        { error: "pageNumbers must be contiguous starting at 1" },
        { status: 400 }
      );
    }
    const pageSize = typeof raw.sizeBytes === "number" ? raw.sizeBytes : 0;
    if (pageSize < 1 || pageSize > maxBytes) {
      return NextResponse.json(
        { error: `pages[${i}].sizeBytes must be between 1 and ${maxBytes}` },
        { status: 400 }
      );
    }
    pages.push({ pageNumber, sizeBytes: pageSize });
  }
  if (
    pages.reduce((total, page) => total + page.sizeBytes, 0) >
    maxDerivedPageBytes(pages.length)
  ) {
    return NextResponse.json(
      { error: "Rendered pages exceed the aggregate upload limit" },
      { status: 413 }
    );
  }

  const extractionId = randomUUID();
  const storageKey = buildQuizExtractionPdfKey(actor.teacherId, quizId, extractionId, originalName);

  const extraction = await prisma.quizPdfExtraction.create({
    data: {
      id: extractionId,
      quizId,
      teacherId: actor.teacherId,
      originalName,
      sizeBytes,
      storageKey,
      bucket,
      status: "PENDING_UPLOAD",
    },
  });

  try {
    const pdfPresignedUrl = await presignPutUpload(bucket, storageKey, "application/pdf", sizeBytes);
    const pagePresigns = await Promise.all(
      pages.map(async (p) => {
        const key = buildQuizExtractionPageKey(actor.teacherId, quizId, extractionId, p.pageNumber);
        const presignedUrl = await presignPutUpload(bucket, key, "image/png", p.sizeBytes);
        return { pageNumber: p.pageNumber, presignedUrl, storageKey: key };
      })
    );

    return NextResponse.json(
      {
        id: extraction.id,
        pdf: { presignedUrl: pdfPresignedUrl, storageKey },
        pages: pagePresigns,
      },
      { status: 201 }
    );
  } catch (e) {
    await prisma.quizPdfExtraction.delete({ where: { id: extraction.id } }).catch(() => {});
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create upload URLs" },
      { status: 500 }
    );
  }
}

// GET: list extractions for the quiz, newest first, so the UI can resume a
// pending review.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const [actor, { id: quizId }] = await Promise.all([getContentActor(), params]);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz || !canManage(actor, quiz)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  const extractions = await prisma.quizPdfExtraction.findMany({
    where: { quizId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      originalName: true,
      totalPages: true,
      errorMessage: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ extractions });
}
