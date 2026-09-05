import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManage, getContentActor } from "@/lib/quiz-access";
import { enqueueQuizExtraction } from "@/lib/queue";
import {
  buildQuizExtractionPageKey,
  getMaxUploadBytes,
  maxDerivedPageBytes,
  headS3Object,
} from "@/lib/storage";
import { rateLimit } from "@/lib/rate-limit";
import { PAGE_IMAGE_EXTENSION_VALUES } from "@/lib/page-image-format";

export const runtime = "nodejs";

/** Maximum number of pages accepted in a single quiz-PDF extraction. */
const MAX_QUIZ_PDF_PAGES = 20;
class ExtractionAlreadyClaimedError extends Error {}

type CompletePage = { pageNumber: number; storageKey: string };

// POST: finalize a quiz-PDF upload. The client has PUT the PDF + page images to
// the presigned URLs from init; this confirms every object exists, persists the
// page rows, flips the extraction to EXTRACTING, and enqueues the vision-LLM
// job. The job IS the feature, so an enqueue failure marks the row FAILED.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; extractionId: string }> },
) {
  const [actor, { id: quizId, extractionId }] = await Promise.all([
    getContentActor(),
    params,
  ]);
  if (!actor)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = rateLimit(
    req,
    "quiz-extraction-complete",
    10,
    60_000,
    actor.userId,
  );
  if (limited) return limited;

  const quiz = await prisma.quiz.findUnique({ where: { id: quizId } });
  if (!quiz || !canManage(actor, quiz)) {
    return NextResponse.json({ error: "Quiz not found" }, { status: 404 });
  }

  const extraction = await prisma.quizPdfExtraction.findUnique({
    where: { id: extractionId },
  });
  if (!extraction || extraction.quizId !== quizId) {
    return NextResponse.json(
      { error: "Extraction not found" },
      { status: 404 },
    );
  }

  if (extraction.status !== "PENDING_UPLOAD") {
    return NextResponse.json(
      { error: "Extraction is not awaiting upload" },
      { status: 400 },
    );
  }

  let body: { pages?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.pages) || body.pages.length < 1) {
    return NextResponse.json(
      { error: "pages array is required" },
      { status: 400 },
    );
  }
  if (body.pages.length > MAX_QUIZ_PDF_PAGES) {
    return NextResponse.json(
      { error: `A quiz PDF may have at most ${MAX_QUIZ_PDF_PAGES} pages` },
      { status: 400 },
    );
  }

  // Page numbers must be contiguous from 1 (in posted order) and every
  // storageKey must EXACTLY match the deterministic key the client was handed at
  // init — this is the gate that prevents an attacker pointing a page row at an
  // arbitrary S3 object they do not own.
  const pages: CompletePage[] = [];
  for (let i = 0; i < body.pages.length; i++) {
    const raw = body.pages[i] as {
      pageNumber?: unknown;
      storageKey?: unknown;
    } | null;
    if (!raw || typeof raw !== "object") {
      return NextResponse.json(
        { error: `pages[${i}] must be an object` },
        { status: 400 },
      );
    }
    const pageNumber =
      typeof raw.pageNumber === "number" ? raw.pageNumber : NaN;
    if (pageNumber !== i + 1) {
      return NextResponse.json(
        { error: "pageNumbers must be contiguous starting at 1" },
        { status: 400 },
      );
    }
    // One candidate per supported page-image format — the format was chosen at
    // init time and this request does not carry it.
    const expectedKeys = PAGE_IMAGE_EXTENSION_VALUES.map((extension) =>
      buildQuizExtractionPageKey(
        extraction.teacherId,
        extraction.quizId,
        extraction.id,
        pageNumber,
        extension,
      ),
    );
    if (
      typeof raw.storageKey !== "string" ||
      !expectedKeys.includes(raw.storageKey)
    ) {
      return NextResponse.json(
        {
          error: `pages[${i}].storageKey does not match the expected upload key`,
        },
        { status: 400 },
      );
    }
    pages.push({ pageNumber, storageKey: raw.storageKey });
  }

  // Confirm the PDF and every page actually landed in S3 before we commit to
  // running the (paid) extraction job.
  let pdfHead: { contentLength: number };
  let pageHeads: Array<{ contentLength: number }>;
  try {
    [pdfHead, pageHeads] = await Promise.all([
      headS3Object(extraction.bucket, extraction.storageKey),
      Promise.all(
        pages.map((p) => headS3Object(extraction.bucket, p.storageKey)),
      ),
    ]);
  } catch {
    return NextResponse.json({ error: "upload incomplete" }, { status: 400 });
  }

  const maxBytes = getMaxUploadBytes();
  if (
    pdfHead.contentLength < 1 ||
    pdfHead.contentLength > maxBytes ||
    pageHeads.some(
      (page) => page.contentLength < 1 || page.contentLength > maxBytes,
    ) ||
    pageHeads.reduce((total, page) => total + page.contentLength, 0) >
      maxDerivedPageBytes(pageHeads.length)
  ) {
    return NextResponse.json(
      { error: "Uploaded objects exceed size limits" },
      { status: 413 },
    );
  }

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.quizPdfExtraction.updateMany({
        where: { id: extraction.id, status: "PENDING_UPLOAD" },
        data: {
          status: "EXTRACTING",
          totalPages: pages.length,
          sizeBytes: pdfHead.contentLength,
        },
      });
      if (claimed.count !== 1) throw new ExtractionAlreadyClaimedError();

      await tx.quizPdfExtractionPage.createMany({
        data: pages.map((p) => ({
          extractionId: extraction.id,
          pageNumber: p.pageNumber,
          storageKey: p.storageKey,
        })),
      });
    });
  } catch (error) {
    if (error instanceof ExtractionAlreadyClaimedError) {
      return NextResponse.json(
        { error: "Extraction upload has already been finalized" },
        { status: 409 },
      );
    }
    throw error;
  }

  try {
    enqueueQuizExtraction(extraction.id);
  } catch (e) {
    const errorMessage =
      e instanceof Error ? e.message : "Failed to enqueue extraction";
    await prisma.quizPdfExtraction
      .update({
        where: { id: extraction.id },
        data: { status: "FAILED", errorMessage },
      })
      .catch(() => {});
    return NextResponse.json({ error: errorMessage }, { status: 500 });
  }

  return NextResponse.json(
    { id: extraction.id, status: "EXTRACTING", totalPages: pages.length },
    { status: 202 },
  );
}
