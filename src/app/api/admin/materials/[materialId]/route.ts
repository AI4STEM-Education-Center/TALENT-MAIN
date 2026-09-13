import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  deleteS3Object,
  deleteS3Objects,
  getS3Config,
  listS3Objects,
  materialPrefixFromStorageKey,
  signObjectReadUrl,
} from "@/lib/storage";

export const runtime = "nodejs";

// GET: material detail for the admin viewer — metadata plus presigned URLs for
// the original file and every rasterized page. Presigning here (rather than
// routing admins through the class-scoped page-image endpoint) keeps the admin
// view working for materials whose class link is gone (classId is SetNull).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { materialId } = await params;
  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    include: {
      pages: { orderBy: { pageNumber: "asc" } },
      teacher: { select: { user: { select: { username: true, firstName: true, lastName: true } } } },
      class: { select: { name: true } },
    },
  });
  if (!material) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }

  const [fileUrl, pages] = await Promise.all([
    signObjectReadUrl(material.bucket, material.storageKey).catch(() => null),
    Promise.all(
      material.pages.map(async (page) => ({
        pageNumber: page.pageNumber,
        keyConcept: page.keyConcept,
        description: page.description,
        url: await signObjectReadUrl(material.bucket, page.storageKey).catch(() => null),
      }))
    ),
  ]);

  return NextResponse.json({
    id: material.id,
    title: material.title,
    originalName: material.originalName,
    mimeType: material.mimeType,
    sizeBytes: material.sizeBytes,
    processingStatus: material.processingStatus,
    totalPages: material.totalPages,
    processedPages: material.processedPages,
    errorMessage: material.errorMessage,
    createdAt: material.createdAt,
    teacher: material.teacher,
    class: material.class,
    fileUrl,
    pages,
  });
}

// Assign a material-only global tag to an existing pool material.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { materialId } = await params;
  let body: { topicId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!("topicId" in body) || (body.topicId !== null && typeof body.topicId !== "string")) {
    return NextResponse.json({ error: "topicId must be a string or null" }, { status: 400 });
  }

  const topicId = typeof body.topicId === "string" && body.topicId ? body.topicId : null;
  const [material, topic] = await Promise.all([
    prisma.learningMaterial.findFirst({ where: { id: materialId, teacherId: null } }),
    topicId
      ? prisma.topic.findFirst({ where: { id: topicId, teacherId: null, contentType: "MATERIAL" } })
      : null,
  ]);
  if (!material) return NextResponse.json({ error: "Pool material not found" }, { status: 404 });
  if (topicId && !topic) return NextResponse.json({ error: "Material tag not found" }, { status: 400 });

  const updated = await prisma.learningMaterial.update({
    where: { id: materialId },
    data: { topicId },
    select: { id: true, topic: { select: { id: true, name: true } } },
  });
  return NextResponse.json({ material: updated });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ materialId: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { materialId } = await params;

  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    include: { pages: true },
  });

  if (!material) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
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
    // 1. Delete original PDF
    await deleteS3Object(bucket, material.storageKey).catch(console.error);

    // 2. Delete all page images from S3 based on DB records
    const pageKeys = material.pages.map((p) => p.storageKey);
    if (pageKeys.length > 0) {
      await deleteS3Objects(bucket, pageKeys).catch(console.error);
    }
    
    // Fallback: list the material prefix and delete in case DB missed some
    const prefix = materialPrefixFromStorageKey(material.storageKey);
    const remainingKeys = await listS3Objects(bucket, prefix);
    if (remainingKeys.length > 0) {
      await deleteS3Objects(bucket, remainingKeys).catch(console.error);
    }

    // 3. Delete from DB
    await prisma.learningMaterial.delete({
      where: { id: materialId },
    });

    return new Response(null, { status: 204 });
  } catch (e) {
    console.error("Failed to delete material:", e);
    return NextResponse.json(
      { error: "Failed to delete material and associated files" },
      { status: 500 }
    );
  }
}
