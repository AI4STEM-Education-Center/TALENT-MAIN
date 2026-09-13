import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import MaterialUploadForm from "./material-upload";
import Link from "next/link";
import MaterialsList, { MaterialItem } from "./materials-list";
import MaterialImportDialog from "./material-import-dialog";
import MaterialPoolImportDialog from "./material-pool-import-dialog";
import { listClassMaterials } from "@/lib/learning-material";

export default async function ClassMaterialsPage(props: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") {
    redirect("/login");
  }

  const [{ id: classId }, teacher] = await Promise.all([
    props.params,
    prisma.teacher.findUnique({
      where: { userId: session.user.id },
    }),
  ]);

  if (!teacher) redirect("/login");

  const cls = await prisma.class.findFirst({
    where: { id: classId, teacherId: teacher.id },
  });

  if (!cls) redirect("/teacher/classes");

  const [initialMaterials, materialTags] = await Promise.all([
    listClassMaterials(classId),
    prisma.topic.findMany({
      where: { teacherId: teacher.id, contentType: "MATERIAL" },
      select: { id: true, name: true },
      orderBy: [{ order: "asc" }, { name: "asc" }],
    }),
  ]);

  return (
    <div className="max-w-5xl p-6">
      <div className="flex justify-between items-center mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Learning Materials
          </h1>
          <p className="text-gray-600">
            Upload and manage AI-processed documents for {cls.name}.
          </p>
        </div>
        <div className="flex items-center gap-x-6">
          <MaterialPoolImportDialog classId={classId} />
          <MaterialImportDialog classId={classId} />
          <Link
            href={`/teacher/classes/${classId}`}
            className="text-sm font-medium text-blue-600 hover:text-blue-500"
          >
            Back to Class
          </Link>
        </div>
      </div>

      <div className="mb-10">
        <MaterialUploadForm classId={classId} />
      </div>

      <h2 className="text-xl font-semibold text-gray-800 mb-4">
        Uploaded Documents
      </h2>

      <MaterialsList
        classId={classId}
        initialMaterials={initialMaterials}
        initialTags={materialTags}
      />
    </div>
  );
}
