import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  buildPageStorageKey,
  getMaxUploadBytes,
  maxDerivedPageBytes,
  presignPutUpload,
  getS3Config,
} from "@/lib/storage";
import { materialLinkedToClass } from "@/lib/learning-material";
import {
  LEGACY_PAGE_IMAGE_EXTENSION,
  pageImageExtension,
  parsePageImageMimeType,
} from "@/lib/page-image-format";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; materialId: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ id: classId, materialId }, teacher] = await Promise.all([
    params,
    prisma.teacher.findUnique({ where: { userId: session.user.id } }),
  ]);
  if (!teacher)
    return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  // Verify class ownership
  const cls = await prisma.class.findFirst({
    where: { id: classId, teacherId: teacher.id },
  });
  if (!cls)
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  // Verify material is linked to this class and owned by the teacher
  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
  });
  if (
    !material ||
    material.teacherId !== teacher.id ||
    !(await materialLinkedToClass(materialId, classId))
  ) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }

  // Page keys are built from the material's origin classId so imported-context
  // calls still write to the same storage prefix as the original upload.
  const storageClassId = material.classId ?? classId;

  let bucket: string;
  try {
    bucket = getS3Config().bucket;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "S3 not configured" },
      { status: 500 },
    );
  }

  let body: {
    pages?: Array<{
      pageNumber: number;
      sizeBytes: number;
      contentType?: string;
    }>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.pages) || body.pages.length === 0) {
    return NextResponse.json(
      { error: "pages array is required" },
      { status: 400 },
    );
  }

  if (body.pages.length > 100) {
    return NextResponse.json(
      { error: "Maximum 100 pages per request" },
      { status: 400 },
    );
  }

  const pageNumbers = body.pages.map((page) => page?.pageNumber);
  if (
    pageNumbers.some(
      (pageNumber) =>
        typeof pageNumber !== "number" ||
        !Number.isInteger(pageNumber) ||
        pageNumber < 1 ||
        pageNumber > 100,
    ) ||
    new Set(pageNumbers).size !== pageNumbers.length
  ) {
    return NextResponse.json(
      { error: "pageNumber must be a unique integer between 1 and 100" },
      { status: 400 },
    );
  }

  const maxBytes = getMaxUploadBytes();

  // Reject an over-budget document HERE, before a single upload URL is issued.
  // The completion endpoint re-checks the sizes that actually landed (declared
  // sizes are only a client claim), but finding out there means the teacher has
  // already waited through the whole upload and the bucket is holding every
  // orphaned page. These declared sizes are enough to answer immediately.
  const declaredTotal = body.pages.reduce(
    (total, page) =>
      total + (typeof page?.sizeBytes === "number" ? page.sizeBytes : 0),
    0,
  );
  const aggregateLimit = maxDerivedPageBytes(body.pages.length);
  if (declaredTotal > aggregateLimit) {
    return NextResponse.json(
      {
        error:
          `These ${body.pages.length} pages total ${declaredTotal} bytes, over the ` +
          `${aggregateLimit}-byte limit for a document this length. Re-upload at a lower resolution.`,
      },
      { status: 413 },
    );
  }

  const results = await Promise.all(
    body.pages.map(async (page) => {
      if (
        typeof page.pageNumber !== "number" ||
        typeof page.sizeBytes !== "number"
      ) {
        return { pageNumber: page.pageNumber, error: "Invalid page data" };
      }
      if (page.sizeBytes < 1 || page.sizeBytes > maxBytes) {
        return {
          pageNumber: page.pageNumber,
          error: `sizeBytes must be between 1 and ${maxBytes}`,
        };
      }

      // The client declares the format it encoded each page in — WebP for any
      // browser whose canvas can produce it, PNG otherwise — and the key's
      // extension is derived from that, so the signed Content-Type always
      // matches the bytes that land. An omitted contentType is a client from
      // before the WebP switch, which uploads PNG.
      const requested = parsePageImageMimeType(page.contentType);
      if (page.contentType !== undefined && !requested) {
        return {
          pageNumber: page.pageNumber,
          error: "Unsupported page image contentType",
        };
      }
      const mimeType = requested ?? "image/png";
      const extension = requested
        ? pageImageExtension(requested)
        : LEGACY_PAGE_IMAGE_EXTENSION;

      const storageKey = buildPageStorageKey(
        teacher.id,
        storageClassId,
        materialId,
        page.pageNumber,
        extension,
      );

      try {
        const presignedUrl = await presignPutUpload(
          bucket,
          storageKey,
          mimeType,
          page.sizeBytes,
        );
        return {
          pageNumber: page.pageNumber,
          presignedUrl,
          storageKey,
          mimeType,
          method: "PUT",
        };
      } catch (e) {
        return {
          pageNumber: page.pageNumber,
          error: e instanceof Error ? e.message : "Failed to create upload URL",
        };
      }
    }),
  );

  return NextResponse.json({ pages: results });
}
