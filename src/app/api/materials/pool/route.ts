import { NextResponse } from "next/server";
import { getContentActor } from "@/lib/quiz-access";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const actor = await getContentActor();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const materials = await prisma.learningMaterial.findMany({
    where: { teacherId: null, uploadStatus: "READY", processingStatus: "SUCCESS" },
    include: { topic: true, _count: { select: { pages: true } } },
    orderBy: [{ topic: { order: "asc" } }, { createdAt: "desc" }],
  });

  let importedIds = new Set<string>();
  if (actor.role === "TEACHER" && materials.length > 0) {
    const copies = await prisma.learningMaterial.findMany({
      where: {
        teacherId: actor.teacherId,
        sourceMaterialId: { in: materials.map((material) => material.id) },
      },
      select: { sourceMaterialId: true },
    });
    importedIds = new Set(copies.flatMap((copy) => copy.sourceMaterialId ? [copy.sourceMaterialId] : []));
  }

  return NextResponse.json({
    materials: materials.map((material) => ({
      ...material,
      topic: material.topic?.contentType === "MATERIAL" ? material.topic : null,
      alreadyImported: importedIds.has(material.id),
    })),
  });
}
