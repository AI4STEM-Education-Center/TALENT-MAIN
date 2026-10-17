import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/admin-access";
import { prisma } from "@/lib/prisma";
import { processMaterial } from "@/lib/vlm-engine";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ materialId: string }> },
) {
  const session = await requireAdminApi();
  if (session instanceof Response) return session;

  const { materialId } = await params;

  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
  });

  if (!material) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }

  // Reset all page-level VLM data
  await prisma.materialPage.updateMany({
    where: { materialId },
    data: {
      needed: null,
      keyConcept: null,
      description: null,
    },
  });

  // Reset material-level processing state
  await prisma.learningMaterial.update({
    where: { id: materialId },
    data: {
      processingStatus: "PROCESSING",
      processedPages: 0,
      errorMessage: null,
      batchDescription: null,
      batchKeyConcepts: "[]",
    },
  });

  // Start background process
  processMaterial(materialId).catch(console.error);

  return NextResponse.json({ status: "regeneration started" });
}
