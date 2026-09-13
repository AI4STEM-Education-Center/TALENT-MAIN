import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { FolderOpen } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { listStudentMaterials } from "@/lib/student-content";
import { MaterialsBrowser } from "./materials-browser";

export const dynamic = "force-dynamic";

/**
 * The student's course-material library: every document a teacher shared with
 * any class they are enrolled in, across all of those classes. Scoping lives in
 * listStudentMaterials — see src/lib/student-content.ts.
 */
export default async function StudentMaterialsPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "STUDENT") redirect("/login");

  const student = await prisma.student.findUnique({
    where: { userId: session.user.id },
  });
  if (!student) redirect("/login");

  const materials = await listStudentMaterials(student.id);

  return (
    <div className="p-4 md:p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Course Materials</h1>
        <p className="text-muted-foreground mt-1">
          {materials.length === 0
            ? "Everything your teachers share with your classes shows up here."
            : `${materials.length} document${materials.length !== 1 ? "s" : ""} from your classes.`}
        </p>
      </div>

      {materials.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <FolderOpen className="size-12 text-muted-foreground mb-4" />
            <p className="text-lg font-medium mb-2">No materials yet</p>
            <p className="text-muted-foreground text-sm">
              Your teachers haven&apos;t shared any course material with your
              classes yet.
            </p>
          </CardContent>
        </Card>
      ) : (
        <MaterialsBrowser materials={materials} />
      )}
    </div>
  );
}
