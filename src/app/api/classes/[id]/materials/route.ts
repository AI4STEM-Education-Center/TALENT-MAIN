import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  buildStorageKey,
  getMaxUploadBytes,
  presignPutUpload,
  getS3Config,
  sanitizeFilename,
} from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ id: classId }, teacher] = await Promise.all([
    params,
    prisma.teacher.findUnique({ where: { userId: session.user.id } }),
  ]);
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const cls = await prisma.class.findFirst({
    where: { id: classId, teacherId: teacher.id },
  });

  if (!cls) {
    return NextResponse.json({ error: "Class not found" }, { status: 404 });
  }

  const links = await prisma.materialClass.findMany({
    where: { classId },
    orderBy: { material: { createdAt: "desc" } },
    select: {
      material: {
        select: {
          id: true,
          classId: true,
          title: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          bucket: true,
          uploadStatus: true,
          processingStatus: true,
          totalPages: true,
          processedPages: true,
          errorMessage: true,
          folder: true,
          createdAt: true,
        },
      },
    },
  });

  const items = links.map((link) => {
    const { classId: originClassId, ...rest } = link.material;
    return { ...rest, isImported: originClassId !== classId };
  });

  return NextResponse.json({ materials: items });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ id: classId }, teacher] = await Promise.all([
    params,
    prisma.teacher.findUnique({ where: { userId: session.user.id } }),
  ]);
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const cls = await prisma.class.findFirst({
    where: { id: classId, teacherId: teacher.id },
  });

  if (!cls) {
    return NextResponse.json({ error: "Class not found" }, { status: 404 });
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

  let body: { title?: string; originalName?: string; sizeBytes?: number; totalPages?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const originalName = typeof body.originalName === "string" ? sanitizeFilename(body.originalName) : "";
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
  
  const totalPages = typeof body.totalPages === "number" ? body.totalPages : 0;

  const mimeType = "application/pdf";

  const title =
    typeof body.title === "string" && body.title.trim().length > 0
      ? body.title.trim().slice(0, 500)
      : null;

  const id = randomUUID();
  const storageKey = buildStorageKey(teacher.id, classId, id, originalName);

  const material = await prisma.learningMaterial.create({
    data: {
      id,
      teacherId: teacher.id,
      classId,
      title,
      originalName,
      mimeType,
      sizeBytes,
      storageKey,
      bucket,
      uploadStatus: "PENDING",
      processingStatus: "IDLE",
      totalPages,
    },
  });

  try {
    const presignedUrl = await presignPutUpload(bucket, storageKey, mimeType, sizeBytes);
    return NextResponse.json({
      id: material.id,
      presignedUrl,
      mimeType: material.mimeType,
      method: "PUT" as const,
    });
  } catch (e) {
    await prisma.learningMaterial.delete({ where: { id: material.id } }).catch(() => {});
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to create upload URL" },
      { status: 500 }
    );
  }
}
