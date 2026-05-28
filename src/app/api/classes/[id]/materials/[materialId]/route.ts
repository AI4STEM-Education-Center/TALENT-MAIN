import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteS3Objects, listS3Objects, getS3Config } from "@/lib/storage";
import { cancelMaterial } from "@/lib/vlm-engine";

export const runtime = "nodejs";

export async function PATCH(
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
    include: { class: true },
  });

  if (!material || material.classId !== classId || material.class.teacherId !== teacher.id) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }

  let body: { batchDescription?: unknown; title?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: { batchDescription?: string | null; title?: string | null } = {};

  if ("batchDescription" in body) {
    if (typeof body.batchDescription !== "string") {
      return NextResponse.json({ error: "batchDescription must be a string" }, { status: 400 });
    }
    const trimmed = body.batchDescription.trim();
    data.batchDescription = trimmed.length > 0 ? trimmed : null;
  }

  if ("title" in body) {
    if (typeof body.title !== "string") {
      return NextResponse.json({ error: "title must be a string" }, { status: 400 });
    }
    const trimmed = body.title.trim();
    if (trimmed.length > 255) {
      return NextResponse.json({ error: "title must be 255 characters or fewer" }, { status: 400 });
    }
    data.title = trimmed.length > 0 ? trimmed : null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No valid fields provided" }, { status: 400 });
  }

  const updated = await prisma.learningMaterial.update({
    where: { id: materialId },
    data,
    select: {
      batchDescription: true,
      batchKeyConcepts: true,
      title: true,
      originalName: true,
    },
  });

  return NextResponse.json({ material: updated });
}

export async function DELETE(
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
    include: { class: true },
  });

  if (!material || material.classId !== classId || material.class.teacherId !== teacher.id) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }

  let bucket: string | undefined;

  // Signal any in-flight processing to stop before we remove the data
  cancelMaterial(materialId);
  try {
    bucket = getS3Config().bucket;
  } catch (e) {
    console.warn("S3 not configured, skipping storage cleanup");
  }

  // Cleanup S3 storage if configured
  if (bucket) {
    try {
      // The prefix for this material is usually learning-materials/{teacherId}/{classId}/{materialId}/
      const prefix = `learning-materials/${teacher.id}/${classId}/${materialId}/`;
      const keys = await listS3Objects(bucket, prefix);
      if (keys.length > 0) {
        await deleteS3Objects(bucket, keys);
      }
    } catch (e) {
      console.error("Failed to delete S3 objects:", e);
      // Continue anyway to delete the database records
    }
  }

  // DB cascading should delete pages due to materialId foreign key if configured,
  // but to be safe we can delete pages first or let Prisma handle it if cascade is on.
  await prisma.materialPage.deleteMany({
    where: { materialId },
  });

  await prisma.learningMaterial.delete({
    where: { id: materialId },
  });

  return NextResponse.json({ success: true });
}
