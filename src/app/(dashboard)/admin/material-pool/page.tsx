import { redirect } from "next/navigation";
import { getContentActor } from "@/lib/quiz-access";
import { MaterialPoolClient } from "./material-pool-client";
import { prisma } from "@/lib/prisma";

export default async function AdminMaterialPoolPage() {
  const actor = await getContentActor();
  if (!actor || actor.role !== "ADMIN") redirect("/login");
  const materials = await prisma.learningMaterial.findMany({
    where: { teacherId: null, uploadStatus: "READY", processingStatus: "SUCCESS" },
    select: {
      id: true,
      title: true,
      originalName: true,
      totalPages: true,
      topic: { select: { id: true, name: true } },
    },
    orderBy: [{ topic: { order: "asc" } }, { createdAt: "desc" }],
  });
  return <MaterialPoolClient initialMaterials={materials} />;
}
