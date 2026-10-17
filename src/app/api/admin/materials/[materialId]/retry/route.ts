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

  // Update status back to PROCESSING and clear error
  await prisma.learningMaterial.update({
    where: { id: materialId },
    data: {
      processingStatus: "PROCESSING",
      errorMessage: null,
    },
  });

  // Start background process
  processMaterial(materialId).catch(console.error);

  return NextResponse.json({ status: "retry started" });
}
