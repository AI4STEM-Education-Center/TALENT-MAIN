"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { QuizVariantBatch } from "./QuizVariantBatch";
import {
  DEFAULT_OBJECTIVE,
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
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Could not update alternative versions.");
  return data;
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
  const [hiddenBatch, setHiddenBatch] = useState<string | null>(null);
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
  const supported = supportsVariants(questions);
  const list = versions ?? [];
  // Versions arrive newest first, so the first batched one is the live round.
  const batchId = list.find((v) => v.batchId)?.batchId ?? null;
  const batch = list.filter((v) => v.batchId && v.batchId === batchId);
  const showBatch = batch.length > 0 && batchId !== hiddenBatch;
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
      {choosing && (
        <GenerateChooser
          key={batchId ?? "none"}
          questions={questions}
          initial={list[0]?.objectives ?? []}
          busy={busy}
          onCancel={() => setChoosing(false)}
          onChoose={async (purpose, objectives) => {
            const started = await act(
              {
                name: "Version",
                variation: "NUMBERS",
                count: 2,
                bothModes: true,
                purpose,
                objectives,
              },
              "POST",
            );
            if (started) {
              setChoosing(false);
              setHiddenBatch(null);
            }
          }}
        />
      )}
      {showBatch && (
        <CurrentRound
          batch={batch}
          questions={questions}
          act={act}
          busy={busy}
          quizHrefBase={quizHrefBase}
          onHide={() => setHiddenBatch(batchId)}
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

function CurrentRound({
  batch,
  questions,
  act,
  busy,
  quizHrefBase,
  onHide,
}: {
  batch: Version[];
  questions: SourceQuestion[];
  act: Act;
  busy: boolean;
  quizHrefBase: string;
  onHide: () => void;
}) {
  const purpose = batch[0].purpose;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/50 p-3">
        <p className="text-sm" role="status">
          {batch.some(isGenerating)
            ? "Generating four versions. Each is solved independently and regenerated automatically until it passes verification."
            : purpose === "STANDALONE"
              ? "Review the drafts. Save the ones you like as standalone exams, or as alternates of this exam."
              : "Review the drafts. Approve the ones you like as alternates of this exam, or save them as standalone exams."}
        </p>
        <Button size="sm" variant="ghost" onClick={onHide}>
          Hide drafts
        </Button>
      </div>
      <QuizVariantBatch
        versions={batch}
        questions={questions}
        purpose={purpose}
        stale={!batch.every((v) => matchesSource(v, questions))}
        act={act}
        busy={busy}
        quizHrefBase={quizHrefBase}
      />
    </div>
  );
}

function GenerateChooser({
  questions,
  initial,
  busy,
  onChoose,
  onCancel,
}: {
  questions: SourceQuestion[];
  initial: { sourceQuestionId: string; objective: string }[];
  busy: boolean;
  onChoose: (
    purpose: "ALTERNATE" | "STANDALONE",
    objectives: { sourceQuestionId: string; objective: string }[],
  ) => void;
  onCancel: () => void;
}) {
  // Restore restrictions from the last round, skipping the default wording.
  const [restrictions, setRestrictions] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initial
        .filter((o) => o.objective !== DEFAULT_OBJECTIVE)
        .map((o) => [o.sourceQuestionId, o.objective]),
    ),
  );
  const invalid = Object.values(restrictions).some(
    (value) => value.trim().length > 0 && value.trim().length < 10,
  );
  const choose = (purpose: "ALTERNATE" | "STANDALONE") =>
    onChoose(
      purpose,
      questions.map((q) => ({
        sourceQuestionId: q.id,
        objective: restrictions[q.id]?.trim() || DEFAULT_OBJECTIVE,
      })),
    );
  const options = [
    {
      purpose: "ALTERNATE",
      title: "Alternate version of this exam",
      description:
        "Parallel versions linked to this exam that students can practice.",
    },
    {
      purpose: "STANDALONE",
      title: "Standalone exam",
      description:
        "A separate exam you can edit, assign, and grade on its own.",
    },
  ] as const;
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <p className="font-medium" id="variant-purpose">
        What should the new version be?
      </p>
      <div
        className="grid gap-3 md:grid-cols-2"
        role="group"
        aria-labelledby="variant-purpose"
      >
        {options.map((option) => (
          <button
            key={option.purpose}
            type="button"
            disabled={busy || invalid}
            onClick={() => choose(option.purpose)}
            className="space-y-1 rounded-lg border p-4 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-50"
          >
            <span className="block font-semibold">{option.title}</span>
            <span className="block text-sm text-muted-foreground">
              {option.description}
            </span>
          </button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        Four versions are generated: two that change numbers and choices, and
        two that also change the context. Only versions that pass independent
        verification are shown, and you can save either kind afterwards.
      </p>
      <details className="space-y-3">
        <summary className="cursor-pointer text-sm font-medium">
          Learning objectives & restrictions (optional)
        </summary>
        {questions.map((q, index) => (
          <label key={q.id} className="block space-y-1 text-sm">
            <span>Question {index + 1}</span>
            <Textarea
              rows={2}
              maxLength={2000}
              value={restrictions[q.id] ?? ""}
              onChange={(e) =>
                setRestrictions((prev) => ({ ...prev, [q.id]: e.target.value }))
              }
              placeholder="Keep the same skill and difficulty, or add restrictions such as whole-number answers only."
            />
          </label>
        ))}
        {invalid && (
          <p className="text-xs text-destructive">
            Restrictions need at least 10 characters.
          </p>
        )}
      </details>
      <Button variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
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
          </li>
        ))}
      </ul>
    </div>
  );
}
