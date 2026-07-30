import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  headS3Object,
  getS3Config,
  getMaxUploadBytes,
  materialPrefixFromStorageKey,
} from "@/lib/storage";
import { materialLinkedToClass } from "@/lib/learning-material";

export const runtime = "nodejs";

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
  const badKey = body.pages.find(
    (p) => typeof p?.storageKey !== "string" || !p.storageKey.startsWith(pagesPrefix)
  );
  if (badKey) {
    return NextResponse.json(
      { error: "Each page storageKey must belong to this material." },
      { status: 400 }
    );
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
  try {
    uploaded = await headS3Object(bucket, material.storageKey);
  } catch {
    return NextResponse.json({ error: "Original PDF not found in storage" }, { status: 404 });
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

  try {
    await prisma.$transaction(
      body.pages.map((p) =>
        prisma.materialPage.upsert({
          where: {
            materialId_pageNumber: {
              materialId: material.id,
              pageNumber: p.pageNumber,
            },
          },
          create: {
            materialId: material.id,
            pageNumber: p.pageNumber,
            storageKey: p.storageKey,
          },
          update: {
            storageKey: p.storageKey,
          },
        })
      )
    );

    const updated = await prisma.learningMaterial.update({
      where: { id: material.id },
      data: {
        uploadStatus: "READY",
        processingStatus: "PROCESSING",
        totalPages: body.pages.length,
      },
    });
    
    // In a real app we'd trigger a background job here (e.g. SQS, Inngest, BullMQ).
    // For this prototype, we'll invoke the background process directly to avoid network hairpin routing issues
    // that cause local fetch requests to hang indefinitely.
    import('@/lib/vlm-engine').then(({ processMaterial }) => {
      processMaterial(material.id).catch(console.error);
    });
    return NextResponse.json({ material: updated });
  } catch (e) {
    console.error("Failed to complete upload:", e);
    return NextResponse.json(
      { error: "Failed to finalize material records" },
      { status: 500 }
    );
  }
}
