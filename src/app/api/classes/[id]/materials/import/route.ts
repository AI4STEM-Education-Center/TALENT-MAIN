import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ id: classId }, teacher] = await Promise.all([
    params,
    prisma.teacher.findUnique({ where: { userId: session.user.id } }),
  ]);
  if (!teacher)
    return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const cls = await prisma.class.findFirst({
    where: { id: classId, teacherId: teacher.id },
  });
  if (!cls)
    return NextResponse.json({ error: "Class not found" }, { status: 404 });

  let body: { materialId?: unknown; materialIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids: string[] = [];
  if (typeof body.materialId === "string") ids.push(body.materialId);
  if (Array.isArray(body.materialIds)) {
    for (const id of body.materialIds) {
      if (typeof id === "string") ids.push(id);
    }
  }
  const uniqueIds = Array.from(new Set(ids));

  if (uniqueIds.length === 0) {
    return NextResponse.json(
      { error: "materialId or materialIds is required" },
      { status: 400 },
    );
  }

  // Only the teacher's own, finished materials can be imported.
  const materials = await prisma.learningMaterial.findMany({
    where: {
      id: { in: uniqueIds },
      teacherId: teacher.id,
      uploadStatus: "READY",
    },
    select: { id: true },
  });

  let linked = 0;
  for (const material of materials) {
    await prisma.materialClass.upsert({
      where: { materialId_classId: { materialId: material.id, classId } },
      create: { materialId: material.id, classId },
      update: {},
    });
    linked++;
  }

  return NextResponse.json({ linked });
}
