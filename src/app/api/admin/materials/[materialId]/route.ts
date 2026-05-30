import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteS3Object, deleteS3Objects, getS3Config, listS3Objects, materialPrefixFromStorageKey } from "@/lib/storage";

export const runtime = "nodejs";

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
