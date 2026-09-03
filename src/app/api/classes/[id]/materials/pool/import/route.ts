import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { deepCopyLearningMaterial } from "@/lib/material-pool";
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

  let body: { materialIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ids = Array.isArray(body.materialIds)
    ? Array.from(
        new Set(
          body.materialIds.filter((id): id is string => typeof id === "string"),
        ),
      )
    : [];
  if (ids.length === 0)
    return NextResponse.json(
      { error: "materialIds is required" },
      { status: 400 },
    );

  const poolMaterials = await prisma.learningMaterial.findMany({
    where: {
      id: { in: ids },
      teacherId: null,
      uploadStatus: "READY",
      processingStatus: "SUCCESS",
    },
    select: { id: true },
  });
  if (poolMaterials.length !== ids.length) {
    return NextResponse.json(
      { error: "One or more pool materials were not found." },
      { status: 404 },
    );
  }

  const imported = (
    await Promise.all(
      poolMaterials.map((material) =>
        deepCopyLearningMaterial(material.id, {
          teacherId: teacher.id,
          classId,
        }),
      ),
    )
  ).filter((material) => material !== null);
  return NextResponse.json({ imported }, { status: 201 });
}
