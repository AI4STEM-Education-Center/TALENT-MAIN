"use client";

// Upload (or replace) a class syllabus. Same pipeline as learning materials:
// the browser slices the PDF into page images with PDFium, both the PDF and the
// pages go straight to S3 on presigned PUTs, and the completion call hands the
// pages to the worker for extraction.

import { useState } from "react";
import { Loader2, UploadCloud } from "lucide-react";
import { rasterizePdfToImageBlobs } from "@/lib/pdf-rasterize-client";
import { MAX_SYLLABUS_PAGES } from "@/lib/syllabus";
import { errorMessage } from "@/lib/errors";

/** Concurrent S3 PUTs; higher values saturate school networks. */
const PAGE_UPLOAD_BATCH_SIZE = 5;

type PresignedPage = {
  pageNumber: number;
  presignedUrl: string;
  storageKey: string;
  mimeType: string;
};

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

export function SyllabusUpload({
  classId,
  replacing,
  onUploaded,
}: {
  classId: string;
  /** A syllabus already exists; this upload is a new version of it. */
  replacing: boolean;
  onUploaded: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    if (file.type !== "application/pdf") {
      setError("Please choose a PDF file.");
      return;
    }
    setBusy(true);
    setError(null);
    setProgress(0);
    try {
      // Slice first: a document over the page limit fails here, before a
      // revision is opened or a byte is uploaded.
      setStatus("Reading pages…");
      const pages = await rasterizePdfToImageBlobs(file, MAX_SYLLABUS_PAGES);
      setProgress(20);

      setStatus("Uploading PDF…");
      const base = `/api/classes/${classId}/syllabus`;
      const init = await postJson<{
        revision: number;
        presignedUrl: string;
        mimeType: string;
      }>(base, { originalName: file.name, sizeBytes: file.size });
      const pdfRes = await fetch(init.presignedUrl, {
        method: "PUT",
        headers: { "Content-Type": init.mimeType, "If-None-Match": "*" },
        body: file,
      });
      if (!pdfRes.ok) throw new Error("Failed to upload the PDF to storage.");
      setProgress(30);

      setStatus("Uploading pages…");
      const { pages: urls } = await postJson<{ pages: PresignedPage[] }>(
        `${base}/pages`,
        {
          revision: init.revision,
          pages: pages.map((page) => ({
            pageNumber: page.pageNumber,
            sizeBytes: page.sizeBytes,
            contentType: page.mimeType,
          })),
        },
      );
      const blobs = new Map(pages.map((page) => [page.pageNumber, page.blob]));
      let done = 0;
      for (let i = 0; i < urls.length; i += PAGE_UPLOAD_BATCH_SIZE) {
        await Promise.all(
          urls.slice(i, i + PAGE_UPLOAD_BATCH_SIZE).map(async (page) => {
            const res = await fetch(page.presignedUrl, {
              method: "PUT",
              headers: { "Content-Type": page.mimeType, "If-None-Match": "*" },
              body: blobs.get(page.pageNumber),
            });
            if (!res.ok)
              throw new Error(`Failed to upload page ${page.pageNumber}.`);
            done += 1;
            setProgress(30 + (done / urls.length) * 60);
          }),
        );
      }

      setStatus("Starting extraction…");
      await postJson(`${base}/complete`, {
        revision: init.revision,
        pages: urls.map(({ pageNumber, storageKey }) => ({
          pageNumber,
          storageKey,
        })),
      });
      setProgress(100);
      onUploaded();
    } catch (err: unknown) {
      setError(errorMessage(err) || "The upload failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative rounded-lg border-2 border-dashed border-muted-foreground/30 bg-muted/30 p-8 text-center transition-colors hover:bg-muted/50">
      <input
        type="file"
        accept="application/pdf"
        aria-label={
          replacing ? "Upload a new syllabus version" : "Upload syllabus PDF"
        }
        className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        disabled={busy}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void upload(file);
        }}
      />
      <div className="flex flex-col items-center gap-3">
        {busy ? (
          <>
            <Loader2 className="size-8 animate-spin text-primary" />
            <p className="text-sm font-medium">{status}</p>
            <div className="h-2 w-full max-w-xs rounded-full bg-muted">
              <div
                className="h-2 rounded-full bg-primary transition-[width] duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
          </>
        ) : (
          <>
            <UploadCloud className="size-8 text-muted-foreground" />
            <div>
              <p className="font-semibold">
                {replacing
                  ? "Upload a new version of the syllabus"
                  : "Click or drag your syllabus PDF here"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                Up to {MAX_SYLLABUS_PAGES} pages. Course details, policies and
                every date are extracted automatically
                {replacing
                  ? " and replace the current version once extraction finishes."
                  : "."}
              </p>
            </div>
          </>
        )}
      </div>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </div>
  );
}
