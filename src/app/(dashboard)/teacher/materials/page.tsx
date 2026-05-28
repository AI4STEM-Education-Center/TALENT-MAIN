import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { MaterialUploadForm } from "./material-upload";
import { MaterialDeleteButton } from "./material-delete-button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { FileText } from "lucide-react";
import { getMaxUploadBytes } from "@/lib/storage";

function formatSize(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default async function TeacherMaterialsPage() {
  const session = await auth();
  if (!session?.user || session.user.role !== "TEACHER") redirect("/login");

  const maxUploadBytes = getMaxUploadBytes();

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.user.id } });
  if (!teacher) redirect("/login");

  const materials = await prisma.learningMaterial.findMany({
    where: { teacherId: teacher.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
      bucket: true,
      uploadStatus: true,
      createdAt: true,
    },
  });

  return (
    <div className="p-6 space-y-8 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold">Learning materials</h1>
        <p className="text-muted-foreground mt-1">
          Upload PDFs, documents, or other files for your own use and for LLM pipelines. Each file has a
          database record with the S3 bucket and object key.
        </p>
      </div>

      <MaterialUploadForm maxUploadBytes={maxUploadBytes} />

      <div>
        <h2 className="text-xl font-semibold mb-4">Your uploads</h2>
        {materials.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              No materials yet. Upload a file above.
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {materials.map((m) => (
              <Card key={m.id}>
                <CardHeader className="py-3 px-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-start gap-3 min-w-0">
                      <FileText className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <CardTitle className="text-base font-medium truncate">
                          {m.title ?? m.originalName}
                        </CardTitle>
                        {m.title && (
                          <p className="text-sm text-muted-foreground truncate">{m.originalName}</p>
                        )}
                        <p className="text-xs text-muted-foreground mt-1 font-mono break-all">
                          id: {m.id}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <div className="flex flex-col items-end gap-1">
                        <Badge
                          variant={m.uploadStatus === "READY" ? "default" : "secondary"}
                          className="capitalize"
                        >
                          {m.uploadStatus.toLowerCase()}
                        </Badge>
                        <span className="text-xs text-muted-foreground text-right max-w-[12rem] truncate" title={m.bucket}>
                          {m.bucket} · {formatSize(m.sizeBytes)}
                        </span>
                      </div>
                      <MaterialDeleteButton id={m.id} label={m.title ?? m.originalName} />
                    </div>
                  </div>
                </CardHeader>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
