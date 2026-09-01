import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  headS3Object,
  getS3Config,
  getMaxUploadBytes,
  maxDerivedPageBytes,
  materialPrefixFromStorageKey,
  buildPageStorageKey,
} from "@/lib/storage";
import { materialLinkedToClass } from "@/lib/learning-material";
import { rateLimit } from "@/lib/rate-limit";
import { PAGE_IMAGE_EXTENSION_VALUES } from "@/lib/page-image-format";

export const runtime = "nodejs";

const MAX_MATERIAL_PAGES = 100;
class MaterialAlreadyCompletedError extends Error {}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; materialId: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ id: classId, materialId }, teacher] = await Promise.all([
    params,
    prisma.teacher.findUnique({ where: { userId: session.user.id } }),
  ]);
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

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

  if (material.uploadStatus !== "PENDING") {
    return NextResponse.json({ error: "Material is not in PENDING state" }, { status: 400 });
  }

  let body: { pages?: Array<{ pageNumber: number; storageKey: string }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!Array.isArray(body.pages) || body.pages.length === 0) {
    return NextResponse.json({ error: "pages array is required" }, { status: 400 });
  }
  const limited = rateLimit(req, "material-complete", 10, 60_000, session.user.id);
  if (limited) return limited;
  if (body.pages.length > MAX_MATERIAL_PAGES) {
    return NextResponse.json(
      { error: `A material may have at most ${MAX_MATERIAL_PAGES} pages.` },
      { status: 400 }
    );
  }

  // SECURITY: page storageKeys arrive from the client and are later handed
  // straight to presignGetUrl by the page-image route, so an unchecked key
  // would let a teacher attach ANY object in the bucket to their own material
  // and read it back — other teachers' materials and page renders, quiz
  // extraction PDFs, simulation artifacts, and (because deployments share one
  // bucket behind S3_KEY_PREFIX) the other environment's objects too. Pin every
  // key under this material's own pages/ prefix, derived from the server-built
  // storageKey rather than from anything the caller sent. Same guard the quiz
  // extraction commit route applies to figure keys.
  const pagesPrefix = `${materialPrefixFromStorageKey(material.storageKey)}pages/`;
  const storageClassId = material.classId ?? classId;

  // Ordered by pageNumber, not by the order the client happened to post. The
  // uploader fires pages in concurrent batches and appends each one as its PUT
  // resolves, so the array arrives shuffled whenever two pages in a batch finish
  // out of order — which is what made a long PDF fail here with "Pages must be
  // contiguous from 1". Sorting costs nothing and the identity of each page is
  // still pinned by the exact-key check below, not by its position.
  const posted = [...body.pages].sort(
    (a, b) => (Number(a?.pageNumber) || 0) - (Number(b?.pageNumber) || 0)
  );

  const pages: Array<{ pageNumber: number; storageKey: string }> = [];
  for (let i = 0; i < posted.length; i++) {
    const page = posted[i];
    const expectedPageNumber = i + 1;
    // One candidate per supported image format: the page format is negotiated
    // at presign time and the completion request does not carry it, so the key
    // is matched against the deterministic key for each allowed extension.
    const expectedKeys = PAGE_IMAGE_EXTENSION_VALUES.map((extension) =>
      buildPageStorageKey(teacher.id, storageClassId, material.id, expectedPageNumber, extension)
    );
    if (
      !page ||
      typeof page !== "object" ||
      page.pageNumber !== expectedPageNumber ||
      typeof page.storageKey !== "string" ||
      !page.storageKey.startsWith(pagesPrefix) ||
      !expectedKeys.includes(page.storageKey)
    ) {
      return NextResponse.json(
        { error: "Pages must be contiguous from 1 and use their exact upload keys." },
        { status: 400 }
      );
    }
    pages.push({ pageNumber: expectedPageNumber, storageKey: page.storageKey });
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

  // The presigned PUT can't bound the upload (S3 signs the key and content type,
  // not the length), so the sizeBytes checked when the URL was issued is only a
  // declaration. Verify what actually landed and refuse to finalize an object
  // over the cap — otherwise the limit is advisory and a teacher can park
  // arbitrarily large objects in the bucket. The orphaned object is left to the
  // S3 garbage collector (src/lib/s3-gc.ts), which sweeps unreferenced keys.
  let uploaded: { contentLength: number };
  let uploadedPages: Array<{ contentLength: number }>;
  try {
    [uploaded, uploadedPages] = await Promise.all([
      headS3Object(bucket, material.storageKey),
      Promise.all(pages.map((page) => headS3Object(bucket, page.storageKey))),
    ]);
  } catch {
    return NextResponse.json({ error: "Upload is incomplete in storage" }, { status: 404 });
  }

  const maxBytes = getMaxUploadBytes();
  if (uploaded.contentLength > maxBytes) {
    // Stays PENDING (the one non-READY state the materials UI renders) so the
    // teacher can re-upload; the reason goes in errorMessage.
    await prisma.learningMaterial.update({
      where: { id: material.id },
      data: {
        errorMessage: `Uploaded file is ${uploaded.contentLength} bytes, over the ${maxBytes}-byte limit.`,
      },
    });
    return NextResponse.json(
      { error: `Uploaded file exceeds the ${maxBytes}-byte limit.` },
      { status: 413 }
    );
  }

  const oversizedPage = uploadedPages.findIndex(
    (page) => page.contentLength < 1 || page.contentLength > maxBytes
  );
  const totalPageBytes = uploadedPages.reduce(
    (total, page) => total + page.contentLength,
    0
  );
  // Scales with page count — see maxDerivedPageBytes. The /pages endpoint has
  // already rejected an over-budget document from its declared sizes; this is
  // the authoritative check against what actually landed in the bucket.
  if (
    oversizedPage !== -1 ||
    totalPageBytes > maxDerivedPageBytes(uploadedPages.length)
  ) {
    return NextResponse.json(
      {
        error:
          oversizedPage !== -1
            ? `Page ${oversizedPage + 1} exceeds the ${maxBytes}-byte limit.`
            : "Rendered pages exceed the aggregate upload limit.",
      },
      { status: 413 }
    );
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const claimed = await tx.learningMaterial.updateMany({
        where: { id: material.id, uploadStatus: "PENDING" },
        data: {
          uploadStatus: "READY",
          processingStatus: "PROCESSING",
          totalPages: pages.length,
          sizeBytes: uploaded.contentLength,
          errorMessage: null,
        },
      });
      if (claimed.count !== 1) throw new MaterialAlreadyCompletedError();

      for (const page of pages) {
        await tx.materialPage.upsert({
          where: {
            materialId_pageNumber: {
              materialId: material.id,
              pageNumber: page.pageNumber,
            },
          },
          create: {
            materialId: material.id,
            pageNumber: page.pageNumber,
            storageKey: page.storageKey,
          },
          update: { storageKey: page.storageKey },
        });
      }

      return tx.learningMaterial.findUniqueOrThrow({ where: { id: material.id } });
    });
    
    // In a real app we'd trigger a background job here (e.g. SQS, Inngest, BullMQ).
    // For this prototype, we'll invoke the background process directly to avoid network hairpin routing issues
    // that cause local fetch requests to hang indefinitely.
    import('@/lib/vlm-engine').then(({ processMaterial }) => {
      processMaterial(material.id).catch(console.error);
    });
    return NextResponse.json({ material: updated });
  } catch (e) {
    if (e instanceof MaterialAlreadyCompletedError) {
      return NextResponse.json(
        { error: "Material upload has already been finalized." },
        { status: 409 }
      );
    }
    console.error("Failed to complete upload:", e);
    return NextResponse.json(
      { error: "Failed to finalize material records" },
      { status: 500 }
    );
  }
}
