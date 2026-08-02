"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, FileUp, Loader2, MinusCircle, Pencil, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { rasterizePdfToPngBlobs } from "@/lib/pdf-rasterize-client";

const MAX_PAGES = 20;
const POLL_MS = 2500;

type InitResponse = {
  id: string;
  pdf: { presignedUrl: string; storageKey: string };
  pages: { pageNumber: number; presignedUrl: string; storageKey: string }[];
};

type ItemStatus = "queued" | "creating" | "uploading" | "extracting" | "ready" | "skipped" | "failed";

type BatchItem = {
  key: string;
  fileName: string;
  quizName: string;
  status: ItemStatus;
  note?: string; // skip reason, upload progress, or error detail
  quizId?: string; // set once the quiz exists (links to the editor)
};

export type CreatedPoolQuiz = {
  id: string;
  name: string;
  topicId: string | null;
  topic: { id: string; name: string } | null;
  _count: { questions: number };
};

/** Quiz name derived from the PDF file name: extension stripped, trimmed. */
function quizNameFromFile(fileName: string): string {
  return fileName.replace(/\.pdf$/i, "").trim() || fileName;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

async function putBlob(url: string, contentType: string, body: Blob): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType, "If-None-Match": "*" },
    body,
  });
  if (!res.ok) throw new Error("Upload to storage failed");
}

/**
 * Admin batch importer: pick a topic, select many quiz PDFs at once. Each PDF
 * becomes a pool quiz named after its file, then runs the existing per-quiz
 * pdf-extraction pipeline (presign → upload → worker extraction). Files whose
 * name matches an existing quiz under the topic (or an earlier file in the same
 * selection) are skipped. Extraction ends at AWAITING_REVIEW — questions are
 * committed from each quiz's editor, same as a single-file import.
 *
 * Uploads run sequentially (browser-side rasterization is memory-heavy);
 * extractions run server-side in parallel and are polled per item.
 */
export function PdfBatchUpload({
  topics,
  existingQuizzes,
  onQuizCreated,
  onQuizRemoved,
}: {
  topics: { id: string; name: string }[];
  existingQuizzes: { id: string; name: string; topicId: string | null }[];
  onQuizCreated: (quiz: CreatedPoolQuiz) => void;
  onQuizRemoved: (quizId: string) => void;
}) {
  const [topicId, setTopicId] = useState("");
  const [items, setItems] = useState<BatchItem[]>([]);
  const [running, setRunning] = useState(false);

  const mounted = useRef(true);
  const pollTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    mounted.current = true;
    const timers = pollTimers.current;
    return () => {
      mounted.current = false;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const updateItem = useCallback((key: string, patch: Partial<BatchItem>) => {
    if (!mounted.current) return;
    setItems((prev) => prev.map((it) => (it.key === key ? { ...it, ...patch } : it)));
  }, []);

  // Poll one extraction until it leaves EXTRACTING. Ready/failed both keep the
  // quiz link — the quiz editor auto-resumes the extraction for review or retry.
  const pollExtraction = useCallback(
    (key: string, quizId: string, extractionId: string) => {
      const tick = async () => {
        try {
          const res = await fetch(`/api/quizzes/${quizId}/pdf-extractions/${extractionId}`);
          if (!res.ok) throw new Error("Failed to load extraction status");
          const data: { status: string; errorMessage: string | null; questions?: unknown[] } = await res.json();
          if (!mounted.current) return;
          if (data.status === "AWAITING_REVIEW") {
            const count = data.questions?.length ?? 0;
            updateItem(key, { status: "ready", note: `${count} question${count === 1 ? "" : "s"} extracted — review and commit.` });
          } else if (data.status === "FAILED") {
            updateItem(key, { status: "failed", note: data.errorMessage || "Extraction failed. Open the quiz to retry." });
          } else if (data.status === "COMMITTED") {
            updateItem(key, { status: "ready", note: "Questions committed." });
          } else {
            pollTimers.current.set(key, setTimeout(tick, POLL_MS));
          }
        } catch (err) {
          if (!mounted.current) return;
          updateItem(key, {
            status: "failed",
            note: err instanceof Error ? `${err.message} Open the quiz to check on it.` : "Open the quiz to check on it.",
          });
        }
      };
      tick();
    },
    [updateItem]
  );

  // Create the quiz (server-side name dedupe), upload the PDF + page rasters,
  // then hand off to extraction polling. A failure before extraction is
  // enqueued rolls the shell quiz back so re-running the batch isn't blocked
  // by the dedupe check.
  async function processFile(key: string, quizName: string, targetTopicId: string, file: File) {
    updateItem(key, { status: "creating", note: undefined });
    let quizId: string | null = null;
    let extractionId: string | null = null;
    try {
      const createRes = await fetch("/api/quizzes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: quizName, topicId: targetTopicId, dedupeByName: true }),
      });
      const created = await createRes.json();
      if (createRes.status === 409 && created.duplicate) {
        updateItem(key, { status: "skipped", note: "A quiz with this name already exists under the topic." });
        return;
      }
      if (!createRes.ok) throw new Error(created.error || "Failed to create quiz");
      quizId = created.id as string;
      onQuizCreated(created as CreatedPoolQuiz);
      updateItem(key, { quizId: created.id, status: "uploading", note: "Rendering pages…" });

      const pageBlobs = await rasterizePdfToPngBlobs(file, MAX_PAGES);

      updateItem(key, { note: "Requesting upload URLs…" });
      const initRes = await fetch(`/api/quizzes/${quizId}/pdf-extractions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          originalName: file.name,
          sizeBytes: file.size,
          pages: pageBlobs.map((p) => ({ pageNumber: p.pageNumber, sizeBytes: p.sizeBytes })),
        }),
      });
      if (!initRes.ok) throw new Error((await initRes.json()).error || "Failed to start extraction");
      const init: InitResponse = await initRes.json();
      extractionId = init.id;

      updateItem(key, { note: "Uploading PDF…" });
      await putBlob(init.pdf.presignedUrl, "application/pdf", file);

      const byPage = new Map(pageBlobs.map((p) => [p.pageNumber, p]));
      for (const page of init.pages) {
        updateItem(key, { note: `Uploading page ${page.pageNumber}/${init.pages.length}…` });
        const blob = byPage.get(page.pageNumber);
        if (!blob) throw new Error(`Missing rendered page ${page.pageNumber}`);
        await putBlob(page.presignedUrl, "image/png", blob.blob);
      }

      updateItem(key, { note: "Finalizing…" });
      const completeRes = await fetch(`/api/quizzes/${quizId}/pdf-extractions/${init.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: init.pages.map((p) => ({ pageNumber: p.pageNumber, storageKey: p.storageKey })) }),
      });
      if (!completeRes.ok) throw new Error((await completeRes.json()).error || "Failed to finalize upload");

      updateItem(key, { status: "extracting", note: undefined });
      pollExtraction(key, quizId, init.id);
    } catch (err) {
      if (quizId) {
        // Discard the extraction first — its DELETE route also cleans up the
        // S3 objects, which a bare quiz delete (DB cascade) would orphan.
        if (extractionId) {
          await fetch(`/api/quizzes/${quizId}/pdf-extractions/${extractionId}`, { method: "DELETE" }).catch(() => null);
        }
        const del = await fetch(`/api/quizzes/${quizId}`, { method: "DELETE" }).catch(() => null);
        if (del?.ok) {
          onQuizRemoved(quizId);
          quizId = null;
        }
      }
      updateItem(key, {
        status: "failed",
        quizId: quizId ?? undefined,
        note: err instanceof Error ? err.message : "Upload failed",
      });
    }
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // allow re-selecting the same files later
    if (files.length === 0 || !topicId || running) return;
    const targetTopicId = topicId;

    // Pre-flight dedupe for instant feedback: against pool quizzes already under
    // this topic, and against earlier files in the same selection. The create
    // call re-checks server-side, so a stale client list can't create dupes.
    const existingNames = new Set(
      existingQuizzes.filter((q) => q.topicId === targetTopicId).map((q) => normalizeName(q.name))
    );
    const inBatch = new Set<string>();
    const batchId = Date.now();
    const prepared = files.map((file, i) => {
      const item: BatchItem = {
        key: `${batchId}:${i}:${file.name}`,
        fileName: file.name,
        quizName: quizNameFromFile(file.name),
        status: "queued",
      };
      const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
      const norm = normalizeName(item.quizName);
      if (!isPdf) {
        item.status = "failed";
        item.note = "Not a PDF file.";
      } else if (existingNames.has(norm)) {
        item.status = "skipped";
        item.note = "A quiz with this name already exists under the topic.";
      } else if (inBatch.has(norm)) {
        item.status = "skipped";
        item.note = "Duplicate file name in this selection.";
      } else {
        inBatch.add(norm);
      }
      return { item, file };
    });

    setItems(prepared.map((p) => p.item));
    setRunning(true);
    try {
      for (const { item, file } of prepared) {
        if (!mounted.current) return;
        if (item.status !== "queued") continue;
        await processFile(item.key, item.quizName, targetTopicId, file);
      }
    } finally {
      if (mounted.current) setRunning(false);
    }
  }

  const pickerEnabled = Boolean(topicId) && !running;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FileUp className="size-5" /> Upload PDF Quizzes</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Pick a topic, then select one or more quiz PDFs (max {MAX_PAGES} pages each). Each PDF becomes a pool quiz
          named after its file; files matching an existing quiz under the topic are skipped. Extracted questions wait
          in each quiz for your review before they are committed.
        </p>
        <div className="flex flex-col sm:flex-row gap-3">
          <select
            className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm sm:w-56"
            value={topicId}
            onChange={(e) => setTopicId(e.target.value)}
            disabled={running}
            aria-label="Topic for uploaded quizzes"
          >
            <option value="">Select a topic…</option>
            {topics.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <div className="relative inline-block">
            {pickerEnabled && (
              <input
                type="file"
                multiple
                accept=".pdf,application/pdf"
                aria-label="Upload quiz PDFs"
                className="absolute inset-0 size-full cursor-pointer opacity-0"
                onChange={handleFiles}
              />
            )}
            <Button asChild className={pickerEnabled ? "" : "pointer-events-none opacity-50"}>
              <span>
                {running ? <Loader2 className="size-4 animate-spin" /> : <FileUp className="size-4" />}
                {running ? "Uploading…" : "Choose PDFs"}
              </span>
            </Button>
          </div>
        </div>

        {items.length > 0 && (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.key} className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {(item.status === "creating" || item.status === "uploading" || item.status === "extracting") && (
                      <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                    )}
                    {item.status === "ready" && <CheckCircle2 className="size-4 shrink-0 text-green-600" />}
                    {item.status === "skipped" && <MinusCircle className="size-4 shrink-0 text-muted-foreground" />}
                    {item.status === "failed" && <XCircle className="size-4 shrink-0 text-destructive" />}
                    <span className="truncate">{item.quizName}</span>
                  </p>
                  <p className={`mt-0.5 text-xs ${item.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
                    {item.status === "queued" && "Waiting…"}
                    {item.status === "creating" && "Creating quiz…"}
                    {item.status === "uploading" && (item.note ?? "Uploading…")}
                    {item.status === "extracting" && "Extracting questions…"}
                    {(item.status === "ready" || item.status === "skipped" || item.status === "failed") && (item.note ?? "")}
                  </p>
                </div>
                {item.quizId && (item.status === "ready" || item.status === "failed") && (
                  <Button size="sm" variant="outline" className="shrink-0" asChild>
                    <Link href={`/admin/quizzes/${item.quizId}`}>
                      <Pencil className="size-3" /> {item.status === "ready" ? "Review" : "Open"}
                    </Link>
                  </Button>
                )}
              </div>
            ))}
            {!running && (
              <p className="text-xs text-muted-foreground">
                {items.filter((i) => i.status === "ready").length} ready for review
                {" · "}{items.filter((i) => i.status === "skipped").length} skipped
                {" · "}{items.filter((i) => i.status === "failed").length} failed
                {items.some((i) => i.status === "extracting") &&
                  ` · ${items.filter((i) => i.status === "extracting").length} still extracting`}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
