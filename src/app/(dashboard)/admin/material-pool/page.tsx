import { requireAdminDataPage } from "@/lib/admin-access";
import { isAdmin } from "@/lib/roles";
import { MaterialPoolClient } from "./material-pool-client";
import { prisma } from "@/lib/prisma";

export default async function AdminMaterialPoolPage() {
  // Research scientists browse the pool read-only.
  const session = await requireAdminDataPage();
  const [materials, tags] = await Promise.all([
    prisma.learningMaterial.findMany({
      where: {
        teacherId: null,
        uploadStatus: "READY",
        processingStatus: "SUCCESS",
      },
      select: {
        id: true,
        title: true,
        originalName: true,
        totalPages: true,
        topic: { select: { id: true, name: true, contentType: true } },
      },
      orderBy: [{ topic: { order: "asc" } }, { createdAt: "desc" }],
    }),
    prisma.topic.findMany({
      where: { teacherId: null, contentType: "MATERIAL" },
      select: { id: true, name: true },
      orderBy: [{ order: "asc" }, { name: "asc" }],
    }),
  ]);
  const materialItems = materials.map((material) => ({
    ...material,
    topic:
      material.topic?.contentType === "MATERIAL"
        ? { id: material.topic.id, name: material.topic.name }
        : null,
  }));
  return (
    <MaterialPoolClient
      initialMaterials={materialItems}
      initialTags={tags}
      canEdit={isAdmin(session.user.role)}
    />
  );
}
