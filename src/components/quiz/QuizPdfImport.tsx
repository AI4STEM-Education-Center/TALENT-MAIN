"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileUp, Loader2, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { rasterizePdfToPngBlobs } from "@/lib/pdf-rasterize-client";
import type { FigureBbox, StagedQuestion } from "@/lib/quiz-extraction";
import { isQuestionComplete, QuizPdfReview, type PageImage } from "./QuizPdfReview";
import { formatAiMetrics } from "@/lib/ai-metrics";

const MAX_PAGES = 20;
const POLL_MS = 2500;
// A PENDING_UPLOAD younger than this may be another tab actively uploading —
// don't offer a Discard that would kill it mid-flight.
const PENDING_UPLOAD_STALL_MS = 15 * 60 * 1000;

type ExtractionStatus = "PENDING_UPLOAD" | "EXTRACTING" | "AWAITING_REVIEW" | "COMMITTED" | "FAILED";

type ListItem = {
  id: string;
  status: ExtractionStatus;
  originalName: string;
  totalPages: number;
  errorMessage: string | null;
  createdAt: string;
};

type ExtractionDetail = ListItem & {
  hasAnswerKey: boolean;
  warnings: string[];
  questions?: StagedQuestion[];
  pageImages?: PageImage[];
  // AI generation metrics for the extraction run (teacher-facing).
  aiModel?: string | null;
  aiTtftMs?: number | null;
  aiTokens?: number | null;
  aiTotalMs?: number | null;
};

type InitResponse = {
  id: string;
  pdf: { presignedUrl: string; storageKey: string };
  pages: { pageNumber: number; presignedUrl: string; storageKey: string }[];
};

type FiguresResponse = {
  questionFigures: { questionIndex: number; presignedUrl: string; storageKey: string }[];
  optionImages: { questionIndex: number; optionIndex: number; presignedUrl: string; storageKey: string }[];
};

type ImportSummary = {
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  errors?: { index: number; sourceQuestionId?: string; message: string }[];
};

type Phase = "idle" | "uploading" | "extracting" | "review" | "failed" | "committing";

async function putBlob(url: string, contentType: string, body: Blob): Promise<void> {
  const res = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body });
  if (!res.ok) throw new Error("Upload to storage failed");
}

/**
 * Draw the normalized crop of an already-loaded page image into a canvas and
 * return a PNG blob. Uses crossOrigin="anonymous" so the canvas is not tainted.
 * NOTE: S3 CORS must allow GET from this origin (mirroring the PUT CORS the
 * uploads already require) or the canvas taints and toBlob throws SecurityError.
 */
async function cropToPngBlob(pageUrl: string, bbox: FigureBbox): Promise<Blob> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Could not load source page image for cropping"));
    img.src = pageUrl;
  });

  const sx = Math.round(bbox.x * img.naturalWidth);
  const sy = Math.round(bbox.y * img.naturalHeight);
  const sw = Math.max(1, Math.round(bbox.w * img.naturalWidth));
  const sh = Math.max(1, Math.round(bbox.h * img.naturalHeight));

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not create canvas context");
  // toBlob throws on a tainted canvas — surfaced as the CORS error below.
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  return new Promise<Blob>((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Failed to encode figure crop"));
      }, "image/png");
    } catch {
      reject(new Error("S3 CORS GET required: the page image could not be read into a canvas for cropping."));
    }
  });
}

/**
 * Teacher-facing PDF quiz import flow. State machine:
 *   idle → uploading → extracting → review → committing → (committed → idle)
 *   extracting → failed → (retry → extracting) | (discard → idle)
 * On mount it lists prior extractions and auto-resumes the newest non-committed
 * one. Everything is plain fetch + useState in the repo house style.
 */
export function QuizPdfImport({
  quizId,
  onCommitted,
  onActiveChange,
}: {
  quizId: string;
  onCommitted: () => void;
  onActiveChange?: (active: boolean) => void;
}) {
  const confirm = useConfirm();
  const base = `/api/quizzes/${quizId}/pdf-extractions`;

  const [phase, setPhase] = useState<Phase>("idle");
  const [extractionId, setExtractionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExtractionDetail | null>(null);
  const [questions, setQuestions] = useState<StagedQuestion[]>([]);
  const [statusText, setStatusText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  // Fetch one status snapshot; advance the phase. Reschedules itself while EXTRACTING.
  const poll = useCallback(
    async (eid: string) => {
      try {
        const res = await fetch(`${base}/${eid}`);
        if (!res.ok) throw new Error("Failed to load extraction status");
        const data: ExtractionDetail = await res.json();
        if (!mounted.current) return;

        setDetail(data);
        if (data.status === "EXTRACTING") {
          setPhase("extracting");
          pollTimer.current = setTimeout(() => poll(eid), POLL_MS);
        } else if (data.status === "AWAITING_REVIEW") {
          setQuestions(data.questions ?? []);
          setPhase("review");
        } else if (data.status === "FAILED") {
          setPhase("failed");
        } else if (data.status === "PENDING_UPLOAD") {
          // Only reachable via mount-resume. If the upload stalled long ago
          // (tab closed mid-upload), surface it like a failure so the teacher
          // gets a Discard button instead of a dead end. A FRESH one may be
          // another tab still uploading — leave this flow idle and untouched
          // (the worker's GC discards it after a day if truly abandoned).
          const age = Date.now() - new Date(data.createdAt).getTime();
          if (age > PENDING_UPLOAD_STALL_MS) setPhase("failed");
        } else if (data.status === "COMMITTED") {
          setPhase("idle");
          setExtractionId(null);
        }
      } catch (e) {
        if (!mounted.current) return;
        setError(e instanceof Error ? e.message : "Failed to load extraction status");
      }
    },
    [base]
  );

  // On mount: resume the newest non-committed extraction, if any.
  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const res = await fetch(base);
        if (!res.ok) return;
        const { extractions }: { extractions: ListItem[] } = await res.json();
        const resumable = extractions.find((e) => e.status !== "COMMITTED");
        if (resumable && mounted.current) {
          setExtractionId(resumable.id);
          poll(resumable.id);
        }
      } catch {
        // No resume is non-fatal; the teacher can start a fresh upload.
      }
    })();
    return () => {
      mounted.current = false;
      stopPolling();
    };
  }, [base, poll, stopPolling]);

  // Let the parent reclaim space (e.g. hide the QTI import card) while a PDF
  // import is in progress — any phase past idle means the teacher is mid-flow.
  useEffect(() => {
    onActiveChange?.(phase !== "idle");
  }, [phase, onActiveChange]);

  const resetFlow = useCallback(() => {
    stopPolling();
    setPhase("idle");
    setExtractionId(null);
    setDetail(null);
    setQuestions([]);
    setStatusText("");
    setError(null);
    setSummary(null);
  }, [stopPolling]);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setError("Please choose a PDF file.");
      return;
    }

    setError(null);
    setSummary(null);
    setPhase("uploading");
    try {
      setStatusText("Rendering pages…");
      const pageBlobs = await rasterizePdfToPngBlobs(file, MAX_PAGES);

      setStatusText("Requesting upload URLs…");
      const initRes = await fetch(base, {
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

      setStatusText("Uploading PDF…");
      await putBlob(init.pdf.presignedUrl, "application/pdf", file);

      const byPage = new Map(pageBlobs.map((p) => [p.pageNumber, p]));
      for (const page of init.pages) {
        setStatusText(`Uploading page ${page.pageNumber}/${init.pages.length}…`);
        const blob = byPage.get(page.pageNumber);
        if (!blob) throw new Error(`Missing rendered page ${page.pageNumber}`);
        await putBlob(page.presignedUrl, "image/png", blob.blob);
      }

      setStatusText("Finalizing…");
      const completeRes = await fetch(`${base}/${init.id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pages: init.pages.map((p) => ({ pageNumber: p.pageNumber, storageKey: p.storageKey })) }),
      });
      if (!completeRes.ok) throw new Error((await completeRes.json()).error || "Failed to finalize upload");

      if (!mounted.current) return;
      setExtractionId(init.id);
      setPhase("extracting");
      poll(init.id);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : "Upload failed");
      setPhase("idle");
    }
  }

  async function retry() {
    if (!extractionId) return;
    setError(null);
    const res = await fetch(`${base}/${extractionId}/retry`, { method: "POST" });
    if (!res.ok) {
      setError((await res.json()).error || "Retry failed");
      return;
    }
    setPhase("extracting");
    poll(extractionId);
  }

  async function discard() {
    if (!extractionId) return;
    const ok = await confirm({
      title: "Discard this extraction?",
      description: "The uploaded PDF and any review progress will be deleted.",
      confirmText: "Discard",
      variant: "destructive",
    });
    if (!ok) return;
    stopPolling();
    const res = await fetch(`${base}/${extractionId}`, { method: "DELETE" });
    if (!res.ok && res.status !== 404) {
      setError((await res.json()).error || "Discard failed");
      return;
    }
    resetFlow();
  }

  // Upload every remaining crop (question figures + image answer-choices),
  // returning questions with figureStorageKey / option.imageStorageKey set.
  async function uploadFigureCrops(): Promise<StagedQuestion[]> {
    const pageImages = detail?.pageImages ?? [];
    const pageUrlByNumber = new Map(pageImages.map((p) => [p.pageNumber, p.url]));

    const pendingFigures = questions.flatMap((q, index) =>
      q.hasFigure && !q.figureStorageKey && q.figureBbox ? [{ q, index }] : []
    );

    const pendingOptions: { questionIndex: number; optionIndex: number }[] = [];
    questions.forEach((q, questionIndex) => {
      q.options.forEach((o, optionIndex) => {
        if (o.isImage === true && !o.imageStorageKey && o.imageBbox) {
          pendingOptions.push({ questionIndex, optionIndex });
        }
      });
    });

    if (pendingFigures.length === 0 && pendingOptions.length === 0) return questions;

    const figRes = await fetch(`${base}/${extractionId}/figures`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        questionFigures: pendingFigures.map((p) => p.index),
        optionImages: pendingOptions,
      }),
    });
    if (!figRes.ok) throw new Error((await figRes.json()).error || "Failed to get figure upload URLs");
    const { questionFigures, optionImages }: FiguresResponse = await figRes.json();
    const figByQ = new Map(questionFigures.map((f) => [f.questionIndex, f]));
    const optByKey = new Map(optionImages.map((f) => [`${f.questionIndex}:${f.optionIndex}`, f]));

    // Copy so each option can be patched without mutating React state.
    const next = questions.map((q) => ({ ...q, options: q.options.map((o) => ({ ...o })) }));

    for (const { q, index } of pendingFigures) {
      const fig = figByQ.get(index);
      if (!fig) throw new Error(`Missing figure upload URL for question ${index + 1}`);
      const pageUrl = pageUrlByNumber.get(q.figurePage ?? q.sourcePage);
      if (!pageUrl) throw new Error(`Missing source page image for question ${index + 1}`);
      const blob = await cropToPngBlob(pageUrl, q.figureBbox!);
      await putBlob(fig.presignedUrl, "image/png", blob);
      next[index] = { ...next[index], figureStorageKey: fig.storageKey };
    }

    for (const { questionIndex, optionIndex } of pendingOptions) {
      const fig = optByKey.get(`${questionIndex}:${optionIndex}`);
      if (!fig) {
        throw new Error(`Missing image upload URL for question ${questionIndex + 1} option ${optionIndex + 1}`);
      }
      const q = questions[questionIndex];
      const o = q.options[optionIndex];
      const pageUrl = pageUrlByNumber.get(o.imagePage ?? q.figurePage ?? q.sourcePage);
      if (!pageUrl) {
        throw new Error(`Missing source page image for question ${questionIndex + 1} option ${optionIndex + 1}`);
      }
      const blob = await cropToPngBlob(pageUrl, o.imageBbox!);
      await putBlob(fig.presignedUrl, "image/png", blob);
      next[questionIndex].options[optionIndex] = {
        ...next[questionIndex].options[optionIndex],
        imageStorageKey: fig.storageKey,
      };
    }

    return next;
  }

  async function commit() {
    if (!extractionId) return;
    setError(null);
    setPhase("committing");
    try {
      const withFigures = await uploadFigureCrops();
      const res = await fetch(`${base}/${extractionId}/commit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questions: withFigures }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Commit failed");
      if (!mounted.current) return;
      onCommitted();
      // Reset the flow back to idle, then surface the summary on the idle screen.
      resetFlow();
      setSummary(data as ImportSummary);
    } catch (err) {
      if (!mounted.current) return;
      setError(err instanceof Error ? err.message : "Commit failed");
      setPhase("review");
    }
  }

  const incompleteCount = questions.filter((q) => !isQuestionComplete(q)).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><FileUp className="size-5" /> Import from PDF</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

        {phase === "idle" && (
          <>
            <p className="text-sm text-muted-foreground">
              Upload a quiz PDF (max {MAX_PAGES} pages). Pages are rendered in your browser and questions are extracted by AI for your review.
            </p>
            <div className="relative inline-block">
              <input
                type="file"
                accept=".pdf,application/pdf"
                aria-label="Upload quiz PDF"
                className="absolute inset-0 size-full cursor-pointer opacity-0"
                onChange={handleFile}
              />
              <Button asChild><span><FileUp className="size-4" /> Choose PDF</span></Button>
            </div>
            {summary && (
              <div className="space-y-1 rounded-md border p-3 text-sm">
                <p className="font-medium">PDF import complete</p>
                <p className="text-muted-foreground">
                  Imported {summary.importedCount}, skipped {summary.skippedCount}, errors {summary.errorCount}.
                </p>
                {summary.errors && summary.errors.length > 0 && (
                  <div className="space-y-1 text-destructive">
                    {summary.errors.slice(0, 5).map((e) => (
                      <p key={e.index}>Question {e.index + 1}: {e.message}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {phase === "uploading" && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin text-primary" /> {statusText}
          </div>
        )}

        {phase === "extracting" && (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <Loader2 className="size-5 animate-spin text-primary" /> Extracting questions…
            </div>
            <Button size="sm" variant="ghost" onClick={discard}><Trash2 className="size-4" /> Discard</Button>
          </div>
        )}

        {phase === "failed" && (
          <div className="space-y-3">
            <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              {detail?.status === "PENDING_UPLOAD"
                ? `The upload of "${detail.originalName}" never finished. Discard it and choose the PDF again.`
                : detail?.errorMessage || "Extraction failed."}
            </div>
            <div className="flex gap-2">
              {/* No Retry for a half-uploaded PDF — there is nothing to re-run. */}
              {detail?.status !== "PENDING_UPLOAD" && (
                <Button size="sm" onClick={retry}><RotateCw className="size-4" /> Retry</Button>
              )}
              <Button size="sm" variant="outline" onClick={discard}><Trash2 className="size-4" /> Discard</Button>
            </div>
          </div>
        )}

        {(phase === "review" || phase === "committing") && detail && (
          <div className="space-y-4">
            {formatAiMetrics({ model: detail.aiModel, ttftMs: detail.aiTtftMs, totalMs: detail.aiTotalMs, tokens: detail.aiTokens }) && (
              <p className="text-xs text-muted-foreground">
                Extracted by {formatAiMetrics({ model: detail.aiModel, ttftMs: detail.aiTtftMs, totalMs: detail.aiTotalMs, tokens: detail.aiTokens })}
              </p>
            )}
            <QuizPdfReview
              questions={questions}
              hasAnswerKey={detail.hasAnswerKey}
              warnings={detail.warnings}
              pageImages={detail.pageImages ?? []}
              onChangeQuestion={(i, next) => setQuestions((prev) => prev.map((q, idx) => (idx === i ? next : q)))}
              onRemoveQuestion={(i) => setQuestions((prev) => prev.filter((_, idx) => idx !== i))}
            />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={commit}
                disabled={phase === "committing" || questions.length === 0 || incompleteCount > 0}
              >
                {phase === "committing" ? (
                  <><Loader2 className="size-4 animate-spin" /> Committing…</>
                ) : incompleteCount > 0 ? (
                  `Commit (${incompleteCount} incomplete)`
                ) : (
                  `Commit ${questions.length} question${questions.length === 1 ? "" : "s"}`
                )}
              </Button>
              <Button variant="outline" onClick={discard} disabled={phase === "committing"}>
                <Trash2 className="size-4" /> Discard
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
