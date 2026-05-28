"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import * as pdfjsLib from "pdfjs-dist";
import { UploadCloud, Loader2 } from "lucide-react";

// Configure PDF.js worker
if (typeof window !== "undefined") {
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
}

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
          headers: { "Content-Type": mimeType },
          body: file,
        });

        if (!uploadRes.ok) throw new Error("Failed to upload PDF to storage");

        setStatusText("Processing pages locally...");
        // 3. Slice PDF in browser
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
        const numPages = pdf.numPages;

        if (numPages > 100) {
          throw new Error(`PDF exceeds maximum limit of 100 pages (has ${numPages}).`);
        }

        // Render pages to blobs
        const pageBlobs: { pageNumber: number; blob: Blob; sizeBytes: number }[] = [];
        for (let i = 1; i <= numPages; i++) {
          setStatusText(`Rendering page ${i} of ${numPages}...`);
          setProgress((i / numPages) * 30); // First 30% is rendering

          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: 2.0 }); // Good quality for VLM
          const canvas = document.createElement("canvas");
          const ctx = canvas.getContext("2d");
          
          if (!ctx) throw new Error("Could not create canvas context");
          
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          
          await page.render({ canvasContext: ctx, viewport }).promise;
          
          const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, "image/png")
          );
          
          if (!blob) throw new Error(`Failed to create blob for page ${i}`);
          
          pageBlobs.push({ pageNumber: i, blob, sizeBytes: blob.size });
        }

        setStatusText("Requesting upload URLs for pages...");
        // 4. Get presigned URLs for all pages
        const pagesRes = await fetch(`/api/classes/${classId}/materials/${materialId}/pages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pages: pageBlobs.map((p) => ({ pageNumber: p.pageNumber, sizeBytes: p.sizeBytes })),
          }),
        });

        if (!pagesRes.ok) {
          throw new Error((await pagesRes.json()).error || "Failed to get page upload URLs");
        }

        const { pages: pageUrls } = await pagesRes.json();

        setStatusText("Uploading page images...");
        // 5. Upload all pages directly to S3
        let uploadedCount = 0;
        const uploadedPagesForComplete: { pageNumber: number; storageKey: string }[] = [];

        // Upload in batches of 5 to avoid overwhelming network
        for (let i = 0; i < pageUrls.length; i += 5) {
          const batch = pageUrls.slice(i, i + 5);
          await Promise.all(
            batch.map(async (pageData: any) => {
              if (pageData.error) throw new Error(`Server error for page ${pageData.pageNumber}: ${pageData.error}`);
              
              const blobData = pageBlobs.find((p) => p.pageNumber === pageData.pageNumber);
              if (!blobData) throw new Error(`Missing blob for page ${pageData.pageNumber}`);

              const res = await fetch(pageData.presignedUrl, {
                method: "PUT",
                headers: { "Content-Type": pageData.mimeType },
                body: blobData.blob,
              });

              if (!res.ok) throw new Error(`Failed to upload page ${pageData.pageNumber}`);
              
              uploadedPagesForComplete.push({
                pageNumber: pageData.pageNumber,
                storageKey: pageData.storageKey,
              });
              
              uploadedCount++;
              setProgress(30 + (uploadedCount / numPages) * 60); // 30% to 90% is uploading
            })
          );
        }

        setStatusText("Finalizing upload...");
        // 6. Complete upload and trigger VLM
        const completeRes = await fetch(`/api/classes/${classId}/materials/${materialId}/complete`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pages: uploadedPagesForComplete }),
        });

        if (!completeRes.ok) throw new Error("Failed to finalize material");

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
                className="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
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
