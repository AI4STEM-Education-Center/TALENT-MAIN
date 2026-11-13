"use client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { QuestionPreview } from "./QuizVariantBatch";
import {
  DEFAULT_OBJECTIVE,
  MIX_OPTIONS,
  type SampleResponse,
  type SeedSamples,
  type SourceQuestion,
  type VariantMix,
  type VerifiedSampleItem,
} from "./quiz-variant-types";

export type VariantPurpose = "ALTERNATE" | "STANDALONE";

export type StartRoundInput = {
  mix: VariantMix;
  purpose: VariantPurpose;
  objectives: { sourceQuestionId: string; objective: string }[];
  seedSamples?: SeedSamples;
};

const PURPOSES: {
  value: VariantPurpose;
  title: string;
  description: string;
}[] = [
  {
    value: "ALTERNATE",
    title: "Alternate version of this exam",
    description:
      "Parallel versions linked to this exam that students can practice.",
  },
  {
    value: "STANDALONE",
    title: "Standalone exam",
    description: "A separate exam you can edit, assign, and grade on its own.",
  },
];

/** A restriction is optional, but a typed one must say something useful. */
const isInvalidRestriction = (value: string) =>
  value.trim().length > 0 && value.trim().length < 10;

/**
 * Calibration popup for a new round: previews one representative question in
 * both change styles, then lets the teacher pick the mix and purpose before
 * the four versions generate in the background.
 */
export function VariantPreviewModal({
  open,
  onOpenChange,
  ...body
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & BodyProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Generate four new versions</DialogTitle>
          <DialogDescription>
            Preview how one question changes in each style, then choose the mix
            and what the new versions should be.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so every opening starts fresh. */}
        <PreviewBody {...body} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

type BodyProps = {
  quizId: string;
  questions: SourceQuestion[];
  /** Objectives from the last round, restored as restrictions. */
  initialObjectives: { sourceQuestionId: string; objective: string }[];
  busy: boolean;
  onStart: (input: StartRoundInput) => void | Promise<void>;
};

type SampleRequest = { questionId: string; objective: string; nonce: number };
type SampleState =
  | { nonce: number; kind: "ready"; sample: SampleResponse }
  | { nonce: number; kind: "unavailable" }
  | { nonce: number; kind: "error"; message: string };

function hasSamples(data: unknown): data is SampleResponse {
  if (!data || typeof data !== "object") return false;
  const { numbersSample, contextSample } = data as Partial<SampleResponse>;
  return !!numbersSample?.question && !!contextSample?.question;
}

function PreviewBody({
  quizId,
  questions,
  initialObjectives,
  busy,
  onStart,
  onCancel,
}: BodyProps & { onCancel: () => void }) {
  // Restore restrictions from the last round, skipping the default wording.
  const [restrictions, setRestrictions] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      initialObjectives
        .filter((o) => o.objective !== DEFAULT_OBJECTIVE)
        .map((o) => [o.sourceQuestionId, o.objective]),
    ),
  );
  const objectiveFor = (questionId: string) => {
    const value = restrictions[questionId]?.trim() ?? "";
    return value.length >= 10 ? value : DEFAULT_OBJECTIVE;
  };
  // A question with numbers shows the numeric style best.
  const [selectedId, setSelectedId] = useState(
    () => (questions.find((q) => /\d/.test(q.text)) ?? questions[0])?.id ?? "",
  );
  const [mix, setMix] = useState<VariantMix>("2-2");
  const [purpose, setPurpose] = useState<VariantPurpose>("ALTERNATE");
  // The sample is requested by events (open, switch, retry), not by typing a
  // restriction, so the objective is captured when the request is made.
  const [request, setRequest] = useState<SampleRequest>(() => ({
    questionId: selectedId,
    objective: objectiveFor(selectedId),
    nonce: 0,
  }));
  const [result, setResult] = useState<SampleState | null>(null);

  const loadSample = useCallback(
    async (req: SampleRequest, signal: AbortSignal) => {
      const { nonce } = req;
      try {
        const res = await fetch(`/api/quizzes/${quizId}/variants/sample`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            questionId: req.questionId,
            objective: req.objective,
          }),
          signal,
        });
        if (!res.ok) {
          const errData: unknown = await res.json().catch(() => null);
          if (signal.aborted) return;
          const message =
            errData && typeof errData === "object" && "error" in errData
              ? String((errData as { error: unknown }).error)
              : `Could not load a preview (HTTP ${res.status}).`;
          setResult({ nonce, kind: "error", message });
          return;
        }
        const data: unknown = await res.json().catch(() => null);
        if (signal.aborted) return;
        if (hasSamples(data)) {
          setResult({ nonce, kind: "ready", sample: data });
        } else {
          setResult({ nonce, kind: "unavailable" });
        }
      } catch (e) {
        if (signal.aborted) return;
        setResult({
          nonce,
          kind: "error",
          message: e instanceof Error ? e.message : "Could not load a preview.",
        });
      }
    },
    [quizId],
  );

  useEffect(() => {
    if (!request.questionId) return;
    const controller = new AbortController();
    void loadSample(request, controller.signal);
    return () => controller.abort();
  }, [loadSample, request]);

  const loading = !!request.questionId && result?.nonce !== request.nonce;
  const sample = !loading && result?.kind === "ready" ? result.sample : null;
  const requestSample = (questionId: string) =>
    setRequest((prev) => ({
      questionId,
      objective: objectiveFor(questionId),
      nonce: prev.nonce + 1,
    }));
  const selectQuestion = (questionId: string) => {
    setSelectedId(questionId);
    requestSample(questionId);
  };

  const selectedSource = questions.find((q) => q.id === selectedId);
  const invalid = Object.values(restrictions).some(isInvalidRestriction);
  const start = () =>
    void onStart({
      mix,
      purpose,
      objectives: questions.map((q) => ({
        sourceQuestionId: q.id,
        objective: restrictions[q.id]?.trim() || DEFAULT_OBJECTIVE,
      })),
      ...(sample && objectiveFor(sample.sourceQuestionId) === request.objective
        ? {
            seedSamples: {
              numbersSample: sample.numbersSample,
              contextSample: sample.contextSample,
            },
          }
        : {}),
    });

  return (
    <div className="space-y-6">
      <section aria-labelledby="calibration-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="calibration-heading" className="font-semibold">
            Calibration sample
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {questions.length > 1 && (
              <div
                role="group"
                aria-label="Representative question"
                className="flex flex-wrap gap-1"
              >
                {questions.map((q, index) => (
                  <Button
                    key={q.id}
                    type="button"
                    size="sm"
                    variant={q.id === selectedId ? "default" : "outline"}
                    aria-pressed={q.id === selectedId}
                    onClick={() => selectQuestion(q.id)}
                  >
                    Question {index + 1}
                  </Button>
                ))}
              </div>
            )}
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={loading || !selectedId}
              onClick={() => requestSample(selectedId)}
            >
              <RefreshCw className="size-4" aria-hidden="true" /> Try another
              sample
            </Button>
          </div>
        </div>
        <div className="grid gap-3 lg:grid-cols-3">
          <PreviewCard title="Original question">
            <QuestionPreview question={selectedSource} />
          </PreviewCard>
          <PreviewCard
            title="Style A · Limited Numerical"
            badge="Numbers & choices"
            explanation="Keeps stem structure & scenario; varies numbers and recomputes choices."
          >
            <SampleSlot
              item={sample?.numbersSample}
              loading={loading}
              failed={!loading && result?.kind === "error"}
            />
          </PreviewCard>
          <PreviewCard
            title="Style B · Full Question Rewrite"
            badge="Fresh scenario & choices"
            explanation="Rewrites scenario, stem phrasing, and all answer choices."
          >
            <SampleSlot
              item={sample?.contextSample}
              loading={loading}
              failed={!loading && result?.kind === "error"}
            />
          </PreviewCard>
        </div>
        {!loading && result?.kind === "error" && (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 text-sm text-destructive"
          >
            <span>{result.message}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => requestSample(selectedId)}
            >
              Retry preview
            </Button>
          </div>
        )}
        {!loading && result?.kind === "unavailable" && (
          <p role="status" className="text-sm text-muted-foreground">
            A preview isn&apos;t available right now. You can still choose the
            mix and purpose and start generating.
          </p>
        )}
      </section>

      <ChoiceGroup
        name="variant-mix"
        legend="Mix of change styles"
        value={mix}
        onChange={(value) => setMix(value as VariantMix)}
        options={MIX_OPTIONS.map((o) => ({
          value: o.value,
          title: o.title,
          description: o.subtitle,
        }))}
        columns="md:grid-cols-3"
      />

      <ChoiceGroup
        name="variant-purpose"
        legend="What should the new versions be?"
        value={purpose}
        onChange={(value) => setPurpose(value as VariantPurpose)}
        options={PURPOSES.map((p) => ({
          value: p.value,
          title: p.title,
          description: p.description,
        }))}
        columns="md:grid-cols-2"
      />

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
              aria-invalid={isInvalidRestriction(restrictions[q.id] ?? "")}
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

      <p className="rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
        When you start, this popup closes immediately and all 4 versions
        generate in the background on Flex pricing. We&apos;ll notify you by
        email and in-app with a direct link to approve once generation finishes.
      </p>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" disabled={busy || invalid} onClick={start}>
          {busy ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="size-4" aria-hidden="true" />
          )}
          Generate 4 versions in background
        </Button>
      </div>
    </div>
  );
}

function PreviewCard({
  title,
  badge,
  explanation,
  children,
}: {
  title: string;
  badge?: string;
  explanation?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="min-w-0 overflow-hidden rounded-xl border"
    >
      <header className="space-y-1 border-b bg-muted/40 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-sm font-semibold">{title}</h4>
          {badge && <Badge variant="secondary">{badge}</Badge>}
        </div>
        {explanation && (
          <p className="text-xs text-muted-foreground">{explanation}</p>
        )}
      </header>
      {children}
    </section>
  );
}

function SampleSlot({
  item,
  loading,
  failed,
}: {
  item?: VerifiedSampleItem;
  loading: boolean;
  failed: boolean;
}) {
  if (loading)
    return (
      <div role="status" className="space-y-3 p-4">
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          Generating a verified sample…
        </span>
        <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
        <div className="h-8 animate-pulse rounded bg-muted" />
        <div className="h-8 animate-pulse rounded bg-muted" />
      </div>
    );
  if (!item)
    return (
      <p className="p-4 text-sm text-muted-foreground">
        {failed ? "Preview unavailable." : "No sample to show."}
      </p>
    );
  return (
    <QuestionPreview question={item.question} check={item.check?.explanation} />
  );
}

function ChoiceGroup({
  name,
  legend,
  value,
  onChange,
  options,
  columns,
}: {
  name: string;
  legend: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; title: string; description: string }[];
  columns: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 font-semibold">{legend}</legend>
      <div role="radiogroup" className={cn("grid gap-3", columns)}>
        {options.map((option) => {
          const checked = option.value === value;
          return (
            <label
              key={option.value}
              className={cn(
                "flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors hover:border-primary focus-within:ring-2 focus-within:ring-ring",
                checked && "border-primary bg-primary/5",
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                className="mt-1 accent-primary"
              />
              <span className="space-y-1">
                <span className="block font-semibold">{option.title}</span>
                <span className="block text-sm text-muted-foreground">
                  {option.description}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
