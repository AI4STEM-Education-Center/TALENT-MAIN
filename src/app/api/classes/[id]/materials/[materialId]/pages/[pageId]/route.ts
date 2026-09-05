import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { materialLinkedToClass } from "@/lib/learning-material";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ id: string; materialId: string; pageId: string }> },
) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ id: classId, materialId, pageId }, teacher] = await Promise.all([
    params,
    prisma.teacher.findUnique({ where: { userId: session.user.id } }),
  ]);

  if (!teacher) {
    return NextResponse.json({ error: "Teacher not found" }, { status: 404 });
  }

  const cls = await prisma.class.findFirst({
    where: { id: classId, teacherId: teacher.id },
  });
  if (!cls) {
    return NextResponse.json({ error: "Class not found" }, { status: 404 });
  }

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

  const page = await prisma.materialPage.findUnique({
    where: { id: pageId },
  });
  if (!page || page.materialId !== materialId) {
    return NextResponse.json({ error: "Page not found" }, { status: 404 });
  }

  let body: { needed?: unknown; keyConcept?: unknown; description?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: {
    needed?: boolean;
    keyConcept?: string | null;
    description?: string | null;
  } = {};

  if ("needed" in body) {
    if (typeof body.needed !== "boolean") {
      return NextResponse.json(
        { error: "needed must be a boolean" },
        { status: 400 },
      );
    }
    data.needed = body.needed;
  }

  if ("keyConcept" in body) {
    if (typeof body.keyConcept !== "string") {
      return NextResponse.json(
        { error: "keyConcept must be a string" },
        { status: 400 },
      );
    }
    const trimmed = body.keyConcept.trim();
    data.keyConcept = trimmed.length > 0 ? trimmed : null;
  }

  if ("description" in body) {
    if (typeof body.description !== "string") {
      return NextResponse.json(
        { error: "description must be a string" },
        { status: 400 },
      );
    }
    const trimmed = body.description.trim();
    data.description = trimmed.length > 0 ? trimmed : null;
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "No valid fields provided" },
      { status: 400 },
    );
  }

  const updated = await prisma.materialPage.update({
    where: { id: pageId },
    data,
    select: {
      id: true,
      pageNumber: true,
      needed: true,
      keyConcept: true,
      description: true,
    },
  });

  return NextResponse.json({ page: updated });
}
