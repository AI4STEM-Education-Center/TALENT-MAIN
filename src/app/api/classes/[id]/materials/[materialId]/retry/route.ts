import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { processMaterial } from "@/lib/vlm-engine";
import { materialLinkedToClass } from "@/lib/learning-material";
import { rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; materialId: string }> }
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const limited = rateLimit(req, "material-retry", 5, 60_000, session.user.id);
  if (limited) return limited;

  const [{ id: classId, materialId }, teacher] = await Promise.all([
    params,
    prisma.teacher.findUnique({ where: { userId: session.user.id } }),
  ]);
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
  });

  if (
    !material ||
    material.teacherId !== teacher.id ||
    !(await materialLinkedToClass(materialId, classId))
  ) {
    return NextResponse.json({ error: "Material not found" }, { status: 404 });
  }

  if (material.processingStatus !== "FAILED") {
    return NextResponse.json({ error: "Only failed materials can be retried" }, { status: 400 });
  }

  // Update status back to PROCESSING and clear error
  const claimed = await prisma.learningMaterial.updateMany({
    where: { id: materialId, processingStatus: "FAILED" },
    data: {
      processingStatus: "PROCESSING",
      errorMessage: null,
    },
  });
  if (claimed.count !== 1) {
    return NextResponse.json({ error: "Material is already being retried" }, { status: 409 });
  }

  // Start background process
  processMaterial(materialId).catch(console.error);

  return NextResponse.json({ status: "retry started" });
}
