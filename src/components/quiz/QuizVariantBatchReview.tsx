"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CheckCheck, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QuizVariantBatch } from "./QuizVariantBatch";
import { GenerationBanner } from "./QuizVariants";
import {
  isGenerating,
  matchesSource,
  type Act,
  type SourceQuestion,
  type Version,
} from "./quiz-variant-types";

type ReviewQuiz = { id: string; name: string; questions: SourceQuestion[] };

async function readError(res: Response, fallback: string) {
  if (res.redirected) return "Your session has expired. Please sign in again.";
  const data: unknown = await res.json().catch(() => null);
  return data && typeof data === "object" && "error" in data
    ? String((data as { error: unknown }).error)
    : `${fallback} (HTTP ${res.status}).`;
}

/** Load one round's versions, polling while any draft is still generating. */
function useBatchVersions(quizId: string, batchId: string) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(
          `/api/quizzes/${quizId}/variants?batchId=${encodeURIComponent(batchId)}`,
          { signal },
        );
        if (!res.ok || res.redirected) {
          const message = await readError(res, "Could not load versions");
          if (!signal?.aborted) setError(message);
          return;
        }
        const data = (await res.json()) as { versions?: Version[] };
        if (signal?.aborted) return;
        // Filter here too, in case the list endpoint ignores the parameter.
        setVersions((data.versions ?? []).filter((v) => v.batchId === batchId));
        setError("");
      } catch (e) {
        if (signal?.aborted) return;
        setError(e instanceof Error ? e.message : "Could not load versions.");
      }
    },
    [quizId, batchId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const generating = !!versions?.some(isGenerating);
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [generating, load]);
  const refresh = useCallback(() => void load(), [load]);
  return { versions, error, refresh };
}

function useQuiz(quizId: string) {
  const [quiz, setQuiz] = useState<ReviewQuiz | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(
    async (signal: AbortSignal) => {
      try {
        const res = await fetch(`/api/quizzes/${encodeURIComponent(quizId)}`, {
          signal,
        });
        if (!res.ok || res.redirected) {
          const message = await readError(res, "Could not load this quiz");
          if (!signal.aborted) setError(message);
          return;
        }
        const data = (await res.json()) as ReviewQuiz;
        if (!signal.aborted) setQuiz(data);
      } catch (e) {
        if (signal.aborted) return;
        setError(e instanceof Error ? e.message : "Could not load this quiz.");
      }
    },
    [quizId],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  return { quiz, error };
}

function useVariantAction(quizId: string, refresh: () => void) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const act: Act = async (body, method = "PATCH") => {
    setBusy(true);
    setActionError("");
    try {
      const res = await fetch(`/api/quizzes/${quizId}/variants`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setActionError(await readError(res, "Could not update version"));
        return null;
      }
      return ((await res.json().catch(() => ({}))) ?? {}) as Record<
        string,
        unknown
      >;
    } catch (e) {
      setActionError(
        e instanceof Error ? e.message : "Could not update version.",
      );
      return null;
    } finally {
      setBusy(false);
      refresh();
    }
  };
  return { busy, actionError, act };
}

function BatchApprovalBanner({
  reviewable,
  batchId,
  standaloneRound,
  busy,
  stale,
  act,
}: {
  reviewable: Version[];
  batchId: string;
  standaloneRound: boolean;
  busy: boolean;
  stale: boolean;
  act: Act;
}) {
  const count = reviewable.length;
  async function saveAllStandalone() {
    for (const v of reviewable) {
      const ok = await act({ versionId: v.id, action: "standalone" }, "PATCH");
      if (!ok) break;
    }
  }
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
      <p className="text-sm">
        {count} verified version{count === 1 ? "" : "s"} ready.{" "}
        {standaloneRound
          ? "Save them as standalone exams in one click, or review each question below."
          : "Approve them as alternates in one click, or review each question below."}
      </p>
      <div className="flex flex-wrap gap-2">
        {standaloneRound && (
          <Button disabled={busy} onClick={() => void saveAllStandalone()}>
            <CheckCheck className="size-4" aria-hidden="true" /> Save all ready
            versions as standalone exams
          </Button>
        )}
        <Button
          variant={standaloneRound ? "outline" : "default"}
          disabled={busy || stale}
          onClick={() =>
            void act({ action: "publish_batch", batchId }, "PATCH")
          }
        >
          <CheckCheck className="size-4" aria-hidden="true" /> Approve all ready
          versions as alternates
        </Button>
      </div>
    </div>
  );
}

/**
 * Direct review page for one generation round, opened from the "versions are
 * ready" email or notification: approve everything in one click, or inspect,
 * edit and revise individual drafts.
 */
export function QuizVariantBatchReview({
  quizId,
  batchId,
  quizHrefBase,
  backLabel = "Back to quiz editor",
}: {
  quizId: string;
  batchId: string;
  quizHrefBase: string;
  backLabel?: string;
}) {
  const { quiz, error: quizError } = useQuiz(quizId);
  const {
    versions,
    error: loadError,
    refresh,
  } = useBatchVersions(quizId, batchId);
  const { busy, actionError, act } = useVariantAction(quizId, refresh);

  const editorHref = `${quizHrefBase}/${quizId}`;
  const error = quizError || loadError || actionError;
  const list = versions ?? [];
  const reviewable = list.filter((v) => v.status === "REVIEW");
  const publishedCount = list.filter(
    (v) => v.status === "PUBLISHED" || v.status === "STANDALONE",
  ).length;
  const generatingCount = list.filter(isGenerating).length;
  const stale = !!quiz && !list.every((v) => matchesSource(v, quiz.questions));

  return (
    <div className="max-w-6xl space-y-6 p-4 md:p-6">
      <Button variant="ghost" size="sm" asChild>
        <Link href={editorHref}>
          <ArrowLeft className="size-4" aria-hidden="true" /> {backLabel}
        </Link>
      </Button>
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">
          {quiz ? `Review new versions of ${quiz.name}` : "Review new versions"}
        </h1>
        {versions && (
          <div className="flex flex-wrap gap-2" role="status">
            <Badge variant="warning">
              {reviewable.length} ready for approval
            </Badge>
            <Badge variant="success">{publishedCount} approved</Badge>
            {generatingCount > 0 && (
              <Badge variant="outline">{generatingCount} still running</Badge>
            )}
          </div>
        )}
      </header>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!quiz || !versions ? (
        !error && (
          <p
            role="status"
            className="flex items-center gap-2 text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            Loading…
          </p>
        )
      ) : list.length === 0 ? (
        <p className="text-muted-foreground">
          This round has no drafts left to review.{" "}
          <Link className="underline" href={editorHref}>
            Open the quiz editor
          </Link>
          .
        </p>
      ) : (
        <>
          {generatingCount > 0 && (
            <GenerationBanner batch={list} batchId={batchId} />
          )}
          {reviewable.length > 0 && (
            <BatchApprovalBanner
              reviewable={reviewable}
              batchId={batchId}
              standaloneRound={list[0]?.purpose === "STANDALONE"}
              busy={busy}
              stale={stale}
              act={act}
            />
          )}
          <QuizVariantBatch
            versions={list}
            questions={quiz.questions}
            purpose={list[0].purpose}
            stale={stale}
            act={act}
            busy={busy}
            quizHrefBase={quizHrefBase}
          />
        </>
      )}
    </div>
  );
}
