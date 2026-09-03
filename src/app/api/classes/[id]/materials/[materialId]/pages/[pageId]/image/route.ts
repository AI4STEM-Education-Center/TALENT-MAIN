import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { signObjectReadUrl, getS3Config } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; materialId: string; pageId: string }> },
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id: classId, materialId, pageId } = await params;

  // Verify access (Teacher or Admin)
  if (session.user.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({
      where: { userId: session.user.id },
    });
    if (!teacher)
      return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

    const cls = await prisma.class.findFirst({
      where: { id: classId, teacherId: teacher.id },
    });
    if (!cls)
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
  } else if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
  });

  if (!material)
    return NextResponse.json({ error: "Material not found" }, { status: 404 });

  const pageRecord = await prisma.materialPage.findUnique({
    where: { id: pageId },
  });

  if (!pageRecord || pageRecord.materialId !== materialId) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }

  try {
    const bucket = getS3Config().bucket;
    const url = await signObjectReadUrl(bucket, pageRecord.storageKey, 3600);
    return NextResponse.json({ url });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to generate URL" },
      { status: 500 },
    );
  }
}
