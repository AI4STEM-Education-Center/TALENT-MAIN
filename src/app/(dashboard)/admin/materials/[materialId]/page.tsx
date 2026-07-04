"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, ExternalLink, FileText, Loader2 } from "lucide-react";

interface MaterialPage {
  pageNumber: number;
  keyConcept: string | null;
  description: string | null;
  url: string | null;
}

interface MaterialDetail {
  id: string;
  title: string | null;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  processingStatus: string;
  totalPages: number;
  processedPages: number;
  errorMessage: string | null;
  createdAt: string;
  teacher: { user: { username: string; firstName: string | null; lastName: string | null } } | null;
  class: { name: string } | null;
  fileUrl: string | null;
  pages: MaterialPage[];
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

// Admin material viewer: the read-only counterpart to the teacher's material
// page. Page images come as short-lived presigned URLs from the admin detail
// endpoint, so this works even for materials whose class is gone.
export default function AdminMaterialDetailPage() {
  const { materialId } = useParams<{ materialId: string }>();
  const [material, setMaterial] = useState<MaterialDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/admin/materials/${materialId}`);
        if (!res.ok) throw new Error((await res.json()).error || "Failed to load material");
        const data: MaterialDetail = await res.json();
        if (!cancelled) setMaterial(data);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load material");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [materialId]);

  const teacherUser = material?.teacher?.user;
  const teacherName = teacherUser
    ? `${teacherUser.firstName ?? ""} ${teacherUser.lastName ?? ""}`.trim() || teacherUser.username
    : "Unknown teacher";

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-5xl mx-auto">
      <Link
        href="/admin/materials"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to materials
      </Link>

      {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      {!material && !error && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading material…
        </div>
      )}

      {material && (
        <>
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <FileText className="size-6 text-muted-foreground" /> {material.title || material.originalName}
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {teacherName}
              {material.class ? ` · ${material.class.name}` : " · no class"} · {formatBytes(material.sizeBytes)} ·{" "}
              {material.processedPages}/{material.totalPages || "?"} pages processed · {material.processingStatus}
            </p>
            {material.errorMessage && (
              <p className="text-sm text-destructive mt-1">{material.errorMessage}</p>
            )}
            {material.fileUrl && (
              <a
                href={material.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline mt-2"
              >
                <ExternalLink className="size-4" /> Open original file ({material.originalName})
              </a>
            )}
          </div>

          {material.pages.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No page images — the material has not been processed yet.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {material.pages.map((page) => (
                <Card key={page.pageNumber}>
                  <CardHeader>
                    <CardTitle className="text-base">
                      Page {page.pageNumber}
                      {page.keyConcept && (
                        <span className="ml-2 font-normal text-sm text-muted-foreground">{page.keyConcept}</span>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {page.url ? (
                      // Plain <img>: short-lived presigned S3 URL, next/image can't optimize it.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={page.url}
                        alt={`Page ${page.pageNumber}`}
                        className="w-full max-w-3xl rounded border bg-white"
                      />
                    ) : (
                      <p className="text-sm text-muted-foreground">Page image unavailable.</p>
                    )}
                    {page.description && <p className="text-sm text-muted-foreground">{page.description}</p>}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
