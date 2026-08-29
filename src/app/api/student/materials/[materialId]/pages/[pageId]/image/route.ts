import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { signObjectReadUrl } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * GET /api/student/materials/[materialId]/pages/[pageId]/image
 * Short-lived signed URL for one rasterized page of a learning material.
 *
 * The student counterpart of the class-scoped teacher endpoint: same gate as
 * ./file (material shared with a class the student is enrolled in), plus the
 * page must belong to that material so a valid page id from another document
 * cannot be read through an accessible material's URL.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ materialId: string; pageId: string }> }
) {
  const [session, { materialId, pageId }] = await Promise.all([auth(), params]);
  if (!session?.user || session.user.role !== "STUDENT") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const student = await prisma.student.findUnique({ where: { userId: session.user.id } });
  if (!student) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const material = await prisma.learningMaterial.findFirst({
    where: {
      id: materialId,
      uploadStatus: "READY",
      classLinks: { some: { class: { enrollments: { some: { studentId: student.id } } } } },
    },
    select: { bucket: true },
  });
  if (!material) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const page = await prisma.materialPage.findFirst({
    where: { id: pageId, materialId },
    select: { storageKey: true },
  });
  if (!page) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const url = await signObjectReadUrl(material.bucket, page.storageKey, 3600);
    return NextResponse.json({ url });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate URL" },
      { status: 500 }
    );
  }
}
