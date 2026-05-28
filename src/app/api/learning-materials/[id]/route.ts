import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteLearningMaterialById, getLearningMaterialById } from "@/lib/learning-material";
import { deleteS3Object } from "@/lib/storage";

export const runtime = "nodejs";

function describeS3Error(error: unknown): string {
  const maybeName = (error as { name?: string } | null)?.name;
  const maybeMessage = (error as { message?: string } | null)?.message;

  if (maybeName === "AccessDenied") {
    return "S3 denied delete access. Check IAM permissions for s3:DeleteObject on this bucket.";
  }

  if (typeof maybeMessage === "string" && maybeMessage.trim()) {
    return maybeMessage;
  }

  return "Unknown S3 error";
}

export async function DELETE(_req: Request, context: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const { id } = await context.params;

  const material = await getLearningMaterialById(id);
  if (!material || material.teacherId !== teacher.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (material.uploadStatus === "READY") {
    try {
      await deleteS3Object(material.bucket, material.storageKey);
    } catch (error) {
      const maybeStatus = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
      const maybeName = (error as { name?: string } | null)?.name;
      if (maybeStatus !== 404 && maybeName !== "NoSuchKey") {
        console.error("Failed to delete learning material from S3", {
          materialId: material.id,
          bucket: material.bucket,
          storageKey: material.storageKey,
          uploadStatus: material.uploadStatus,
          error,
        });
        return NextResponse.json({ error: describeS3Error(error) }, { status: 500 });
      }
    }
  }

  await deleteLearningMaterialById(material.id);

  return NextResponse.json({ ok: true });
}
