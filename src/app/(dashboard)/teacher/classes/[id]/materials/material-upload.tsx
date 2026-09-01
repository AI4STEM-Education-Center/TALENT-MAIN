"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { UploadCloud, Loader2 } from "lucide-react";
import { rasterizePdfToImageBlobs } from "@/lib/pdf-rasterize-client";

interface MaterialUploadProps {
  classId: string;
}

export default function MaterialUploadForm({ classId }: MaterialUploadProps) {
  const { refresh } = useRouter();
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (file.type !== "application/pdf") {
        setError("Please upload a valid PDF file.");
        return;
      }

      setIsUploading(true);
      setError(null);
      setProgress(0);

      try {
        setStatusText("Initializing upload...");

        // 1. Initialize upload (creates LearningMaterial in PENDING state)
        const initRes = await fetch(`/api/classes/${classId}/materials`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: file.name.replace(/\.pdf$/i, ""),
            originalName: file.name,
            sizeBytes: file.size,
          }),
        });

        if (!initRes.ok) {
          throw new Error((await initRes.json()).error || "Failed to initialize upload");
        }

        const { id: materialId, presignedUrl, mimeType } = await initRes.json();

        setStatusText("Uploading original PDF...");
        // 2. Upload original PDF
        const uploadRes = await fetch(presignedUrl, {
          method: "PUT",
          headers: { "Content-Type": mimeType, "If-None-Match": "*" },
          body: file,
        });

        if (!uploadRes.ok) throw new Error("Failed to upload PDF to storage");

        setStatusText("Processing pages locally...");
        // 3. Rasterize PDF pages in the browser via PDFium (WASM). Max 100 pages.
        // Each page comes back WebP-encoded where the browser supports it — see
        // src/lib/page-image-format.ts — carrying the MIME type it actually used.
        const pageBlobs = await rasterizePdfToImageBlobs(file, 100);
        const numPages = pageBlobs.length;
        setProgress(30); // First 30% is rendering

        setStatusText("Requesting upload URLs for pages...");
        // 4. Get presigned URLs for all pages
        const pagesRes = await fetch(`/api/classes/${classId}/materials/${materialId}/pages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pages: pageBlobs.map((p) => ({
              pageNumber: p.pageNumber,
              sizeBytes: p.sizeBytes,
              contentType: p.mimeType,
            })),
          }),
        });

        if (!pagesRes.ok) {
          throw new Error((await pagesRes.json()).error || "Failed to get page upload URLs");
        }

        const { pages: pageUrls } = await pagesRes.json();

        setStatusText("Uploading page images...");
        // 5. Upload all pages directly to S3
        let uploadedCount = 0;

        // Index page blobs by page number for O(1) lookup during upload
        const blobsByPageNumber = new Map(pageBlobs.map((p) => [p.pageNumber, p]));

        // Upload in batches of 5 to avoid overwhelming network
        for (let i = 0; i < pageUrls.length; i += 5) {
          const batch = pageUrls.slice(i, i + 5);
          await Promise.all(
            batch.map(async (pageData: any) => {
              if (pageData.error) throw new Error(`Server error for page ${pageData.pageNumber}: ${pageData.error}`);

              const blobData = blobsByPageNumber.get(pageData.pageNumber);
              if (!blobData) throw new Error(`Missing blob for page ${pageData.pageNumber}`);

              const res = await fetch(pageData.presignedUrl, {
                method: "PUT",
                headers: { "Content-Type": pageData.mimeType, "If-None-Match": "*" },
                body: blobData.blob,
              });

              if (!res.ok) throw new Error(`Failed to upload page ${pageData.pageNumber}`);

              uploadedCount++;
              setProgress(30 + (uploadedCount / numPages) * 60); // 30% to 90% is uploading
            })
          );
        }

        // The completion endpoint needs the pages in page order. Take them from
        // the server's own presign response, which is already ordered, rather
        // than from the order the concurrent PUTs above happened to finish in —
        // collecting them as each upload resolved shuffled the list and made
        // every multi-batch document fail finalization.
        const uploadedPagesForComplete = pageUrls
          .map((pageData: any) => ({
            pageNumber: pageData.pageNumber,
            storageKey: pageData.storageKey,
          }))
          .sort((a: { pageNumber: number }, b: { pageNumber: number }) => a.pageNumber - b.pageNumber);

        setStatusText("Finalizing upload...");
        // 6. Complete upload and trigger VLM
        const completeRes = await fetch(`/api/classes/${classId}/materials/${materialId}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pages: uploadedPagesForComplete }),
        });

        if (!completeRes.ok) {
          // Surface what the server actually objected to; the old generic
          // message left the teacher (and the console) with no way to tell an
          // ordering bug from an over-budget document.
          const reason = await completeRes
            .json()
            .then((data) => data?.error)
            .catch(() => null);
          throw new Error(reason || "Failed to finalize material");
        }

        setProgress(100);
        setStatusText("Done!");
        
        // Let user see 100% for a moment before refreshing list
        setTimeout(() => {
          setIsUploading(false);
          refresh();
        }, 1000);

      } catch (err: any) {
        console.error(err);
        setError(err.message || "An unexpected error occurred");
        setIsUploading(false);
      }
    },
    [classId, refresh]
  );

  return (
    <div className="border-2 border-dashed border-gray-300 rounded-lg p-12 text-center bg-gray-50 hover:bg-gray-100 transition-colors relative">
      <input
        type="file"
        accept="application/pdf"
        aria-label="Upload PDF material"
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-not-allowed"
        onChange={handleFileChange}
        disabled={isUploading}
      />
      <div className="flex flex-col items-center gap-y-4">
        {isUploading ? (
          <>
            <Loader2 className="size-10 text-blue-500 animate-spin" />
            <div className="text-sm font-medium text-gray-700">{statusText}</div>
            <div className="w-full max-w-xs bg-gray-200 rounded-full h-2.5">
              <div
                className="bg-blue-600 h-2.5 rounded-full transition-[width] duration-300"
                style={{ width: `${progress}%` }}
              ></div>
            </div>
          </>
        ) : (
          <>
            <UploadCloud className="size-10 text-gray-400" />
            <div>
              <p className="text-base font-semibold text-gray-700">
                Click or drag PDF to upload
              </p>
              <p className="text-sm text-gray-500 mt-1">
                Max 100 pages. Material will be automatically analyzed by AI.
              </p>
            </div>
          </>
        )}
      </div>
      {error && <p className="text-red-500 text-sm mt-4">{error}</p>}
    </div>
  );
}
