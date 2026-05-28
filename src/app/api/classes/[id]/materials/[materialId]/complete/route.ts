import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { headS3Object, getS3Config } from "@/lib/storage";

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

  if (!material || material.classId !== classId || material.teacherId !== teacher.id) {
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

  let bucket: string;
  try {
    bucket = getS3Config().bucket;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "S3 not configured" },
      { status: 500 }
    );
  }

  try {
    await headS3Object(bucket, material.storageKey);
  } catch {
    return NextResponse.json({ error: "Original PDF not found in storage" }, { status: 404 });
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
