import { prisma } from "@/lib/prisma";

/** True when the material is linked to the given class via the MaterialClass junction. */
export async function materialLinkedToClass(materialId: string, classId: string): Promise<boolean> {
  const link = await prisma.materialClass.findUnique({
    where: { materialId_classId: { materialId, classId } },
  });
  return link !== null;
}

/**
 * Return the teacher-facing material list for a class.
 *
 * The server-rendered page and its polling endpoint deliberately share this
 * query so a completed material has the same persisted AI metrics both before
 * and after a navigation or refresh.
 */
export async function listClassMaterials(classId: string) {
  const links = await prisma.materialClass.findMany({
    where: { classId },
    orderBy: { material: { createdAt: "desc" } },
    select: {
      material: {
        select: {
          id: true,
          classId: true,
          title: true,
          originalName: true,
          mimeType: true,
          sizeBytes: true,
          bucket: true,
          uploadStatus: true,
          processingStatus: true,
          totalPages: true,
          processedPages: true,
          errorMessage: true,
          folder: true,
          createdAt: true,
          aiModel: true,
          aiTtftMs: true,
          aiTokens: true,
          aiTotalMs: true,
        },
      },
    },
  });

  return links.map((link) => {
    const { classId: originClassId, createdAt, ...material } = link.material;
    return {
      ...material,
      createdAt: createdAt.toISOString(),
      isImported: originClassId !== classId,
    };
  });
}
