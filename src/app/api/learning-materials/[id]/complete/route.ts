import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { verifyS3UploadComplete } from "@/lib/learning-material";

export const runtime = "nodejs";

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const { id } = await context.params;

  const material = await prisma.learningMaterial.findUnique({ where: { id } });
  if (!material || material.teacherId !== teacher.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (material.uploadStatus !== "PENDING") {
    return NextResponse.json({ error: "Upload already finalized" }, { status: 409 });
  }

  const match = await verifyS3UploadComplete(material.bucket, material.storageKey, material.sizeBytes);
  if (!match) {
    await prisma.learningMaterial.update({
      where: { id: material.id },
      data: { uploadStatus: "FAILED" },
    });
    return NextResponse.json(
      { error: "S3 object missing or size does not match declared size" },
      { status: 400 }
    );
  }

  await prisma.learningMaterial.update({
    where: { id: material.id },
    data: { uploadStatus: "READY" },
  });

  return NextResponse.json({ ok: true });
}
