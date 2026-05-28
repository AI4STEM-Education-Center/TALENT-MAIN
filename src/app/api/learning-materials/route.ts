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

export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const items = await prisma.learningMaterial.findMany({
    where: { teacherId: teacher.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
      bucket: true,
      uploadStatus: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ materials: items });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  let bucket: string;
  try {
    bucket = getS3Config().bucket;
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "S3 not configured" },
      { status: 500 }
    );
  }

  let body: { title?: string; originalName?: string; mimeType?: string; sizeBytes?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const originalName = typeof body.originalName === "string" ? sanitizeFilename(body.originalName) : "";
  if (!originalName) {
    return NextResponse.json({ error: "originalName is required" }, { status: 400 });
  }

  const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : 0;
  const maxBytes = getMaxUploadBytes();
  if (sizeBytes < 1 || sizeBytes > maxBytes) {
    return NextResponse.json(
      { error: `sizeBytes must be between 1 and ${maxBytes}` },
      { status: 400 }
    );
  }

  const mimeType =
    typeof body.mimeType === "string" && body.mimeType.length > 0
      ? body.mimeType.slice(0, 200)
      : "application/octet-stream";

  const title =
    typeof body.title === "string" && body.title.trim().length > 0
      ? body.title.trim().slice(0, 500)
      : null;

  const id = randomUUID();
  const storageKey = buildStorageKey(teacher.id, id, originalName);

  const material = await prisma.learningMaterial.create({
    data: {
      id,
      teacherId: teacher.id,
      title,
      originalName,
      mimeType,
      sizeBytes,
      storageKey,
      bucket,
      uploadStatus: "PENDING",
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
