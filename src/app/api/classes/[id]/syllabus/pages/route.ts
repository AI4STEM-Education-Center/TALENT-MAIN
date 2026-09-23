import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  buildSyllabusPageKey,
  getMaxUploadBytes,
  maxDerivedPageBytes,
  presignPutUpload,
} from "@/lib/storage";
import {
  pageImageExtension,
  parsePageImageMimeType,
} from "@/lib/page-image-format";
import { MAX_SYLLABUS_PAGES } from "@/lib/syllabus";
import { findSyllabus, ownedClass } from "@/lib/syllabus-server";

export const runtime = "nodejs";

/**
 * POST /api/classes/[id]/syllabus/pages
 *   { revision, pages: [{ pageNumber, sizeBytes, contentType }] }
 * Presigned PUTs for the rendered page images of the pending upload. Mirrors
 * the learning-materials pages route, minus the legacy PNG-only client path.
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

  let body: {
    revision?: unknown;
    pages?: Array<{
      pageNumber?: unknown;
      sizeBytes?: unknown;
      contentType?: unknown;
    }>;
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
    syllabus.revision !== body.revision
  ) {
    return NextResponse.json(
      { error: "This upload was replaced by a newer one. Start again." },
      { status: 409 },
    );
  }

  const pages = Array.isArray(body.pages) ? body.pages : [];
  if (pages.length === 0 || pages.length > MAX_SYLLABUS_PAGES) {
    return NextResponse.json(
      { error: `A syllabus must have 1 to ${MAX_SYLLABUS_PAGES} pages.` },
      { status: 400 },
    );
  }

  const maxBytes = getMaxUploadBytes();
  const seen = new Set<number>();
  let declaredTotal = 0;
  for (const page of pages) {
    const { pageNumber, sizeBytes } = page ?? {};
    if (
      typeof pageNumber !== "number" ||
      !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      pageNumber > MAX_SYLLABUS_PAGES ||
      seen.has(pageNumber) ||
      typeof sizeBytes !== "number" ||
      sizeBytes < 1 ||
      sizeBytes > maxBytes ||
      !parsePageImageMimeType(page.contentType)
    ) {
      return NextResponse.json({ error: "Invalid page data" }, { status: 400 });
    }
    seen.add(pageNumber);
    declaredTotal += sizeBytes;
  }
  if (declaredTotal > maxDerivedPageBytes(pages.length)) {
    return NextResponse.json(
      { error: "Rendered pages exceed the upload limit for this document." },
      { status: 413 },
    );
  }

  const results = await Promise.all(
    pages.map(async (page) => {
      const pageNumber = page.pageNumber as number;
      const mimeType = parsePageImageMimeType(page.contentType)!;
      const storageKey = buildSyllabusPageKey(
        cls.teacherId,
        classId,
        syllabus.id,
        syllabus.revision,
        pageNumber,
        pageImageExtension(mimeType),
      );
      const presignedUrl = await presignPutUpload(
        syllabus.bucket,
        storageKey,
        mimeType,
        page.sizeBytes as number,
      );
      return { pageNumber, presignedUrl, storageKey, mimeType };
    }),
  ).catch(() => null);
  if (!results) {
    return NextResponse.json(
      { error: "Failed to create upload URLs" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    pages: results.toSorted((a, b) => a.pageNumber - b.pageNumber),
  });
}
