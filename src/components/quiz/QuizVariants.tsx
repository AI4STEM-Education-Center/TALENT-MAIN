"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { QuestionPreview, QuizVariantBatch } from "./QuizVariantBatch";
import {
  VariantPreviewModal,
  type StartRoundInput,
} from "./VariantPreviewModal";
import {
  isGenerating,
  matchesSource,
  type Act,
  type SourceQuestion,
  type Version,
} from "./quiz-variant-types";

async function request(url: string, method = "GET", body?: unknown) {
  const response = await fetch(url, {
    method,
    ...(body
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (!response.ok) {
    // A non-JSON error body (an expired session's login page, a proxy error)
    // still surfaces as a readable error instead of a parse failure.
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Could not update alternative versions.");
  }
  return response.json();
}

/** Load the quiz's versions, polling while any draft is still generating. */
function useVariantVersions(url: string) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setVersions((await request(url)).versions as Version[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load versions.");
    }
  }, [url]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const generating = !!versions?.some(isGenerating);
  useEffect(() => {
    if (!generating) return;
    const timer = setInterval(() => void refresh(), 4000);
    return () => clearInterval(timer);
  }, [generating, refresh]);
  return { versions, error, setError, refresh, generating };
}

export function QuizVariants({
  quizId,
  questions,
  quizHrefBase,
}: {
  quizId: string;
  questions: SourceQuestion[];
  /** Editor route prefix for linking saved standalone exams. */
  quizHrefBase: string;
}) {
  const url = `/api/quizzes/${quizId}/variants`;
  const { versions, error, setError, refresh, generating } =
    useVariantVersions(url);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const act: Act = async (body, method = "PATCH") => {
    setBusy(true);
    setError("");
    try {
      return await request(url, method, body);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update version.");
      return null;
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  // Close the popup as soon as the round is accepted; generation runs in the
  // background and the list refresh only has to catch up afterwards.
  async function startRound({
    mix,
    purpose,
    objectives,
    seedSamples,
  }: StartRoundInput) {
    setBusy(true);
    setError("");
    try {
      await request(url, "POST", {
        name: "Version",
        mix,
        purpose,
        objectives,
        ...(seedSamples?.numbersSample && seedSamples.contextSample
          ? { seedSamples }
          : {}),
      });
      setChoosing(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not start generating versions.",
      );
    } finally {
      setBusy(false);
    }
    await refresh();
  }
  const supported = supportsVariants(questions);
  const list = versions ?? [];
  const batches = groupBatches(list);
  // Versions arrive newest first: the first round with open drafts is live.
  const current = batches.find((b) => b.versions.some(isActive));
  const earlier = batches.filter(
    (b) => b !== current && b.versions.some(isActive),
  );
  return (
    <section
      className="space-y-5 rounded-xl border bg-card p-4"
      aria-label="Alternative exam versions"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">Alternative versions</h2>
          <p className="text-sm text-muted-foreground">
            Generate verified new versions of this exam, then save them as
            alternates of this exam or as standalone exams.
          </p>
        </div>
        <Button
          disabled={!supported || generating || busy || choosing}
          onClick={() => setChoosing(true)}
        >
          <Sparkles className="size-4" aria-hidden="true" /> Generate new
          version
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!supported && (
        <p role="status" className="text-sm text-muted-foreground">
          New versions support 1–40 text-only single-select or numeric
          questions.
        </p>
      )}
      <VariantPreviewModal
        open={choosing}
        onOpenChange={setChoosing}
        quizId={quizId}
        questions={questions}
        initialObjectives={list[0]?.objectives ?? []}
        busy={busy}
        onStart={startRound}
      />
      {current && (
        <CurrentRound
          batchId={current.id}
          batch={current.versions}
          questions={questions}
          act={act}
          busy={busy}
          quizId={quizId}
          quizHrefBase={quizHrefBase}
        />
      )}
      {earlier.length > 0 && (
        <EarlierRounds
          batches={earlier}
          questions={questions}
          act={act}
          busy={busy}
          quizId={quizId}
          quizHrefBase={quizHrefBase}
        />
      )}
      <SavedVersions
        versions={list.filter((v) =>
          ["PUBLISHED", "RETIRED", "STANDALONE"].includes(v.status),
        )}
        act={act}
        busy={busy}
        quizHrefBase={quizHrefBase}
      />
    </section>
  );
}

/** Drafts still waiting on generation or on the teacher. */
const isActive = (v: Version) =>
  isGenerating(v) || v.status === "REVIEW" || v.status === "FAILED";

/** Group batched versions by round, keeping the newest-first order. */
function groupBatches(versions: Version[]) {
  const byId = new Map<string, Version[]>();
  for (const v of versions) {
    if (!v.batchId) continue;
    const group = byId.get(v.batchId);
    if (group) group.push(v);
    else byId.set(v.batchId, [v]);
  }
  return [...byId].map(([id, batch]) => ({ id, versions: batch }));
}

function supportsVariants(questions: SourceQuestion[]) {
  return (
    questions.length > 0 &&
    questions.length <= 40 &&
    questions.every(
      (q) =>
        ["SINGLE_SELECT", "NUMERIC"].includes(q.answerMode) &&
        !q.figureUrl &&
        !q.options.some((o) => o.imageUrl),
    )
  );
}

type RoundProps = {
  questions: SourceQuestion[];
  act: Act;
  busy: boolean;
  quizId: string;
  quizHrefBase: string;
};

export function GenerationBanner({
  batch,
  batchId,
  reviewHref,
}: {
  batch: Version[];
  batchId: string | null;
  /** Direct review page for this round; omitted when already on it. */
  reviewHref?: string;
}) {
  const readyCount = batch.filter(
    (v) => !isGenerating(v) && v.status !== "FAILED",
  ).length;
  const progress = batch.filter(
    (v) => isGenerating(v) && (v.totalCount ?? 0) > 0,
  );
  return (
    <div
      role="status"
      className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
    >
      <p className="flex items-center gap-2 font-medium">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {readyCount} of {batch.length} versions verified
      </p>
      {progress.length > 0 && (
        <ul className="space-y-0.5 text-muted-foreground">
          {progress.map((v) => (
            <li key={v.id}>
              {v.name}: {v.completedCount ?? 0}/{v.totalCount} questions
            </li>
          ))}
        </ul>
      )}
      <p>
        Generating in the background. You can leave this page — we&apos;ll
        notify you with a direct approval link as soon as all versions finish.
      </p>
      {batchId && reviewHref && (
        <Link className="font-medium underline" href={reviewHref}>
          Open batch review link
        </Link>
      )}
    </div>
  );
}

function CurrentRound({
  batchId,
  batch,
  ...props
}: RoundProps & { batchId: string; batch: Version[] }) {
  const { questions, quizId, quizHrefBase } = props;
  const purpose = batch[0].purpose;
  const reviewHref = `${quizHrefBase}/${quizId}/versions/${batchId}`;
  return (
    <div className="space-y-3">
      {batch.some(isGenerating) ? (
        <GenerationBanner
          batch={batch}
          batchId={batchId}
          reviewHref={reviewHref}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 p-3">
          <p className="text-sm" role="status">
            {purpose === "STANDALONE"
              ? "Review the drafts. Save the ones you like as standalone exams, or as alternates of this exam."
              : "Review the drafts. Approve the ones you like as alternates of this exam, or save them as standalone exams."}
          </p>
          <Link className="text-sm underline" href={reviewHref}>
            Open review page
          </Link>
        </div>
      )}
      <QuizVariantBatch
        versions={batch}
        questions={questions}
        purpose={purpose}
        stale={!batch.every((v) => matchesSource(v, questions))}
        act={props.act}
        busy={props.busy}
        quizHrefBase={quizHrefBase}
      />
    </div>
  );
}

/** Older rounds that still hold open drafts, so none are forgotten. */
function EarlierRounds({
  batches,
  ...props
}: RoundProps & { batches: { id: string; versions: Version[] }[] }) {
  const { questions, quizId, quizHrefBase } = props;
  return (
    <section aria-labelledby="earlier-rounds" className="space-y-3">
      <h3 id="earlier-rounds" className="font-medium">
        Earlier rounds awaiting review
      </h3>
      {batches.map(({ id, versions: batch }) => {
        const open = batch.filter(isActive);
        const started = batch.at(-1)?.createdAt;
        return (
          <div key={id} className="space-y-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="flex flex-wrap items-center gap-2">
                <Badge variant="warning">
                  {open.length} draft{open.length === 1 ? "" : "s"} open
                </Badge>
                {started && (
                  <span className="text-muted-foreground">
                    Started{" "}
                    <time dateTime={started}>{started.slice(0, 10)}</time>
                  </span>
                )}
              </span>
              <Link
                className="font-medium underline"
                href={`${quizHrefBase}/${quizId}/versions/${id}`}
              >
                Open review page
              </Link>
            </div>
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Review {open.map((v) => v.name).join(", ")} here
              </summary>
              <div className="mt-3">
                <QuizVariantBatch
                  versions={batch}
                  questions={questions}
                  purpose={batch[0].purpose}
                  stale={!batch.every((v) => matchesSource(v, questions))}
                  act={props.act}
                  busy={props.busy}
                  quizHrefBase={quizHrefBase}
                />
              </div>
            </details>
          </div>
        );
      })}
    </section>
  );
}

function SavedVersions({
  versions,
  act,
  busy,
  quizHrefBase,
}: {
  versions: Version[];
  act: Act;
  busy: boolean;
  quizHrefBase: string;
}) {
  if (!versions.length) return null;
  return (
    <div className="space-y-2">
      <h3 className="font-medium">Saved versions</h3>
      <ul className="divide-y rounded-lg border">
        {versions.map((v) => (
          <li
            key={v.id}
            className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm"
          >
            <span className="flex items-center gap-2">
              {v.name}
              <Badge
                variant={
                  v.status === "RETIRED"
                    ? "outline"
                    : v.status === "STANDALONE"
                      ? "secondary"
                      : "success"
                }
              >
                {v.status === "PUBLISHED"
                  ? "Alternate · live for practice"
                  : v.status === "STANDALONE"
                    ? "Standalone exam"
                    : "Retired"}
              </Badge>
            </span>
            {v.status === "PUBLISHED" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void act({ versionId: v.id, action: "retire" })}
              >
                Retire
              </Button>
            )}
            {v.standaloneQuiz && (
              <Link
                className="underline"
                href={`${quizHrefBase}/${v.standaloneQuiz.id}`}
              >
                Open {v.standaloneQuiz.name}
              </Link>
            )}
            <details className="w-full">
              <summary className="cursor-pointer font-medium">
                Inspect {v.name}
              </summary>
              <div className="mt-3 divide-y rounded-lg border">
                {v.questions.map((question, index) => (
                  <div key={question.id}>
                    <h4 className="px-4 pt-4 font-medium">
                      Question {index + 1}
                    </h4>
                    <QuestionPreview
                      question={question}
                      check={
                        v.validation?.find(
                          (check) =>
                            check.sourceQuestionId ===
                            question.sourceQuestionId,
                        )?.explanation
                      }
                    />
                  </div>
                ))}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
