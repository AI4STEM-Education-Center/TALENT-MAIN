import { prisma } from "@/lib/prisma";

/** True when the material is linked to the given class via the MaterialClass junction. */
export async function materialLinkedToClass(materialId: string, classId: string): Promise<boolean> {
  const link = await prisma.materialClass.findUnique({
    where: { materialId_classId: { materialId, classId } },
  });
  return link !== null;
}
