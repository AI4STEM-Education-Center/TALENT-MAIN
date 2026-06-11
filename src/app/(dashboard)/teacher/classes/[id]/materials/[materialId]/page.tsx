import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { ArrowLeft, AlertCircle } from "lucide-react";
import MaterialAnalysisEditor from "./material-analysis-editor";
import { materialLinkedToClass } from "@/lib/learning-material";

export default async function MaterialViewerPage(props: { params: Promise<{ id: string; materialId: string }> }) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    redirect("/login");
  }

  const [{ id: classId, materialId }, teacher] = await Promise.all([
    props.params,
    prisma.teacher.findUnique({
      where: { userId: session.user.id },
    }),
  ]);

  if (!teacher) redirect("/login");

  const material = await prisma.learningMaterial.findUnique({
    where: { id: materialId },
    include: {
      pages: {
        orderBy: { pageNumber: "asc" },
      },
    },
  });

  if (
    !material ||
    material.teacherId !== teacher.id ||
    !(await materialLinkedToClass(materialId, classId))
  ) {
    redirect(`/teacher/classes/${classId}/materials`);
  }

  return (
    <div className="max-w-6xl p-6 space-y-8">
      <div className="flex items-center gap-x-4">
        <Link
          href={`/teacher/classes/${classId}/materials`}
          className="p-2 bg-gray-100 hover:bg-gray-200 rounded-full transition-colors"
        >
          <ArrowLeft className="size-5 text-gray-700" />
        </Link>
        <div>
          <h1 className="text-3xl font-bold text-gray-900">{material.title || material.originalName}</h1>
          <p className="text-sm text-gray-500 mt-1">
            {material.totalPages} Pages • Processed on {new Date(material.updatedAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      {material.processingStatus === "FAILED" && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 flex items-start gap-x-4">
          <AlertCircle className="size-6 text-red-600 shrink-0 mt-0.5" />
          <div>
            <h2 className="text-lg font-semibold text-red-800">Processing Failed</h2>
            <p className="text-red-700 mt-1">{material.errorMessage}</p>
          </div>
        </div>
      )}

      <MaterialAnalysisEditor
        classId={classId}
        materialId={materialId}
        processingStatus={material.processingStatus}
        batchDescription={material.batchDescription}
        batchKeyConcepts={material.batchKeyConcepts}
        pages={material.pages.map((page) => ({
          id: page.id,
          pageNumber: page.pageNumber,
          keyConcept: page.keyConcept,
          description: page.description,
          needed: page.needed,
        }))}
      />
    </div>
  );
}
