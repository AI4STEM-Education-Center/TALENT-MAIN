import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getStudentMaterial } from "@/lib/student-content";
import { MaterialReader } from "./material-reader";

export const dynamic = "force-dynamic";

/**
 * One learning material, read by a student. The document itself never renders
 * from props: page images and the original PDF are fetched through
 * /api/student/materials/[materialId]/... which re-checks the same enrollment
 * gate and hands back short-lived signed URLs.
 */
export default async function StudentMaterialPage({
  params,
}: {
  params: Promise<{ materialId: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") redirect("/login");

  const [{ materialId }, student] = await Promise.all([
    params,
    prisma.student.findUnique({ where: { userId: session.user.id } }),
  ]);
  if (!student) redirect("/login");

  const material = await getStudentMaterial(student.id, materialId);
  if (!material) notFound();

  const title = material.title?.trim() || material.originalName;

  return (
    <div className="p-4 md:p-6 space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href="/student/materials">
          <ArrowLeft className="size-4" /> Course Materials
        </Link>
      </Button>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-3xl font-bold">{title}</h1>
          {material.topic && (
            <Badge variant="secondary">{material.topic.name}</Badge>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {material.classes.map((c) => c.name).join(", ")} ·{" "}
          {material.pages.length} page
          {material.pages.length !== 1 ? "s" : ""}
        </p>
      </div>

      <MaterialReader
        materialId={material.id}
        originalName={material.originalName}
        pages={material.pages}
      />
    </div>
  );
}
