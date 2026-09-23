import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  buildSyllabusPageKey,
  getMaxUploadBytes,
  headS3Object,
  maxDerivedPageBytes,
} from "@/lib/storage";
import { PAGE_IMAGE_EXTENSION_VALUES } from "@/lib/page-image-format";
import { MAX_SYLLABUS_PAGES } from "@/lib/syllabus";
import { findSyllabus, ownedClass, toTeacherView } from "@/lib/syllabus-server";
import { enqueueSyllabusExtraction } from "@/lib/queue";
import { rateLimit } from "@/lib/rate-limit";
import { logApiError } from "@/lib/system-log";

export const runtime = "nodejs";

/**
 * POST /api/classes/[id]/syllabus/complete
 *   { revision, pages: [{ pageNumber, storageKey }] }
 * Finalize the pending upload: verify what actually landed in the bucket,
 * promote the revision to the syllabus's source, and queue extraction.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const [session, { id: classId }] = await Promise.all([auth(), params]);
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const cls = await ownedClass(session.user.id, classId);
  if (!cls)
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  const limited = rateLimit(
    req,
    "syllabus-complete",
    10,
    60_000,
    session.user.id,
  );
  if (limited) return limited;

  let body: {
    revision?: unknown;
    pages?: Array<{ pageNumber?: unknown; storageKey?: unknown }>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const syllabus = await findSyllabus(classId);
  if (
    !syllabus ||
    syllabus.status !== "PENDING_UPLOAD" ||
    syllabus.revision !== body.revision ||
    !syllabus.pendingStorageKey ||
    !syllabus.pendingName
  ) {
    return NextResponse.json(
      { error: "This upload was replaced by a newer one. Start again." },
      { status: 409 },
    );
  }
  const revision = syllabus.revision;
  const pdfKey = syllabus.pendingStorageKey;

  const posted = Array.isArray(body.pages) ? body.pages : [];
  if (posted.length === 0 || posted.length > MAX_SYLLABUS_PAGES) {
    return NextResponse.json(
      { error: `A syllabus must have 1 to ${MAX_SYLLABUS_PAGES} pages.` },
      { status: 400 },
    );
  }

  // SECURITY: page keys come from the client and are later signed for the
  // model and read back. Each must be the exact deterministic key for its page
  // in THIS revision, or a teacher could attach any object in the bucket.
  const ordered = posted.toSorted(
    (a, b) => (Number(a?.pageNumber) || 0) - (Number(b?.pageNumber) || 0),
  );
  const pageKeys: string[] = [];
  for (const [index, page] of ordered.entries()) {
    const expected = PAGE_IMAGE_EXTENSION_VALUES.map((extension) =>
      buildSyllabusPageKey(
        cls.teacherId,
        classId,
        syllabus.id,
        revision,
        index + 1,
        extension,
      ),
    );
    if (
      page?.pageNumber !== index + 1 ||
      typeof page.storageKey !== "string" ||
      !expected.includes(page.storageKey)
    ) {
      return NextResponse.json(
        { error: "Pages must be contiguous from 1 and use their upload keys." },
        { status: 400 },
      );
    }
    pageKeys.push(page.storageKey);
  }

  // The presigned PUT declares a size but can't enforce it; check what landed.
  let pdfBytes: number;
  let pageBytes: number[];
  try {
    const [pdf, pageHeads] = await Promise.all([
      headS3Object(syllabus.bucket, pdfKey),
      Promise.all(pageKeys.map((key) => headS3Object(syllabus.bucket, key))),
    ]);
    pdfBytes = pdf.contentLength;
    pageBytes = pageHeads.map((head) => head.contentLength);
  } catch {
    return NextResponse.json(
      { error: "Upload is incomplete in storage" },
      { status: 404 },
    );
  }
  const maxBytes = getMaxUploadBytes();
  if (
    pdfBytes < 1 ||
    pdfBytes > maxBytes ||
    pageBytes.some((bytes) => bytes < 1 || bytes > maxBytes) ||
    pageBytes.reduce((sum, bytes) => sum + bytes, 0) >
      maxDerivedPageBytes(pageBytes.length)
  ) {
    return NextResponse.json(
      { error: "Uploaded files exceed the size limit." },
      { status: 413 },
    );
  }

  const claimed = await prisma.classSyllabus.updateMany({
    where: { id: syllabus.id, revision, status: "PENDING_UPLOAD" },
    data: {
      status: "EXTRACTING",
      errorMessage: null,
      sourceRevision: revision,
      storageKey: pdfKey,
      originalName: syllabus.pendingName,
      sizeBytes: pdfBytes,
      totalPages: pageKeys.length,
      pageKeys: JSON.stringify(pageKeys),
      pendingStorageKey: null,
      pendingName: null,
      warnings: "[]",
    },
  });
  if (claimed.count !== 1) {
    return NextResponse.json(
      { error: "This upload was already finalized or replaced." },
      { status: 409 },
    );
  }

  try {
    enqueueSyllabusExtraction(syllabus.id, revision);
  } catch (e) {
    logApiError("SYLLABUS_ENQUEUE", e);
    await prisma.classSyllabus
      .updateMany({
        where: { id: syllabus.id, sourceRevision: revision },
        data: {
          status: "FAILED",
          errorMessage: "Could not queue extraction. Try running it again.",
        },
      })
      .catch(() => {});
  }

  const row = await findSyllabus(classId);
  return NextResponse.json(
    { syllabus: row ? toTeacherView(row) : null },
    { status: 202 },
  );
}
